import { access } from "node:fs/promises";
import { expect, it, onTestFinished } from "vitest";
import { SqliteDatabaseProvider } from "../../../src/sqlite/SqliteDatabaseProvider.js";
import { PrivateRuntimeRoot } from "../../../src/process/PrivateRuntimeRoot.js";
import { createDeferred } from "../../fixtures/binarySession.js";
import { createSqliteDatabaseFixture } from "../../fixtures/sqlite/database.js";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../../support/workspace/workspaceFixture.js";

const cleanupFixture = async () => {
  const workspace = await createTestWorkspace("rea-sqlite-cleanup-");
  const database = createSqliteDatabaseFixture(workspace.root);
  database.close();
  const roots: PrivateRuntimeRoot[] = [];
  let removalAllowed = false;
  let attempts = 0;
  const provider = new SqliteDatabaseProvider(
    {},
    () => {
      throw new Error("SQLite worker deliberately unavailable");
    },
    async () => {
      const root = await PrivateRuntimeRoot.create({ parent: workspace.root });
      roots.push(root);
      return {
        path: root.path,
        close: async () => {
          attempts += 1;
          if (!removalAllowed) throw new Error("snapshot removal denied");
          await root.close();
        },
      };
    },
  );
  onTestFinished(async () => {
    await Promise.all(roots.map((root) => root.close()));
    await removeTestWorkspace(workspace.root);
  });
  return {
    provider,
    roots,
    path: database.path,
    allowRemoval: () => {
      removalAllowed = true;
    },
    attempts: () => attempts,
  };
};

it("retains failed snapshot owners and blocks new acquisition until retry succeeds", async () => {
  const fixture = await cleanupFixture();
  const first = await fixture.provider.inspect({ path: fixture.path });
  expect(first).toMatchObject({
    ok: false,
    error: { cleanupIncomplete: true },
  });
  const root = fixture.roots[0];
  if (root === undefined) throw new Error("Missing owned root");
  await expect(access(root.path)).resolves.toBeUndefined();
  const second = await fixture.provider.inspect({ path: fixture.path });
  expect(second).toMatchObject({
    ok: false,
    error: { cleanupIncomplete: true },
  });
  expect(fixture.roots).toHaveLength(1);
  expect(fixture.attempts()).toBe(2);
  fixture.allowRemoval();
  await fixture.provider.inspect({ path: fixture.path });
  expect(fixture.roots).toHaveLength(2);
  await expect(access(root.path)).rejects.toMatchObject({ code: "ENOENT" });
  await fixture.provider.close();
});

it("awaits shared shutdown cleanup and retains failures for a later close", async () => {
  const fixture = await cleanupFixture();
  await fixture.provider.inspect({ path: fixture.path });
  const closed = await Promise.allSettled([
    fixture.provider.close(),
    fixture.provider.close(),
  ]);
  expect(closed.map((result) => result.status)).toEqual([
    "rejected",
    "rejected",
  ]);
  expect(fixture.attempts()).toBe(2);
  expect(await fixture.provider.inspect({ path: fixture.path })).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCancelledError" },
  });
  fixture.allowRemoval();
  await fixture.provider.close();
  await fixture.provider.close();
  expect(fixture.attempts()).toBe(3);
  for (const root of fixture.roots)
    await expect(access(root.path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("waits for concurrent acquisitions and releases only owners whose cleanup succeeds", async () => {
  const workspace = await createTestWorkspace("rea-sqlite-concurrent-cleanup-");
  const database = createSqliteDatabaseFixture(workspace.root);
  database.close();
  const acquired = createDeferred<void>();
  const release = createDeferred<void>();
  const roots: PrivateRuntimeRoot[] = [];
  const allowed = new Set<PrivateRuntimeRoot>();
  const provider = new SqliteDatabaseProvider(
    {},
    () => {
      throw new Error("SQLite worker deliberately unavailable");
    },
    async () => {
      const root = await PrivateRuntimeRoot.create({ parent: workspace.root });
      roots.push(root);
      if (roots.length === 2) acquired.resolve();
      await release.promise;
      return {
        path: root.path,
        close: async () => {
          if (!allowed.has(root)) throw new Error("snapshot removal denied");
          await root.close();
        },
      };
    },
  );
  onTestFinished(async () => {
    release.resolve();
    roots.forEach((root) => allowed.add(root));
    await provider.close();
    await removeTestWorkspace(workspace.root);
  });
  const inspections = [
    provider.inspect({ path: database.path }),
    provider.inspect({ path: database.path }),
  ];
  await acquired.promise;
  let settled = false;
  const closing = provider.close().finally(() => {
    settled = true;
  });
  const rejected = expect(closing).rejects.toMatchObject({
    cleanupIncomplete: true,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  release.resolve();
  await Promise.all(inspections);
  await rejected;
  const [first, second] = roots;
  if (first === undefined || second === undefined)
    throw new Error("Missing owned roots");
  allowed.add(first);
  await expect(provider.close()).rejects.toMatchObject({
    cleanupResources: [second.path],
  });
  await expect(access(first.path)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(access(second.path)).resolves.toBeUndefined();
  allowed.add(second);
  await provider.close();
  await expect(access(second.path)).rejects.toMatchObject({ code: "ENOENT" });
});
