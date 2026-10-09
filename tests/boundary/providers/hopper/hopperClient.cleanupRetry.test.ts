import { spawn, type ChildProcess } from "node:child_process";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Socket } from "node:net";

import { expect, it, onTestFinished } from "vitest";

import { projectAnalysisError } from "../../../../src/domain/analysisErrorProjection.js";
import { ok } from "../../../../src/domain/result.js";
import type {
  BridgeLaunch,
  BridgeLauncher,
  BridgeSession,
} from "../../../../src/hopper/BridgeLauncher.js";
import { HopperClient } from "../../../../src/hopper/HopperClient.js";
import { cleanupHopperSession } from "../../../../src/hopper/HopperCleanup.js";
import { silentLogger } from "../../../../src/logger.js";
import { PrivateRuntimeRoot } from "../../../../src/process/PrivateRuntimeRoot.js";
import { ProviderProcessSupervisor } from "../../../../src/process/ProviderProcess.js";

class RetryCleanupLauncher implements BridgeLauncher {
  readonly sessions: BridgeSession[] = [];
  readonly processes: ChildProcess[] = [];
  allowCleanup = false;

  constructor(readonly externalDocument = false) {
    onTestFinished(async () => {
      for (const process of this.processes) await stopFixture(process);
      for (const session of this.sessions)
        await rm(session.directory, { recursive: true, force: true });
    });
  }

  async launch(session: BridgeSession) {
    this.sessions.push(session);
    const preparedImagePath = join(session.directory, "image.macho");
    await writeFile(preparedImagePath, "owned prepared backing image");
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1000)"],
      { stdio: "ignore" },
    );
    this.processes.push(child);
    const launch: BridgeLaunch = this.externalDocument
      ? {
          process: child,
          ownsProcessLifetime: false,
          providerLifetime: "external-application",
          shutdownMode: "bridge-request",
          preparedImagePath,
        }
      : {
          process: child,
          ownsProcessLifetime: true,
          providerLifetime: "launcher-process",
          shutdownMode: "process-cleanup",
          preparedImagePath,
          cleanup: async () => {
            if (!this.allowCleanup)
              return {
                cleaned: false,
                reason: "fixture transient cleanup denial",
              };
            await stopFixture(child);
            return { cleaned: true, signaled: true };
          },
        };
    return ok(launch);
  }
}

const stopFixture = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => resolve()),
  );
  child.kill("SIGKILL");
  await exited;
};

const failedStartup = async (launcher: RetryCleanupLauncher) => {
  const client = new HopperClient({ launcher, startupTimeoutMs: 100 });
  onTestFinished(() => client.close());
  await expect(client.start()).resolves.toMatchObject({
    ok: false,
    error: { _tag: "HopperTimeoutError" },
  });
  const session = launcher.sessions[0];
  const child = launcher.processes[0];
  if (session === undefined || child === undefined)
    throw new Error("Fixture launch was not observed");
  return { client, session, child };
};

it("retains failed startup cleanup until an owned process and its backing image are closed", async () => {
  const launcher = new RetryCleanupLauncher();
  const { client, session, child } = await failedStartup(launcher);
  const closed = await client.closeWithOutcome();
  expect(closed).toMatchObject({
    ok: false,
    error: {
      cleanupIncomplete: true,
      cleanupResources: [
        "hopper-process",
        "hopper-document",
        session.directory,
      ],
    },
  });
  if (closed.ok) throw new Error("Expected incomplete fixture cleanup");
  expect(projectAnalysisError(closed.error)).toMatchObject({
    code: "cleanup_incomplete",
    details: {
      resources: ["hopper-process", "hopper-document", session.directory],
    },
  });
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBeNull();
  await expect(
    readFile(join(session.directory, "image.macho"), "utf8"),
  ).resolves.toBe("owned prepared backing image");

  launcher.allowCleanup = true;
  const first = client.closeWithOutcome();
  const second = client.closeWithOutcome();
  await expect(first).resolves.toEqual({ ok: true, value: null });
  await expect(second).resolves.toEqual({ ok: true, value: null });
  expect(child.signalCode).toBe("SIGKILL");
  await expect(access(session.directory)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(client.closeWithOutcome()).resolves.toEqual({
    ok: true,
    value: null,
  });
});

it("keeps an unconfirmed external document visible across sequential closes", async () => {
  const launcher = new RetryCleanupLauncher(true);
  const { client, session, child } = await failedStartup(launcher);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await expect(client.closeWithOutcome()).resolves.toMatchObject({
      ok: false,
      error: { cleanupResources: ["hopper-document", session.directory] },
    });
  }
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBeNull();
  await expect(
    access(join(session.directory, "image.macho")),
  ).resolves.toBeUndefined();
});

it("blocks a fresh launch while cleanup remains unverified", async () => {
  const launcher = new RetryCleanupLauncher();
  const { client, child } = await failedStartup(launcher);
  await expect(client.start()).resolves.toMatchObject({
    ok: false,
    error: { _tag: "HopperProtocolError" },
  });
  expect(launcher.processes).toEqual([child]);
  launcher.allowCleanup = true;
  await expect(client.closeWithOutcome()).resolves.toEqual({
    ok: true,
    value: null,
  });
});

it("preserves confirmed document shutdown while retrying owned process cleanup", async () => {
  const launcher = new RetryCleanupLauncher();
  const runtimeRoot = await PrivateRuntimeRoot.create();
  onTestFinished(() => runtimeRoot.close());
  const launched = await launcher.launch({
    directory: runtimeRoot.path,
    socketPath: join(runtimeRoot.path, "bridge.sock"),
    token: "fixture-token",
    runId: "fixture-run",
  });
  if (!launched.ok) throw launched.error;
  const supervisor = new ProviderProcessSupervisor(launched.value);
  onTestFinished(() => supervisor.dispose());
  const input = {
    launch: launched.value,
    processSupervisor: supervisor,
    runtimeRoot,
    activeRequest: null,
    retainDocument: false,
    progress: undefined,
    logger: silentLogger,
    onDiagnostic: undefined,
    request: () =>
      Promise.resolve(
        ok({
          shutdown: true,
          analysis_stopped: true,
          document_closed: true,
        }),
      ),
    releaseTransport: (socket: Socket | undefined) => socket?.destroy(),
  };
  const first = await cleanupHopperSession({ ...input, socket: new Socket() });
  expect(first.result).toMatchObject({
    ok: false,
    error: { cleanupResources: ["hopper-process"] },
  });
  launcher.allowCleanup = true;
  const second = await cleanupHopperSession({
    ...input,
    socket: undefined,
    shutdownConfirmed: first.shutdownConfirmed,
  });
  expect(second.result).toEqual({ ok: true, value: null });
  expect(launched.value.process.signalCode).toBe("SIGKILL");
  await expect(access(runtimeRoot.path)).rejects.toMatchObject({
    code: "ENOENT",
  });
});
