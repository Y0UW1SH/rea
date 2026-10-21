import {
  lstat,
  open,
  realpath,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import {
  ArtifactResourceScope,
  type ArtifactResourceOwner,
} from "../../artifacts/ArtifactResourceScope.js";
import { withArtifactFileHandle } from "../../artifacts/ArtifactFileOperation.js";
import { digestCanonicalValue } from "../../domain/canonicalDigest.js";
import { evidenceBundleSchema } from "../../domain/evidenceBundle.js";
import {
  EvidenceFileError,
  EvidenceIntegrityError,
} from "../../domain/evidenceErrors.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { canonicalJsonParts } from "../../domain/jsonSerialization.js";
import { openRegularFile } from "../../filesystem/RegularFile.js";
import { OwnedFileHandle } from "../../filesystem/OwnedFileHandle.js";
import { writeTextParts } from "../JsonFiles.js";
import { InvestigationRecords } from "../investigation/InvestigationRecords.js";
import {
  saasInvestigationFailureSchema,
  type SaasInvestigationPlan,
} from "../../domain/saasInvestigation.js";

const attemptSchema = z.strictObject({
  experiment_id: z.string(),
  before_evidence_id: z.string(),
  action_evidence_id: z.string().nullable(),
  after_evidence_id: z.string().nullable(),
  recovered: z.boolean(),
});
export type SaasAttempt = z.infer<typeof attemptSchema>;
const journalSchema = z.strictObject({
  version: z.literal(1),
  plan_sha256: z.string(),
  actions_reserved: z.number().int().nonnegative().safe(),
  attempts: z.array(attemptSchema),
  failures: z.array(saasInvestigationFailureSchema),
  evidence: evidenceBundleSchema,
  checksum: z.string(),
});

const capacity = (maximum: number) =>
  new AnalysisResourceConstraintError(
    "run_saas_investigation",
    "file-size",
    "Investigation journal exceeds the caller-selected byte limit",
    { max_journal_bytes: maximum },
    { retryable: false },
  );

/** Exclusive lock and synchronized atomic checkpoints; Evidence stays owned by InvestigationRecords. */
export class SaasInvestigationJournal {
  readonly records = new InvestigationRecords();
  readonly attempts: SaasAttempt[] = [];
  readonly failures: z.infer<typeof saasInvestigationFailureSchema>[] = [];
  actionsReserved = 0;
  readonly planDigest: string;
  #lockRemoved = false;
  readonly #lockOwner: ArtifactResourceOwner;
  #identity: { dev: number; ino: number } | undefined;
  #published = false;

  private constructor(
    readonly path: string,
    readonly plan: SaasInvestigationPlan,
    private readonly lock: FileHandle,
    private readonly resources: ArtifactResourceScope,
  ) {
    this.planDigest = digestCanonicalValue(plan);
    const handle = new OwnedFileHandle(lock);
    this.#lockOwner = {
      kind: "lease",
      resource: `${path}.lock`,
      lease: {
        release: async () => {
          if (!this.#lockRemoved) {
            const current = await lstat(`${this.path}.lock`);
            if (
              this.#identity === undefined ||
              current.dev !== this.#identity.dev ||
              current.ino !== this.#identity.ino ||
              !current.isFile() ||
              current.isSymbolicLink()
            )
              throw new Error(
                "Investigation lock identity changed; refusing to remove it",
              );
            await unlink(`${this.path}.lock`);
            this.#lockRemoved = true;
          }
          await handle.close();
        },
      },
    };
  }

  static async open(
    path: string,
    plan: SaasInvestigationPlan,
    resources: ArtifactResourceScope,
  ): Promise<SaasInvestigationJournal> {
    if (process.platform === "win32")
      throw new AnalysisCapabilityUnavailableError(
        "rea-local-journal",
        "run_saas_investigation",
        "Live investigation requires a host with directory fsync support; Windows journal durability is not implemented",
      );
    const canonical = join(await realpath(dirname(path)), basename(path));
    let lock: FileHandle;
    try {
      lock = await open(`${canonical}.lock`, "wx", 0o600);
    } catch (cause) {
      throw new EvidenceFileError("write", "io", {
        path: canonical,
        cause,
        userMessage:
          "Cannot acquire investigation journal lock. Another run or an interrupted process may own it. Never remove the lock until that process is confirmed stopped.",
      });
    }
    // Transfer ownership before any fallible initialization so the service can
    // finalize the lock without replacing an initialization failure.
    return new SaasInvestigationJournal(canonical, plan, lock, resources);
  }

  async initialize(): Promise<void> {
    this.#identity = await this.lock.stat();
    await this.lock.writeFile(
      "REA live investigation in progress. Confirm the owning process has stopped before removing this lock.\n",
    );
    await this.lock.sync();
    await this.#syncDirectory();
    await this.#load();
  }

  async #load(): Promise<void> {
    let handle: FileHandle;
    try {
      handle = await openRegularFile(this.path, { symlinks: "reject" });
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
        return;
      throw cause;
    }
    await withArtifactFileHandle(
      this.path,
      handle,
      this.resources,
      undefined,
      async () => {
        const maximum = this.plan.limits.max_journal_bytes;
        const stats = await handle.stat();
        if (stats.size > maximum) throw capacity(maximum);
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of handle.createReadStream({
          autoClose: false,
        })) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += bytes.length;
          if (total > maximum) throw capacity(maximum);
          chunks.push(bytes);
        }
        const decoded: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
            Buffer.concat(chunks),
          ),
        );
        const { checksum, ...state } = journalSchema.parse(decoded);
        if (checksum !== digestCanonicalValue(state))
          throw new EvidenceIntegrityError(
            "Investigation journal checksum mismatch",
          );
        if (state.plan_sha256 !== this.planDigest)
          throw new EvidenceIntegrityError(
            "Investigation journal belongs to a different plan; use its original plan or a new journal",
          );
        const ids = new Set(this.plan.experiments.map(({ id }) => id));
        if (
          state.actions_reserved > this.plan.limits.max_actions ||
          state.attempts.length > this.plan.limits.max_experiments ||
          new Set(state.attempts.map(({ experiment_id: id }) => id)).size !==
            state.attempts.length ||
          state.attempts.some(
            (attempt, index) =>
              !ids.has(attempt.experiment_id) ||
              (attempt.after_evidence_id === null &&
                index !== state.attempts.length - 1),
          )
        )
          throw new EvidenceIntegrityError(
            "Investigation journal progress is inconsistent",
          );
        const imported = this.records.mergeEvidenceBundle(state.evidence);
        if (!imported.ok) throw imported.error;
        for (const attempt of state.attempts)
          for (const id of [
            attempt.before_evidence_id,
            attempt.action_evidence_id,
            attempt.after_evidence_id,
          ])
            if (id !== null && !this.records.hasEvidence(id))
              throw new EvidenceIntegrityError(
                "Investigation journal references missing Evidence",
              );
        this.actionsReserved = state.actions_reserved;
        this.attempts.push(...state.attempts);
        this.failures.push(...state.failures);
        this.#published = true;
      },
    );
  }

  async save(): Promise<void> {
    const state = {
      version: 1,
      plan_sha256: this.planDigest,
      actions_reserved: this.actionsReserved,
      attempts: this.attempts,
      failures: this.failures,
      evidence: this.records.evidenceBundleForSerialization(),
    };
    const document = { ...state, checksum: digestCanonicalValue(state) };
    let bytes = 0;
    for (const part of canonicalJsonParts(document)) {
      bytes += Buffer.byteLength(part);
      if (bytes > this.plan.limits.max_journal_bytes)
        throw capacity(this.plan.limits.max_journal_bytes);
    }
    const saved = await writeTextParts(
      canonicalJsonParts(document),
      this.path,
      this.#published,
      this.resources,
    );
    if (!saved.ok) throw saved.error;
    this.#published = true;
    // File sync precedes atomic publication in writeTextParts. Commit the new
    // directory entry before returning permission to execute a target action.
    await this.#syncDirectory();
  }

  async #syncDirectory(): Promise<void> {
    const path = dirname(this.path);
    const handle = await open(path, "r");
    await withArtifactFileHandle(
      path,
      handle,
      this.resources,
      undefined,
      (directory) => directory.sync(),
    );
  }

  async close(): Promise<void> {
    const released = await this.resources.release(this.#lockOwner);
    if (released.kind === "failed")
      throw this.resources.cleanupFailure({ kind: "completed" }, [released]);
  }
}
