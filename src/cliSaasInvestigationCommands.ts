import { Cli } from "incur";
import { z } from "zod";
import type { Logger } from "pino";
import { runSaasInvestigation } from "./application/saas/SaasInvestigationService.js";
import { withCommandCancellation } from "./cli/commandCancellation.js";
import { CLI_COMMANDS } from "./cliCommandNames.js";
import { parseCliJsonInput, resolveCliJsonPaths } from "./cliJsonInput.js";
import { logCliCommand } from "./cliLogging.js";
import { projectAnalysisError } from "./domain/analysisErrorProjection.js";
import { AnalysisOutputError } from "./domain/analysisErrorCore.js";

/** Installed adapter for the same bounded workflow exposed through MCP. */
export const registerSaasInvestigationCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  cli.command(CLI_COMMANDS.runSaasInvestigation, {
    description: "Run or resume an evidence-driven live SaaS investigation",
    args: z.object({
      inputJson: z
        .string()
        .describe(
          "Runtime plan and journal path as inline JSON or a JSON file path",
        ),
    }),
    run: ({ args }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.runSaasInvestigation, async () => {
          const input = await parseCliJsonInput(
            args.inputJson,
            "run_saas_investigation",
            signal,
          );
          if (!input.ok) return input.error;
          const { createBrowserScenarioProvider } =
            await import("./composition/browserScenario.js");
          const provider = createBrowserScenarioProvider(environment);
          let result:
            | Awaited<ReturnType<typeof runSaasInvestigation>>
            | undefined;
          try {
            result = await runSaasInvestigation(
              provider,
              resolveCliJsonPaths(input.value, [["journal_path"]]),
              { signal },
            );
            return result.ok
              ? result.value
              : {
                  error: "SaaS investigation failed",
                  ...projectAnalysisError(result.error),
                };
          } finally {
            try {
              await provider.close?.();
            } catch (cause) {
              if (result?.ok)
                throw new AnalysisOutputError(
                  "run_saas_investigation",
                  "Browser provider cleanup failed",
                  { cause, partialObservation: result.value },
                );
            }
          }
        }),
      ),
  });
};
