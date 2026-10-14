import type { ToolResultDelivery } from "../toolResult.js";
import { APPLICATION_TOOL_CONTRACTS } from "../../contracts/applicationToolContracts.js";
import type { Evidence } from "../../domain/evidence.js";
import type { ApplicationToolRegistration } from "./types.js";

type UnknownKind =
  | "application-version-comparison"
  | "javascript-export-shape"
  | "source-to-bundle-comparison"
  | "static-observed-endpoint-comparison";

export const recordResult = (
  options: ApplicationToolRegistration & {
    readonly delivery: ToolResultDelivery;
  },
  contract: (typeof APPLICATION_TOOL_CONTRACTS)[number],
  evidence: Evidence,
  unknownKind?: UnknownKind,
) => {
  const recorded =
    unknownKind === undefined
      ? options.recordEvidence?.(evidence)
      : options.recordEvidenceWithUnknown?.(
          evidence,
          unknownRegistration(evidence, unknownKind),
        );
  return options.delivery.toEvidenceToolResult(evidence, contract, recorded);
};

const reanalyzeProbe = {
  operation: "analyze_javascript_application",
  rationale:
    "Repeat static reconstruction with complete artifacts and source maps when available.",
};

const unknownQuestions: Readonly<Record<UnknownKind, string>> = {
  "application-version-comparison":
    "Which application entities remain unmatched or ambiguous across these versions?",
  "source-to-bundle-comparison":
    "Which historical source files remain unmatched or ambiguously mapped to the shipped bundle?",
  "javascript-export-shape":
    "Which selected JavaScript export return shapes remain dynamic, incomplete, or ambiguously paired?",
  "static-observed-endpoint-comparison":
    "Which static network endpoints remain unknown or ambiguous against this captured traffic?",
};

const unknownProbes = (kind: UnknownKind) =>
  kind === "application-version-comparison"
    ? [
        reanalyzeProbe,
        {
          operation: "reconcile_javascript_runtime",
          rationale:
            "Add passive runtime Evidence without promoting it to static fact.",
        },
      ]
    : kind === "static-observed-endpoint-comparison"
      ? [
          {
            operation: "inspect_web_network_capture",
            rationale:
              "Inspect a complete HAR recorded while exercising the remaining scenarios and origins.",
          },
        ]
      : [reanalyzeProbe];

const unknownRegistration = (evidence: Evidence, kind: UnknownKind) => ({
  // Scope unknown identity to the comparison while keeping exact replays stable.
  question: `${unknownQuestions[kind]} (comparison ${evidence.evidence_id})`,
  severity: "medium" as const,
  domain: kind,
  supporting_evidence_ids: [evidence.evidence_id],
  contradicting_evidence_ids: [],
  required_authority:
    kind === "static-observed-endpoint-comparison"
      ? ("historical-reference" as const)
      : ("shipped-artifact" as const),
  required_confidence: "observed" as const,
  required_environment: null,
  recommended_probes: unknownProbes(kind),
  relationships: [],
});
