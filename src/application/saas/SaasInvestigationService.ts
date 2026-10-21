import type { BrowserScenarioCapturePort } from "../BrowserScenarioCapturePort.js";
import { captureBrowserScenario } from "../BrowserScenarioCaptureService.js";
import { createBrowserScenarioEvidence } from "../BrowserScenarioEvidence.js";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { EvidenceWriter } from "../investigation/InvestigationRecordPort.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import {
  artifactFilePrimaryFailure,
  bindArtifactFileCleanup,
} from "../../artifacts/ArtifactFileOperation.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../../domain/analysisErrorCleanup.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
} from "../../domain/analysisErrorCore.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import {
  EvidenceFileError,
  EvidenceIntegrityError,
} from "../../domain/evidenceErrors.js";
import {
  createEvidence,
  evidenceSchema,
  type Evidence,
} from "../../domain/evidence.js";
import type { BrowserScenario } from "../../domain/browserScenario.js";
import { browserScenarioCaptureSchema } from "../../domain/browserScenarioCapture.js";
import { jsonValueSchema, type JsonValue } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  saasInvestigationRequestSchema,
  type SaasExperiment,
  type SaasInvestigationReport,
} from "../../domain/saasInvestigation.js";
import {
  evaluateSaasProbe,
  saasObservationAtPointer,
  selectSaasExperiment,
  survivingSaasHypotheses,
} from "../../domain/saasInvestigationEvaluation.js";
import {
  SaasInvestigationJournal,
  type SaasAttempt,
} from "./SaasInvestigationJournal.js";

const OPERATION = "run_saas_investigation";
const LIMITATIONS = [
  "Hypotheses and experiments are caller supplied. A distinguished hypothesis is supported only among this set in the observed actor/workspace and initial conditions.",
  "Actor/workspace guards are application observations, not independent authentication or transaction isolation. Completion assertions must identify this experiment's unique saved result.",
  "Allowed origins constrain explicit navigation and storage, not all requests made by page code. Probe navigation can itself have server effects.",
  "Each readback is a separate browser capture. Browser caches, service behavior and Playwright response-body provenance limit what the captured bytes establish.",
  "No tenant reset, vendor equivalence, selector discovery, or arbitrary AI-generated execution is provided.",
];

interface RunOptions extends ExecutionOptions {
  readonly recordEvidence?: EvidenceWriter["recordEvidence"];
  readonly resources?: ArtifactResourceScope;
}

/** Run or resume a bounded, evidence-driven loop through the shared browser owner. */
export const runSaasInvestigation = async (
  provider: BrowserScenarioCapturePort | undefined,
  input: unknown,
  options: RunOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  // Own the request before the first await; callers cannot change later actions.
  const parsed = saasInvestigationRequestSchema.safeParse(input);
  if (!parsed.success)
    return err(
      analysisInputErrorFromIssues(OPERATION, parsed.error.issues, input),
    );
  if (options.signal?.aborted)
    return err(new AnalysisCancelledError(OPERATION));
  if (provider === undefined)
    return err(
      new AnalysisCapabilityUnavailableError(
        "rea-playwright-browser-scenario",
        OPERATION,
        "Browser scenario provider is not configured",
      ),
    );
  const resources = options.resources ?? new ArtifactResourceScope();
  const signal = AbortSignal.any([
    AbortSignal.timeout(parsed.data.plan.limits.max_run_ms),
    ...(options.signal === undefined ? [] : [options.signal]),
  ]);
  let journal: SaasInvestigationJournal | undefined;
  let result: Result<Evidence, AnalysisError>;
  try {
    journal = await SaasInvestigationJournal.open(
      parsed.data.journal_path,
      parsed.data.plan,
      resources,
    );
    await journal.initialize();
    result = ok(
      await new InvestigationRun(
        provider,
        journal,
        signal,
        options.recordEvidence,
      ).run(),
    );
  } catch (cause) {
    result = err(journalFailure(cause, parsed.data.journal_path));
  }
  let cleanup: AnalysisError | undefined;
  try {
    await journal?.close();
  } catch (cause) {
    cleanup = journalFailure(cause, parsed.data.journal_path);
  }
  // An initial close failure must not skip the scope's retained-owner retry.
  if (options.resources === undefined) {
    try {
      await resources.close();
      cleanup = undefined;
    } catch (cause) {
      cleanup = journalFailure(cause, parsed.data.journal_path);
    }
  }
  if (cleanup !== undefined) {
    if (result.ok) return err(cleanup.retainPartialObservation(result.value));
    return err(composeCleanup(result.error, cleanup));
  }
  return result;
};

const composeCleanup = (
  primary: AnalysisError,
  cleanup: AnalysisError,
): AnalysisError =>
  analysisErrorWithCleanupFailure(
    primary,
    cleanup,
    OPERATION,
  ).bindCleanupDependencies([primary, cleanup]);

