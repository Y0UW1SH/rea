import {
  createAnalysisExecution,
  type AnalysisExecution,
  type ExecutionOptions,
} from "../application/AnalysisProvider.js";
import type { SqliteDatabasePort } from "../application/sqlite/SqliteDatabasePort.js";
import type {
  AnalysisCapturedOutput,
  AnalysisError,
} from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  inspectSqliteDatabaseInputSchema,
  sqliteDatabaseSchema,
  type InspectSqliteDatabaseInput,
} from "../domain/sqlite/sqliteDatabase.js";
import { isAbsolute } from "node:path";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import { sqliteDatabaseFailure } from "./SqliteDatabaseFailures.js";
import { SQLITE_PROVIDER_IDENTITY } from "./SqliteDatabaseLimits.js";
import { captureSqliteDatabaseSnapshot } from "./SqliteDatabaseSnapshot.js";

import {
  executeSqliteDatabaseWorker,
  type SqliteWorkerLauncher,
} from "./SqliteDatabaseWorkerExecution.js";

const operation = "inspect_sqlite_database";
/** Inspect a provider-owned copy through a cancellable SQLite child, without source writes. */
export class SqliteDatabaseProvider implements SqliteDatabasePort {
  constructor(
    readonly environment: Readonly<NodeJS.ProcessEnv> = process.env,
    readonly launcher?: SqliteWorkerLauncher,
    readonly createRuntime: () => Promise<
      Pick<PrivateRuntimeRoot, "path" | "close">
    > = () => PrivateRuntimeRoot.create({ prefix: "rea-sqlite-database-" }),
  ) {}

  /** Return exact original DB/WAL identities and current schema/selected committed rows. */
  async inspect(
    input: InspectSqliteDatabaseInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    let root: Pick<PrivateRuntimeRoot, "path" | "close"> | undefined;
    let retainedOutput: AnalysisCapturedOutput | undefined;
    let phase = "configuration";
    let result: Result<AnalysisExecution, AnalysisError>;
    try {
      if (options?.signal?.aborted) throw new AnalysisCancelledError(operation);
      validateSqliteInput(input);
      root = await this.createRuntime();
      phase = "artifact-read";
      const snapshot = await captureSqliteDatabaseSnapshot(
        input.path,
        root.path,
        options?.signal,
      );
      phase = "worker";
      const inspection = await executeSqliteDatabaseWorker({
        input,
        root: root.path,
        snapshotPath: snapshot.snapshotPath,
        environment: this.environment,
        ...(this.launcher === undefined ? {} : { launcher: this.launcher }),
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
        captured: (output) => {
          retainedOutput = output;
        },
      });
      const validated = sqliteDatabaseSchema.safeParse({
        artifact: snapshot.artifact,
        wal: snapshot.wal,
        ...inspection,
      });
      if (!validated.success)
        throw new AnalysisOutputError(
          operation,
          "SQLite worker report dimensions or identity fields are invalid",
          retainedOutput === undefined
            ? undefined
            : { capturedOutput: retainedOutput },
        );
      result = ok(createSqliteObservation(validated.data, input.path));
    } catch (cause: unknown) {
      const failure = sqliteDatabaseFailure(cause, input.path, phase);
      retainedOutput ??= failure.capturedOutput;
      result = err(selectedFailure(failure, options?.signal, retainedOutput));
    }
    if (root !== undefined) {
      const cleaned = await cleanupSqliteRoot(root, result, retainedOutput);
      if (!cleaned.ok) return cleaned;
    }
    return completedResult(result, options?.signal, retainedOutput);
  }
}

const selectedFailure = (
  failure: AnalysisError,
  signal?: AbortSignal,
  output?: AnalysisCapturedOutput,
): AnalysisError =>
  signal?.aborted &&
  failure._tag !== "AnalysisCancelledError" &&
  !failure.cleanupIncomplete
    ? new AnalysisCancelledError(
        operation,
        output === undefined ? undefined : { capturedOutput: output },
      )
    : failure;
const completedResult = (
  result: Result<AnalysisExecution, AnalysisError>,
  signal?: AbortSignal,
  output?: AnalysisCapturedOutput,
): Result<AnalysisExecution, AnalysisError> =>
  result.ok && signal?.aborted
    ? err(
        new AnalysisCancelledError(
          operation,
          output === undefined ? undefined : { capturedOutput: output },
        ),
      )
    : result;

const createSqliteObservation = (
  report: ReturnType<typeof sqliteDatabaseSchema.parse>,
  path: string,
): AnalysisExecution => {
  const locations: AnalysisExecution["locations"][number][] = [
    { kind: "artifact-path", path },
  ];
  if (report.wal !== null)
    locations.push({ kind: "artifact-path", path: report.wal.path });
  return createAnalysisExecution(
    report,
    { ...SQLITE_PROVIDER_IDENTITY, version: `SQLite ${report.engine.version}` },
    {
      rawResult: null,
      subject: { path, format: "file", sha256: report.artifact.sha256 },
      locations,
      limitations: report.limitations,
    },
  );
};
const cleanupSqliteRoot = async (
  root: Pick<PrivateRuntimeRoot, "path" | "close">,
  result: Result<AnalysisExecution, AnalysisError>,
  output?: AnalysisCapturedOutput,
): Promise<Result<null, AnalysisError>> => {
  try {
    await root.close();
    return ok(null);
  } catch (cause: unknown) {
    return err(
      new ProviderCleanupError(
        SQLITE_PROVIDER_IDENTITY.id,
        [root.path],
        {
          reason: cause instanceof Error ? cause.message : String(cause),
          previous_error: result.ok ? null : projectAnalysisError(result.error),
          previous_result: result.ok ? result.value.result : null,
          ...(output === undefined ? {} : { captured_output: { ...output } }),
        },
        { operation, cause },
      ),
    );
  }
};

const validateSqliteInput = (input: InspectSqliteDatabaseInput): void => {
  const parsed = inspectSqliteDatabaseInputSchema.safeParse(input);
  if (!parsed.success || !isAbsolute(input.path))
    throw new AnalysisInputError(operation, undefined, [
      {
        path: ["path"],
        reason: "invalid_format",
        message: parsed.success
          ? "path must be an absolute local filesystem path"
          : parsed.error.message,
      },
    ]);
};
