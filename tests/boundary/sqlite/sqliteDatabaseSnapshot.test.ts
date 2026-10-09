import { lstat, open, readFile, utimes, writeFile } from "node:fs/promises";
import { expect, it, onTestFinished } from "vitest";
import type { StableArtifactFileSystem } from "../../../src/artifacts/readStableArtifact.js";
import { captureSqliteDatabaseSnapshot } from "../../../src/sqlite/SqliteDatabaseSnapshot.js";
import { createSqliteDatabaseFixture } from "../../fixtures/sqlite/database.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../../support/workspace/workspaceFixture.js";

const fixture = async (wal = false) => {
  const workspace = await createTestWorkspace("rea-sqlite-snapshot-race-");
  const database = createSqliteDatabaseFixture(workspace.root, wal);
  if (!wal) database.close();
  onTestFinished(async () => {
    if (wal) database.close();
    await removeTestWorkspace(workspace.root);
  });
  const root = await workspace.mkdir("private");
  return { workspace, database, root };
};

it("rejects a database changed after its copy but before WAL acquisition", async () => {
  const { database, root } = await fixture(true);
  const initial = await readFile(database.path);
  const initialStat = await lstat(database.path);
  let changed = false;
  const fileSystem: StableArtifactFileSystem = {
    lstat: (path) => lstat(path, { bigint: true }),
    open: async (path, flags) => {
      if (path === database.walPath) {
        const bytes = Buffer.from(initial);
        const offset = bytes.length - 1;
        bytes[offset] = (bytes[offset] ?? 0) ^ 1;
        await writeFile(database.path, bytes);
        await utimes(database.path, initialStat.atime, initialStat.mtime);
        changed = true;
      }
      return open(path, flags);
    },
  };
  await expect(
    captureSqliteDatabaseSnapshot(database.path, root, undefined, fileSystem),
  ).rejects.toMatchObject({ reason: "integrity" });
  expect(changed).toBe(true);
  expect(await readFile(`${root}/database.snapshot`)).toEqual(initial);
});

it.each(["-wal", "-journal"] as const)(
  "rejects a previously absent %s created during database acquisition",
  async (suffix) => {
    const { database, root } = await fixture();
    let created = false;
    const fileSystem: StableArtifactFileSystem = {
      lstat: (path) => lstat(path, { bigint: true }),
      open: async (path, flags) => {
        if (path === database.path) {
          await writeFile(
            `${database.path}${suffix}`,
            "newly selected sidecar",
          );
          created = true;
        }
        return open(path, flags);
      },
    };
    await expect(
      captureSqliteDatabaseSnapshot(database.path, root, undefined, fileSystem),
    ).rejects.toMatchObject({ reason: "integrity" });
    expect(created).toBe(true);
  },
);
