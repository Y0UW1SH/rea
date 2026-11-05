import { access, readFile, type FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, test as platformTest, vi } from "vitest";
import type { BrowserScenario } from "../../src/domain/browserScenario.js";

const test = platformTest.skipIf(process.platform === "win32");

const fault = vi.hoisted(() => ({
  journal: "",
  unlinkFailures: 0,
  unlinkCalls: 0,
  failSync: "" as "" | "initial" | "intent" | "withdrawal",
  // Abort once the before-probe Evidence or the action intent is published.
  abortAt: "" as "" | "probe" | "intent",
  abort: new AbortController(),
  withdrawing: false,
  directorySyncs: 0,
  lock: undefined as FileHandle | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    unlink: async (...args: Parameters<typeof original.unlink>) => {
      if (args[0] === `${fault.journal}.lock`) {
        fault.unlinkCalls += 1;
        if (fault.unlinkFailures-- > 0)
          throw Object.assign(new Error("Controlled lock removal failure"), {
            code: "EBUSY",
          });
      }
      await original.unlink(...args);
    },
    open: async (...args: Parameters<typeof original.open>) => {
      const handle = await original.open(...args);
      if (args[0] === `${fault.journal}.lock`) fault.lock = handle;
      if (args[0] === dirname(fault.journal)) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          fault.directorySyncs += 1;
          const saved = await original
            .readFile(fault.journal, "utf8")
            .catch(() => "null");
          const state = JSON.parse(saved);
          const intent = state?.attempts.length > 0;
          if (
            (fault.abortAt === "probe" &&
              !intent &&
              state?.evidence.records.length === 1) ||
            (fault.abortAt === "intent" && intent)
          )
            fault.abort.abort();
          fault.withdrawing ||= intent;
          if (
            fault.failSync === "initial" ||
            (fault.failSync === "intent" && intent) ||
            (fault.failSync === "withdrawal" && (intent || fault.withdrawing))
          )
            throw Object.assign(
              new Error("Controlled directory sync failure"),
              { code: "EIO" },
            );
          await sync();
        };
      }
      return handle;
    },
  };
});

import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import {
  investigationCapture,
  investigationPlan,
} from "../fixtures/saasInvestigation.js";
import { runSaasInvestigation } from "../../src/application/saas/SaasInvestigationService.js";
import type { BrowserScenarioCapturePort } from "../../src/application/BrowserScenarioCapturePort.js";
import { ArtifactReaderFailure } from "../../src/artifacts/ArtifactReader.js";
import { ArtifactResourceScope } from "../../src/artifacts/ArtifactResourceScope.js";
import { resolvedAnalysisError } from "../../src/domain/analysisErrorBase.js";
import { ok } from "../../src/domain/result.js";

afterEach(async () => {
  fault.unlinkFailures = 0;
  fault.failSync = "";
  fault.abortAt = "";
  fault.withdrawing = false;
  fault.abort = new AbortController();
  if (fault.lock !== undefined && fault.lock.fd >= 0) await fault.lock.close();
  fault.lock = undefined;
});

const fixture = async (actor = "different-actor") => {
  const root = await createTestTempDirectory("rea-saas-lifecycle-");
  fault.journal = join(root, "journal.json");
  fault.unlinkCalls = 0;
  fault.directorySyncs = 0;
  const writes: string[] = [];
  const records = new Map<string, { record: string; value: number }>();
  const captureScenario = vi.fn(async (scenario: BrowserScenario) => {
    const path = new URL(scenario.start_url.url).pathname;
    const id = path.split("/")[2]!;
    if (path.startsWith("/act/")) {
      writes.push(id);
      records.set(id, { record: `run-1-${id}`, value: id === "first" ? 1 : 0 });
    }
    return ok(
      investigationCapture(scenario, {
        actor,
        workspace: "test-workspace",
        record: null,
        ...records.get(id),
      }),
    );
  }) satisfies BrowserScenarioCapturePort["captureScenario"];
  return {
    input: { plan: investigationPlan(), journal_path: fault.journal },
    provider: {
      identity: () => ({ id: "fixture", name: "fixture", version: "1" }),
      captureScenario,
    },
    writes: () => writes.length,
    writtenIds: () => writes,
  };
};

