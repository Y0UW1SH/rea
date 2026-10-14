import type { EvidenceMcpServer } from "../EvidenceMcpServer.js";
import { runAdmittedToolOperation } from "../admittedToolOperation.js";
import { recordSessionEvidenceSources } from "../sessionEvidence.js";

import { compareStaticAndObservedEndpointsEvidenceValidated } from "../../application/javascript/JavaScriptEndpointTrafficComparisonService.js";
import { applicationToolContract } from "../../contracts/applicationToolContracts.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { endpointTrafficComparisonResultSchema } from "../../domain/javascript/javascriptEndpointTrafficComparisonSchemas.js";
import { err } from "../../domain/result.js";
import { logToolExecution } from "../toolLogging.js";
import {
  applicationValidatedInputSchema,
  toolRegistrationOptions,
} from "../toolRegistrationOptions.js";
import { recordResult } from "./helpers.js";
import type { ApplicationToolRegistration } from "./types.js";

const contract = applicationToolContract(
  "compare_static_and_observed_endpoints",
);

/** Register the offline static endpoint to HAR api-surface comparison. */
export const registerCompareStaticAndObservedEndpointsTool = (
  server: EvidenceMcpServer,
  options: ApplicationToolRegistration,
): void => {
  const registration = toolRegistrationOptions(contract);
  server.registerTool(
    contract.name,
    // Keep the advertised contract; the handler parses it so issues keep their
    // projected coordinates and inline HAR Evidence stays borrowed until admission.
    {
      ...registration,
      inputSchema: applicationValidatedInputSchema(registration.inputSchema),
    },
    async (rawInput, context) =>
      runAdmittedToolOperation(
        server,
        options.withAdmittedAnalysis,
        contract.name,
        context.mcpReq.signal,
        async () => {
          const parsed = contract.inputSchema.safeParse(rawInput);
          if (!parsed.success)
            return server.delivery.toCallToolResult(
              err(
                analysisInputErrorFromIssues(
                  contract.name,
                  parsed.error.issues,
                  rawInput,
                  { cause: parsed.error },
                ),
              ),
              contract,
            );
          const input = parsed.data;
          const result = await logToolExecution(
            options.logger,
            contract.name,
            () =>
              Promise.resolve(
                compareStaticAndObservedEndpointsEvidenceValidated(
                  input,
                  options.evidenceById,
                ),
              ),
          );
          if (!result.ok)
            return server.delivery.toCallToolResult(result, contract);
          const recorded = recordSessionEvidenceSources(
            options.recordEvidence,
            result.value.sources,
          );
          if (!recorded.ok)
            return server.delivery.toCallToolResult(recorded, contract);
          const { summary } = endpointTrafficComparisonResultSchema.parse(
            result.value.evidence.normalized_result,
          );
          return recordResult(
            { ...options, delivery: server.delivery },
            contract,
            result.value.evidence,
            summary.unknown > 0 || summary.ambiguous > 0
              ? "static-observed-endpoint-comparison"
              : undefined,
          );
        },
      ),
  );
};
