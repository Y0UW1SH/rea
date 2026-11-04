import { z } from "zod";
import { browserScenarioSchema } from "./browserScenario.js";
import { browserOriginSchema } from "./browserObservation.js";
import {
  scenarioIdentifierSchema,
  browserScenarioUrlSchema,
} from "./browserScenarioValues.js";
import { absoluteLocalPathStringSchema } from "./localPath.js";
import { jsonValueSchema } from "./jsonValue.js";
import { digestCanonicalValue } from "./canonicalDigest.js";
import type { BrowserScenario } from "./browserScenario.js";

const pointer = z.string().regex(/^(?:\/(?:[^~]|~[01])*)*$/u);
const assertion = z.strictObject({ pointer, equals: jsonValueSchema });

/** A new browser capture of one exact GET response, with explicit context guards. */
export const saasProbeSchema = z.strictObject({
  scenario: browserScenarioSchema,
  response_url: browserScenarioUrlSchema.shape.url,
  actor_pointer: pointer,
  workspace_pointer: pointer,
  assertions: z.array(assertion).min(1),
});
export type SaasProbe = z.infer<typeof saasProbeSchema>;

const experimentSchema = z.strictObject({
  id: scenarioIdentifierSchema,
  description: z.string().min(1),
  mutates: z.boolean(),
  before: saasProbeSchema,
  action: browserScenarioSchema,
  after: saasProbeSchema,
  outcome_pointer: pointer,
  predictions: z
    .array(
      z.strictObject({
        hypothesis_id: scenarioIdentifierSchema,
        value: jsonValueSchema,
      }),
    )
    .min(2),
});
export type SaasExperiment = z.infer<typeof experimentSchema>;

const boundedCount = z.number().int().positive().safe();
const sessionIdentity = (scenario: BrowserScenario) =>
  digestCanonicalValue({
    browser: scenario.browser,
    storage: scenario.storage,
    secrets: scenario.secrets,
    environment: scenario.environment,
  });

export const saasInvestigationFailureSchema = z.strictObject({
  actions_reserved: z.number().int().nonnegative().safe(),
  diagnostic: jsonValueSchema,
});

export const saasInvestigationPlanSchema = z
  .strictObject({
    version: z.literal(1),
    investigation_id: scenarioIdentifierSchema,
    question: z.string().min(1),
    study: z.strictObject({
      study_id: scenarioIdentifierSchema,
      scenario_id: scenarioIdentifierSchema,
    }),
    actor_id: z.string().min(1),
    workspace_id: z.string().min(1),
    allowed_origins: z.array(browserOriginSchema).min(1),
    allow_mutations: z.boolean(),
    limits: z.strictObject({
      max_experiments: boundedCount,
      max_actions: boundedCount,
      // AbortSignal.timeout and browser deadlines use the Node timer range.
      max_run_ms: boundedCount.max(2_147_483_647),
      max_journal_bytes: boundedCount,
    }),
    hypotheses: z
      .array(
        z.strictObject({
          id: scenarioIdentifierSchema,
          description: z.string().min(1),
        }),
      )
      .min(2),
    experiments: z.array(experimentSchema).min(1),
  })
  .superRefine((plan, context) => {
    const issue = (path: PropertyKey[], message: string) =>
      context.addIssue({ code: "custom", path, message });
    const ids = plan.hypotheses.map(({ id }) => id);
    if (new Set(ids).size !== ids.length)
      issue(["hypotheses"], "Hypothesis IDs must be unique");
    if (
      new Set(plan.experiments.map(({ id }) => id)).size !==
      plan.experiments.length
    )
      issue(["experiments"], "Experiment IDs must be unique");
    const allowed = new Set(plan.allowed_origins);
    const checkUrl = (url: string, path: PropertyKey[]) => {
      if (!allowed.has(new URL(url).origin))
        issue(
          path,
          "Explicit navigation and storage must belong to an allowed origin",
        );
    };
    for (const [index, experiment] of plan.experiments.entries()) {
      const path = ["experiments", index];
      if (experiment.mutates && !plan.allow_mutations)
        issue(
          [...path, "mutates"],
          "Mutating experiments require explicit allow_mutations",
        );
      const predicted = experiment.predictions.map(
        ({ hypothesis_id: id }) => id,
      );
      if (
        new Set(predicted).size !== ids.length ||
        predicted.length !== ids.length ||
        predicted.some((id) => !ids.includes(id))
      )
        issue(
          [...path, "predictions"],
          "Each hypothesis requires exactly one prediction",
        );
      for (const phase of ["before", "action", "after"] as const) {
        const scenario =
          phase === "action" ? experiment.action : experiment[phase].scenario;
        const selected = [...path, phase];
        if (
          sessionIdentity(scenario) !==
          sessionIdentity(experiment.before.scenario)
        )
          issue(
            selected,
            "Before, action and after must use identical browser, storage, secrets and environment configuration",
          );
        checkUrl(scenario.start_url.url, selected);
        for (const action of scenario.actions) {
          if (action.action === "goto")
            checkUrl(action.destination.url, selected);
          if (
            (phase !== "action" || !experiment.mutates) &&
            !["goto", "wait_for", "wait_for_timeout"].includes(action.action)
          )
            issue(
              selected,
              "Probes and experiments declared non-mutating permit navigation and waits only",
            );
        }
        for (const cookie of scenario.storage.cookies)
          checkUrl(cookie.destination.url, selected);
        for (const storage of [
          ...scenario.storage.local_storage,
          ...scenario.storage.session_storage,
        ])
          checkUrl(storage.origin, selected);
        if (phase !== "action") {
          checkUrl(experiment[phase].response_url, selected);
          if (!scenario.capture.network.response_body)
            issue(selected, "Probes require captured network response bodies");
        }
      }
    }
  });
export type SaasInvestigationPlan = z.infer<typeof saasInvestigationPlanSchema>;

/** Identical installed CLI/MCP request; existing journals resume the exact same plan. */
export const saasInvestigationRequestSchema = z.strictObject({
  plan: saasInvestigationPlanSchema,
  journal_path: absoluteLocalPathStringSchema,
});
export const saasInvestigationReportSchema = z.strictObject({
  investigation_id: z.string(),
  plan_sha256: z.string(),
  journal_path: z.string(),
  status: z.enum(["distinguished", "contradicted", "exhausted", "paused"]),
  reason: z.string(),
  surviving_hypotheses: z.array(z.string()),
  actions_reserved: z.number().int().nonnegative(),
  attempts: z.array(
    z.strictObject({
      experiment_id: z.string(),
      status: z.enum(["pending", "completed"]),
      recovered: z.boolean(),
      evidence_ids: z.array(z.string()),
      outcome: jsonValueSchema.optional(),
    }),
  ),
  evidence_ids: z.array(z.string()),
  failures: z.array(saasInvestigationFailureSchema),
  limitations: z.array(z.string()),
});
export type SaasInvestigationReport = z.infer<
  typeof saasInvestigationReportSchema
>;