test("retries transient lock cleanup even when the first close throws", async () => {
  const { input, provider } = await fixture();
  fault.unlinkFailures = 1;
  const result = await runSaasInvestigation(provider, input);
  expect(result.ok).toBe(true);
  expect(fault.unlinkCalls).toBe(2);
  expect(fault.lock?.fd).toBe(-1);
  await expect(access(`${fault.journal}.lock`)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test.each([false, true])(
  "retains partial evidence and exact cleanup authority (caller scope: %s)",
  async (callerScope) => {
    const { input, provider } = await fixture();
    const resources = callerScope ? new ArtifactResourceScope() : undefined;
    fault.unlinkFailures = Infinity;
    const result = await runSaasInvestigation(
      provider,
      input,
      resources === undefined ? {} : { resources },
    );
    if (result.ok) throw new Error("Expected incomplete cleanup");
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(result.error.cleanupResources).toEqual([`${fault.journal}.lock`]);
    expect(result.error.partialObservation).toMatchObject({
      normalized_result: { status: "paused" },
    });
    expect(fault.lock?.fd).toBeGreaterThanOrEqual(0);
    fault.unlinkFailures = 0;
    if (resources !== undefined) await resources.close();
    else {
      const cause = result.error.cause;
      expect(cause).toBeInstanceOf(ArtifactReaderFailure);
      if (
        !(cause instanceof ArtifactReaderFailure) ||
        !cause.cleanupLeases?.length
      )
        throw new Error("Missing retained cleanup authority");
      for (const lease of cause.cleanupLeases) await lease.release();
    }
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(result.error.cleanupResources).toEqual([]);
    expect(fault.lock?.fd).toBe(-1);
    await expect(access(`${fault.journal}.lock`)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

test.each(["capacity", "plan"])(
  "preserves a typed %s failure when lock finalization also fails",
  async (kind) => {
    const { input, provider } = await fixture();
    const tag =
      kind === "capacity"
        ? "AnalysisResourceConstraintError"
        : "EvidenceIntegrityError";
    if (kind === "capacity") input.plan.limits.max_journal_bytes = 10;
    else {
      expect((await runSaasInvestigation(provider, input)).ok).toBe(true);
      input.plan.actor_id = "changed";
      provider.captureScenario.mockClear();
    }
    const resources = new ArtifactResourceScope();
    fault.unlinkFailures = Infinity;
    const result = await runSaasInvestigation(provider, input, { resources });
    if (result.ok) throw new Error("Expected capacity failure");
    expect(result.error.cleanupPrimary?._tag).toBe(tag);
    expect(result.error.cleanupIncomplete).toBe(true);
    fault.unlinkFailures = 0;
    await resources.close();
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(resolvedAnalysisError(result.error)._tag).toBe(tag);
    expect(provider.captureScenario).not.toHaveBeenCalled();
  },
);

test("directory synchronization failure at initialization prevents execution", async () => {
  const { input, provider, writes } = await fixture("operator");
  fault.failSync = "initial";
  expect((await runSaasInvestigation(provider, input)).ok).toBe(false);
  expect(writes()).toBe(0);
  expect(provider.captureScenario).not.toHaveBeenCalled();
  expect(fault.directorySyncs).toBeGreaterThan(0);
});

// A persisted pending attempt must mean the action may have reached the target;
// otherwise resume can only read back a write that never happened.
test.each([
  ["intent synchronization failure", "fail"],
  ["cancellation before the action reservation", "probe"],
  ["cancellation while the intent is saved", "intent"],
] as const)(
  "%s withdraws the undispatched action and resume runs it once",
  async (_, stage) => {
    const { input, provider, writes, writtenIds } = await fixture("operator");
    if (stage === "fail") fault.failSync = "intent";
    else fault.abortAt = stage;
    const result = await runSaasInvestigation(provider, input, {
      signal: fault.abort.signal,
    });
    if (stage === "fail") expect(result.ok).toBe(false);
    else
      expect(result.ok && result.value.normalized_result).toMatchObject({
        status: "paused",
        attempts: [],
      });
    expect(writes()).toBe(0);
    expect(fault.directorySyncs).toBeGreaterThan(0);
    const saved = JSON.parse(await readFile(fault.journal, "utf8"));
    expect(saved.attempts).toEqual([]);
    fault.failSync = "";
    fault.abortAt = "";
    const resumed = await runSaasInvestigation(provider, input);
    expect(resumed.ok && resumed.value.normalized_result).toMatchObject({
      status: "distinguished",
      surviving_hypotheses: ["a"],
    });
    expect(writtenIds()).toEqual(["first", "second"]);
  },
);

test("a failed withdrawal reports both failures without dispatching", async () => {
  const { input, provider, writes } = await fixture("operator");
  fault.failSync = "withdrawal";
  const result = await runSaasInvestigation(provider, input);
  if (result.ok) throw new Error("Expected intent and withdrawal failures");
  expect(result.error.cleanupPrimary).toBeDefined();
  expect(result.error.diagnostics).toMatchObject({
    primary_error: { code: expect.any(String) },
    cleanup_error: { code: expect.any(String) },
  });
  expect(writes()).toBe(0);
});
