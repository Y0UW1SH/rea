import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";
import { evidenceResultOf } from "./toolOutputSchemaPrimitives.js";
import {
  saasInvestigationRequestSchema,
  saasInvestigationReportSchema,
} from "../domain/saasInvestigation.js";

export const SAAS_INVESTIGATION_TOOL_CONTRACTS = [
  {
    name: "run_saas_investigation",
    ...toolContractMetadata("run_saas_investigation"),
    description:
      "Execute or resume a live SaaS investigation from an explicit version-1 plan and absolute journal_path. The plan supplies hypotheses, predictions and browser before/action/after scenarios. REA chooses distinguishing experiments, verifies observed actor/workspace and state assertions, captures separate saved-state readbacks, retains Evidence and updates surviving hypotheses. Mutations need allow_mutations. Limits bound cumulative experiments/actions, journal bytes and each invocation's duration. An interrupted action is never repeated; resume attempts only its readback. Keep the same plan and journal to resume. Origins constrain explicit navigation, not every request made by page code. Pages and probes can have side effects. Distinguished means one supplied hypothesis remains; it does not establish vendor equivalence. Requires a configured browser scenario provider and a caller-supplied authorized browser session or launch configuration.",
    kind: "browser-provider",
    inputSchema: saasInvestigationRequestSchema,
    outputSchema: evidenceResultOf(saasInvestigationReportSchema),
    examples: [],
  },
] as const satisfies readonly ToolContract[];
