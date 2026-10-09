import { lstat, open, writeFile } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { join } from "node:path";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import {
  readStableArtifact,
  type StableArtifactFileSystem,
} from "../artifacts/readStableArtifact.js";
import { SQLITE_DATABASE_LIMITS } from "./SqliteDatabaseLimits.js";

const fileSystem: StableArtifactFileSystem = {
  lstat: (path) => lstat(path, { bigint: true }),
  open,
};
const optionalStat = async (
  path: string,
  selectedFileSystem: StableArtifactFileSystem,
): Promise<BigIntStats | null> => {
  try {
    return await selectedFileSystem.lstat(path);
  } catch (cause: unknown) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return null;
    throw cause;
  }
};
const sameState = (
  before: BigIntStats | null,
  after: BigIntStats | null,
): boolean =>
  before === null || after === null
    ? before === after
    : before.dev === after.dev &&
      before.ino === after.ino &&
      before.mode === after.mode &&
      before.size === after.size &&
      before.mtimeNs === after.mtimeNs &&
      before.ctimeNs === after.ctimeNs;

/** Freeze a stable offline file set without ever opening the source through SQLite. */
export const captureSqliteDatabaseSnapshot = async (
  path: string,
  root: string,
  signal?: AbortSignal,
  selectedFileSystem: StableArtifactFileSystem = fileSystem,
) => {
  signal?.throwIfAborted();
  const paths = [path, `${path}-wal`, `${path}-journal`];
  const before = await Promise.all(
    paths.map((path) => optionalStat(path, selectedFileSystem)),
  );
  const database = before[0];
  const wal = before[1];
  if (database === undefined || wal === undefined || before[2] === undefined)
    throw new Error("Incomplete database file-set observation");
  if (database === null)
    throw new ArtifactReaderFailure(
      "path",
      `Selected SQLite database does not exist: ${path}`,
    );
  if (before[2] !== null)
    throw new ArtifactReaderFailure(
      "format",
      `Rollback journal present: ${path}-journal. Supply a clean offline snapshot; rollback recovery is outside this inspection profile.`,
    );
  const selectedSize = database.size + (wal?.size ?? 0n);
  if (selectedSize > BigInt(SQLITE_DATABASE_LIMITS.inputBytes))
    throw new ArtifactReaderFailure(
      "limit",
      `Selected SQLite database and WAL exceed the combined ${String(SQLITE_DATABASE_LIMITS.inputBytes)}-byte snapshot budget: ${path}`,
    );
  const snapshotPath = join(root, "database.snapshot");
  const captured = await readStableArtifact(
    path,
    SQLITE_DATABASE_LIMITS.inputBytes,
    signal,
    selectedFileSystem,
  );
  await writeFile(snapshotPath, captured.bytes, {
    flag: "wx",
    mode: 0o600,
    ...(signal === undefined ? {} : { signal }),
  });
  const artifact = {
    path,
    sha256: captured.sha256,
    bytes: captured.bytes.length,
  };
  let walArtifact: typeof artifact | null = null;
  if (wal !== null) {
    const capturedWal = await readStableArtifact(
      `${path}-wal`,
      SQLITE_DATABASE_LIMITS.inputBytes - artifact.bytes,
      signal,
      selectedFileSystem,
    );
    await writeFile(`${snapshotPath}-wal`, capturedWal.bytes, {
      flag: "wx",
      mode: 0o600,
      ...(signal === undefined ? {} : { signal }),
    });
    walArtifact = {
      path: `${path}-wal`,
      sha256: capturedWal.sha256,
      bytes: capturedWal.bytes.length,
    };
  }
  const after = await Promise.all(
    paths.map((path) => optionalStat(path, selectedFileSystem)),
  );
  for (const [index, expected] of before.entries())
    if (!sameState(expected, after[index] ?? null))
      throw new ArtifactReaderFailure(
        "integrity",
        `SQLite snapshot file set changed during acquisition: ${paths[index] ?? path}`,
      );
  signal?.throwIfAborted();
  return { snapshotPath, artifact, wal: walArtifact };
};
