import { z } from "zod";

import type { compareStaticAndObservedEndpointsRequestSchema } from "../../contracts/javascript/applicationWorkflowInputContracts.js";
import { retainedEvidenceReferenceSchema } from "../../contracts/evidenceInputContracts.js";
import { WebNetworkApiSurfaceAccumulator } from "../../domain/analysisView/WebNetworkApiSurfaceAccumulator.js";
import { admitAnalysisViewData } from "../../domain/analysisView/analysisViewDataAdmission.js";
import { groupWebNetworkApiSurface } from "../../domain/analysisView/webNetworkApiSurfaceView.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisInputError,
  AnalysisProtocolError,
} from "../../domain/analysisErrorCore.js";
import { parseEvidence, type Evidence } from "../../domain/evidence.js";
import { EvidenceIntegrityError } from "../../domain/evidenceErrors.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { compareStaticAndObservedEndpoints } from "../../domain/javascript/javascriptEndpointTrafficComparison.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  resolveEvidenceInput,
  type EvidenceLookup,
} from "../EvidenceInputResolver.js";
import {
  applicationGraphEvidenceInputError,
  parseApplicationGraphEvidence,
  type ApplicationGraphEvidenceSource,
} from "./JavaScriptApplicationEvidenceGraph.js";
import { createEndpointTrafficComparisonEvidence } from "./JavaScriptApplicationWorkflowEvidence.js";

const OPERATION = "compare_static_and_observed_endpoints";

type Request = z.output<typeof compareStaticAndObservedEndpointsRequestSchema>;
type Side = "static" | "observed";

/** Comparison Evidence and the authenticated sources it links. */
export interface EndpointTrafficComparisonEvidence {
  readonly evidence: Evidence;
  readonly sources: readonly [Evidence, Evidence];
}

const inputError = (
  path: readonly (string | number)[],
  message: string,
): AnalysisInputError =>
  new AnalysisInputError(OPERATION, undefined, [
    { path: [...path], reason: "invalid_value", message },
  ]);

const projectedIssues = (side: Side, cause: z.ZodError, input: unknown) =>
  analysisInputErrorFromIssues(
    OPERATION,
    cause.issues.map((issue) => ({ ...issue, path: [side, ...issue.path] })),
    { [side]: input },
    { cause },
  );

/**
 * Inline static Evidence receives the same structural admission as inline
 * application Evidence in inspect_analysis_view: no accessors, proxies or
 * cycles, and bounded depth, checked before cloning or hashing. Like the other
 * application-graph workflows it has no byte budget: the api-surface
 * representation allowance (about 29 bytes per JSON byte) would refuse graphs
 * of a few MiB, and the CLI cannot pass a retained reference instead.
 */
const admitInlineStaticEvidence = (
  input: unknown,
): Result<void, AnalysisError> =>
  admitAnalysisViewData(input, true, undefined, {
    operation: OPERATION,
    path: ["static"],
  });

/** Resolve a reference, or admit borrowed inline Evidence before authenticating it. */
const resolveAdmittedEvidence = (
  side: Side,
  input: unknown,
  lookup: EvidenceLookup | undefined,
  admit: (value: unknown) => Result<void, AnalysisError>,
): Result<Evidence, AnalysisError> => {
  if (typeof input === "object" && input !== null && "kind" in input) {
    const reference = retainedEvidenceReferenceSchema.safeParse(input);
    if (!reference.success)
      return err(projectedIssues(side, reference.error, input));
    return resolveEvidenceInput(reference.data, lookup);
  }
  const admitted = admit(input);
  if (!admitted.ok) return admitted;
  try {
    return ok(parseEvidence(input));
  } catch (cause: unknown) {
    if (cause instanceof z.ZodError)
      return err(projectedIssues(side, cause, input));
    if (cause instanceof TypeError)
      return err(new EvidenceIntegrityError(cause.message));
    throw cause;
  }
};

/** Resolve and authenticate the static application graph parent. */
const resolveStaticApplication = (
  input: unknown,
  lookup: EvidenceLookup | undefined,
): Result<ApplicationGraphEvidenceSource, AnalysisError> => {
  const evidence = resolveAdmittedEvidence(
    "static",
    input,
    lookup,
    admitInlineStaticEvidence,
  );
  if (!evidence.ok) return evidence;
  if (evidence.value.operation !== "analyze_javascript_application")
    return err(
      inputError(
        ["static", "operation"],
        "Expected analyze_javascript_application Evidence.",
      ),
    );
  const application = parseApplicationGraphEvidence(evidence.value, ["static"]);
  return application.ok
    ? application
    : err(applicationGraphEvidenceInputError(OPERATION, application.error));
};

/**
 * Pair static `analyze_javascript_application` network endpoints with the
 * api-surface grouping of one HAR `inspect_web_network_capture` parent. Reads
 * no files and contacts no recorded URL.
 */
export const compareStaticAndObservedEndpointsEvidenceValidated = (
  input: Request,
  lookup?: EvidenceLookup,
): Result<EndpointTrafficComparisonEvidence, AnalysisError> => {
  const application = resolveStaticApplication(input.static, lookup);
  if (!application.ok) return application;
  const accumulator = new WebNetworkApiSurfaceAccumulator({
    owner: {
      operation: OPERATION,
      inlinePath: ["observed"],
      capturePath: ["observed", "normalized_result"],
    },
  });
  const observed = resolveAdmittedEvidence(
    "observed",
    input.observed,
    lookup,
    (value) => accumulator.admitInlineEvidence(value),
  );
  if (!observed.ok) return observed;
  if (observed.value.operation !== "inspect_web_network_capture")
    return err(
      inputError(
        ["observed", "operation"],
        "Expected inspect_web_network_capture Evidence.",
      ),
    );
  const capture = groupWebNetworkApiSurface(
    {
      evidenceId: observed.value.evidence_id,
      normalizedResult: observed.value.normalized_result,
      limitations: observed.value.limitations,
      parameters: observed.value.parameters,
    },
    accumulator,
  );
  if (!capture.ok) return capture;
  try {
    const grouped = accumulator.all();
    const source = application.value;
    const comparison = compareStaticAndObservedEndpoints({
      static: {
        evidenceId: source.evidence.evidence_id,
        rootArtifactSha256: source.rootArtifactSha256,
        graph: source.graph,
      },
      observed: {
        evidenceId: observed.value.evidence_id,
        artifact: {
          path: capture.value.artifact.path,
          sha256: capture.value.artifact.sha256,
        },
        groups: grouped.groups,
        records: {
          examined: capture.value.records.length,
          total: capture.value.total_records,
          excluded: grouped.excluded_records.length,
        },
        limitations: grouped.limitations,
      },
      origins: input.origins,
      collection: input.collection,
      offset: input.offset,
      limit: input.limit,
    });
    return ok({
      evidence: createEndpointTrafficComparisonEvidence(
        {
          static_evidence_id: source.evidence.evidence_id,
          observed_evidence_id: observed.value.evidence_id,
          origins: [...input.origins],
          collection: input.collection,
          offset: input.offset,
          limit: input.limit,
        },
        comparison,
      ),
      sources: [source.evidence, observed.value],
    });
  } catch (cause: unknown) {
    return err(
      new AnalysisProtocolError(
        `JavaScript application workflow failed while producing ${OPERATION}`,
        { cause },
      ),
    );
  }
};