/** Keep typed primaries, partial observations and exact retry leases at this boundary. */
const journalFailure = (cause: unknown, path: string): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  const physical = artifactFilePrimaryFailure(cause);
  const failure = new EvidenceFileError("write", "io", {
    path,
    cause,
    ...(cause instanceof ArtifactReaderFailure
      ? {
          cleanup: cause.cleanup,
          partialObservation: cause.partialObservation,
        }
      : {}),
  });
  bindArtifactFileCleanup(cause, failure);
  return physical instanceof AnalysisError
    ? composeCleanup(physical, failure)
    : failure;
};

class InvestigationRun {
  #reason = "";
  constructor(
    private readonly provider: BrowserScenarioCapturePort,
    private readonly journal: SaasInvestigationJournal,
    private readonly signal: AbortSignal,
    private readonly recordEvidence:
      | EvidenceWriter["recordEvidence"]
      | undefined,
  ) {}

  async run(): Promise<Evidence> {
    await this.journal.save();
    let survivors = this.journal.plan.hypotheses.map(({ id }) => id);
    for (const attempt of this.journal.attempts) {
      const experiment = this.#experiment(attempt);
      const before = this.journal.records.evidenceById(
        attempt.before_evidence_id,
      )!;
      if (
        evaluateSaasProbe(
          before,
          experiment.before,
          this.journal.plan.actor_id,
          this.journal.plan.workspace_id,
        ).status !== "observed"
      )
        throw new EvidenceIntegrityError(
          "Journal initial-state evidence does not establish this experiment's guards",
        );
      if (attempt.after_evidence_id === null) {
        attempt.recovered = true;
        if (!(await this.#readback(experiment, attempt)))
          return this.#report("paused", survivors);
      }
      survivors = survivingSaasHypotheses(
        experiment,
        survivors,
        this.#outcome(experiment, attempt),
      );
    }
    while (survivors.length > 1) {
      if (this.signal.aborted) {
        this.#reason = "Investigation cancelled or invocation deadline reached";
        return this.#report("paused", survivors);
      }
      const experiment = selectSaasExperiment(
        this.journal.plan,
        survivors,
        this.journal.attempts.map(({ experiment_id: id }) => id),
      );
      if (experiment === undefined) {
        this.#reason =
          "No untried experiment distinguishes the surviving hypotheses";
        return this.#report("exhausted", survivors);
      }
      const cost = [
        experiment.before.scenario,
        experiment.action,
        experiment.after.scenario,
      ].reduce((sum, scenario) => sum + scenario.actions.length + 1, 0);
      if (
        this.journal.attempts.length >=
          this.journal.plan.limits.max_experiments ||
        this.journal.actionsReserved + cost >
          this.journal.plan.limits.max_actions
      ) {
        this.#reason = "Cumulative experiment or action budget reached";
        return this.#report("paused", survivors);
      }
      const before = await this.#capture(experiment.before.scenario);
      if (before === undefined) return this.#report("paused", survivors);
      const observed = evaluateSaasProbe(
        before,
        experiment.before,
        this.journal.plan.actor_id,
        this.journal.plan.workspace_id,
      );
      if (observed.status === "unknown") {
        this.#reason = observed.reason;
        return this.#report("paused", survivors);
      }
      const attempt: SaasAttempt = {
        experiment_id: experiment.id,
        before_evidence_id: before.evidence_id,
        action_evidence_id: null,
        after_evidence_id: null,
        recovered: false,
      };
      this.journal.attempts.push(attempt);
      // Intent reaches disk before any action can reach the target.
      await this.journal.save();
      const action = await this.#capture(experiment.action);
      if (action === undefined) return this.#report("paused", survivors);
      attempt.action_evidence_id = action.evidence_id;
      await this.journal.save();
      if (!(await this.#readback(experiment, attempt)))
        return this.#report("paused", survivors);
      survivors = survivingSaasHypotheses(
        experiment,
        survivors,
        this.#outcome(experiment, attempt),
      );
    }
    this.#reason =
      survivors.length === 0
        ? "Observed result contradicts every supplied hypothesis"
        : "One supplied hypothesis remains consistent with these experiments";
    return this.#report(
      survivors.length === 0 ? "contradicted" : "distinguished",
      survivors,
    );
  }

  #experiment(attempt: SaasAttempt): SaasExperiment {
    return this.journal.plan.experiments.find(
      ({ id }) => id === attempt.experiment_id,
    )!;
  }

  async #capture(scenario: BrowserScenario): Promise<Evidence | undefined> {
    if (this.signal.aborted) {
      this.#reason = "Investigation cancelled or invocation deadline reached";
      return undefined;
    }
    const cost = scenario.actions.length + 1;
    if (
      this.journal.actionsReserved + cost >
      this.journal.plan.limits.max_actions
    ) {
      this.#reason =
        "Cumulative action budget reached; pending actions will not be repeated";
      return undefined;
    }
    this.journal.actionsReserved += cost;
    await this.journal.save();
    if (this.signal.aborted) {
      this.#reason = "Investigation cancelled or invocation deadline reached";
      return undefined;
    }
    const result = await captureBrowserScenario(this.provider, scenario, {
      signal: this.signal,
    });
    if (!result.ok) {
      const diagnostic = projectAnalysisError(result.error);
      this.journal.failures.push({
        actions_reserved: this.journal.actionsReserved,
        diagnostic: jsonValueSchema.parse(diagnostic),
      });
      await this.journal.save();
      const partial = result.error.partialObservation;
      const evidence = evidenceSchema.safeParse(partial);
      if (evidence.success) await this.#retain(evidence.data);
      else if (
        partial !== undefined &&
        "kind" in partial &&
        partial.kind === "browser-scenario-observation"
      ) {
        const capture = browserScenarioCaptureSchema.safeParse(partial.capture);
        if (capture.success)
          await this.#retain(
            createBrowserScenarioEvidence(
              scenario,
              capture.data,
              this.provider.identity(),
            ),
          );
      }
      this.#reason = `Browser capture failed (${diagnostic.code}): ${diagnostic.message}. Any pending action requires readback before further experiments`;
      return undefined;
    }
    await this.#retain(result.value);
    const captured = browserScenarioCaptureSchema.parse(
      result.value.normalized_result,
    );
    if (
      captured.steps.some(({ status }) => status !== "completed") ||
      captured.steps.length !== scenario.actions.length + 1
    ) {
      this.#reason = "Browser action accounting is incomplete";
      return undefined;
    }
    return result.value;
  }

