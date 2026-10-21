import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { BrowserScenarioCapturePort } from "../application/BrowserScenarioCapturePort.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import type { Logger } from "pino";
import {
  optionalProviderUnavailable,
  type OptionalProviderLoadFailure,
} from "../application/OptionalObservationProviders.js";
import { runSaasInvestigation } from "../application/saas/SaasInvestigationService.js";
import { toolContract } from "../contracts/toolContracts.js";
import { err } from "../domain/result.js";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";

export const registerSaasInvestigationTool = (
  server: EvidenceMcpServer,
  options: {
    readonly logger: Logger;
    readonly provider: BrowserScenarioCapturePort | undefined;
    readonly recordEvidence: EvidenceWriter["recordEvidence"] | undefined;
    readonly artifactResources: ArtifactResourceScope;
    readonly loadFailure?: OptionalProviderLoadFailure | undefined;
    readonly withAdmittedAnalysis?: WithAdmittedAnalysis;
  },
): void => {
  const contract = toolContract("run_saas_investigation");
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    createEvidenceToolHandler(
      server,
      (input, execution) =>
        options.loadFailure === undefined
          ? runSaasInvestigation(options.provider, input, {
              ...execution,
              resources: options.artifactResources,
              ...(options.recordEvidence === undefined
                ? {}
                : { recordEvidence: options.recordEvidence }),
            })
          : Promise.resolve(
              err(
                optionalProviderUnavailable(options.loadFailure, contract.name),
              ),
            ),
      options.logger,
      options.recordEvidence,
      options.withAdmittedAnalysis,
    )(contract),
  );
};