  async #retain(evidence: Evidence): Promise<void> {
    const retained = this.journal.records.recordEvidence(evidence);
    if (!retained.ok) throw retained.error;
    await this.journal.save();
  }

  async #readback(
    experiment: SaasExperiment,
    attempt: SaasAttempt,
  ): Promise<boolean> {
    const evidence = await this.#capture(experiment.after.scenario);
    if (evidence === undefined) return false;
    const observed = evaluateSaasProbe(
      evidence,
      experiment.after,
      this.journal.plan.actor_id,
      this.journal.plan.workspace_id,
    );
    if (
      observed.status === "unknown" ||
      saasObservationAtPointer(
        observed.document,
        experiment.outcome_pointer,
      ) === undefined
    ) {
      this.#reason =
        observed.status === "unknown"
          ? observed.reason
          : "Saved-state readback did not contain the outcome";
      return false;
    }
    attempt.after_evidence_id = evidence.evidence_id;
    await this.journal.save();
    return true;
  }

  #outcome(experiment: SaasExperiment, attempt: SaasAttempt): JsonValue {
    const evidence = this.journal.records.evidenceById(
      attempt.after_evidence_id!,
    )!;
    const result = evaluateSaasProbe(
      evidence,
      experiment.after,
      this.journal.plan.actor_id,
      this.journal.plan.workspace_id,
    );
    const value =
      result.status === "observed"
        ? saasObservationAtPointer(result.document, experiment.outcome_pointer)
        : undefined;
    if (value === undefined)
      throw new EvidenceIntegrityError(
        "Journal readback does not establish a complete attributed outcome",
      );
    return value;
  }

  #report(
    status: SaasInvestigationReport["status"],
    survivors: string[],
  ): Evidence {
    const records = this.journal.records.exportEvidenceBundle().records;
    for (const evidence of records) {
      const retained = this.recordEvidence?.(evidence);
      if (retained !== undefined && !retained.ok) throw retained.error;
    }
    const report: SaasInvestigationReport = {
      investigation_id: this.journal.plan.investigation_id,
      plan_sha256: this.journal.planDigest,
      journal_path: this.journal.path,
      status,
      reason: this.#reason,
      surviving_hypotheses: survivors,
      actions_reserved: this.journal.actionsReserved,
      attempts: this.journal.attempts.map((attempt) => ({
        experiment_id: attempt.experiment_id,
        status: attempt.after_evidence_id === null ? "pending" : "completed",
        recovered: attempt.recovered,
        evidence_ids: [
          attempt.before_evidence_id,
          attempt.action_evidence_id,
          attempt.after_evidence_id,
        ].filter((id): id is string => id !== null),
        ...(attempt.after_evidence_id === null
          ? {}
          : { outcome: this.#outcome(this.#experiment(attempt), attempt) }),
      })),
      evidence_ids: records.map(({ evidence_id: id }) => id),
      failures: this.journal.failures,
      limitations: [
        ...new Set([
          ...LIMITATIONS,
          ...records.flatMap((record) => record.limitations),
        ]),
      ],
    };
    return createEvidence(
      undefined,
      {
        id: "rea-saas-investigation",
        name: "REA live SaaS investigation",
        version: "1",
      },
      {
        predicateType: "rea.saas-investigation",
        operation: OPERATION,
        parameters: {
          plan_sha256: this.journal.planDigest,
          investigation_id: this.journal.plan.investigation_id,
          ...this.journal.plan.study,
          actor_id: this.journal.plan.actor_id,
          workspace_id: this.journal.plan.workspace_id,
        },
        result: jsonValueSchema.parse(report),
        confidence: "inferred",
        authority: "analyst-inference",
        evidenceLinks: report.evidence_ids,
        limitations: report.limitations,
      },
    );
  }
}
