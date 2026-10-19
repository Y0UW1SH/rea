import {
  chmod,
  link,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  executeWorkflowFixture,
  workflowGit,
} from "../../support/workflowGit.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const script = join(root, "scripts/ci/saas-upstream-integration.mjs");
const featureRef = "refs/heads/feat/saas-behavior-compatibility";
const sha = /^[0-9a-f]{40}$/u;
const reportSchema = z.object({
  status: z.string(),
  stage: z.string(),
  controllerSha: z.string().optional(),
  controllerTree: z.string().optional(),
  sources: z.record(z.string(), z.object({ sha: z.string() })).optional(),
  merges: z.array(
    z.object({
      name: z.string(),
      beforeSha: z.string(),
      targetSha: z.string(),
      alreadyIncluded: z.boolean(),
      mergeBases: z.array(z.string()),
      resultSha: z.string().optional(),
      conflicts: z.array(z.string()).optional(),
    }),
  ),
  candidateSha: z.string().optional(),
  candidateTree: z.string().optional(),
  executedToolchain: z.object({ node: z.string(), npm: z.string() }).optional(),
  checks: z.array(
    z.object({
      command: z.array(z.string()),
      status: z.string(),
      exitCode: z.number().optional(),
    }),
  ),
  error: z.string().optional(),
});

async function fixture(conflict?: "forkMain" | "upstreamMain") {
  const directory = await createTestTempDirectory("rea-saas-integration-");
  const remote = join(directory, "remote");
  await mkdir(remote);
  await workflowGit(remote, ["init", "-b", "main"]);
  await mkdir(join(remote, "scripts/ci"), { recursive: true });
  await writeFile(
    join(remote, "scripts/ci/saas-upstream-integration.mjs"),
    await readFile(script, "utf8"),
  );
  await writeFile(join(remote, "common.txt"), "base\n");
  await writeFile(join(remote, ".nvmrc"), `${process.versions.node}\n`);
  const { packageManager } = z
    .object({ packageManager: z.string() })
    .parse(JSON.parse(await readFile(join(root, "package.json"), "utf8")));
  await writeFile(
    join(remote, "package.json"),
    JSON.stringify({ packageManager }),
  );
  await workflowGit(remote, ["add", "."]);
  await workflowGit(remote, ["commit", "-m", "base"]);
  const base = await workflowGit(remote, ["rev-parse", "HEAD"]);
  await workflowGit(remote, [
    "switch",
    "-c",
    "feat/saas-behavior-compatibility",
  ]);
  await writeFile(join(remote, "feature.txt"), "feature\n");
  if (conflict) await writeFile(join(remote, "common.txt"), "feature\n");
  await workflowGit(remote, ["add", "."]);
  await workflowGit(remote, ["commit", "-m", "feature"]);
  const feature = await workflowGit(remote, ["rev-parse", "HEAD"]);
  await workflowGit(remote, ["switch", "main"]);
  await writeFile(join(remote, "fork.txt"), "fork\n");
  if (conflict === "forkMain")
    await writeFile(join(remote, "common.txt"), "fork\n");
  await workflowGit(remote, ["add", "."]);
  await workflowGit(remote, ["commit", "-m", "fork"]);
  const forkMain = await workflowGit(remote, ["rev-parse", "HEAD"]);
  const upstream = join(directory, "upstream");
  await workflowGit(directory, ["clone", "--no-hardlinks", remote, upstream]);
  await workflowGit(upstream, ["checkout", "--detach", base]);
  await writeFile(join(upstream, "upstream.txt"), "upstream\n");
  if (conflict === "upstreamMain")
    await writeFile(join(upstream, "common.txt"), "upstream\n");
  await workflowGit(upstream, ["add", "."]);
  await workflowGit(upstream, ["commit", "-m", "upstream"]);
  const upstreamMain = await workflowGit(upstream, ["rev-parse", "HEAD"]);
  await workflowGit(upstream, ["branch", "-f", "main", upstreamMain]);
  const controller = join(directory, "controller");
  await workflowGit(directory, ["clone", "--no-hardlinks", remote, controller]);
  const controllerSha = await workflowGit(controller, ["rev-parse", "HEAD"]);
  const candidate = join(directory, "candidate");
  const report = join(directory, "report.json");
  const env = {
    ...process.env,
    GITHUB_REPOSITORY: "Y0UW1SH/rea",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: featureRef,
    GITHUB_SHA: controllerSha,
    GITHUB_WORKSPACE: controller,
    GITHUB_OUTPUT: join(directory, "outputs"),
    GITHUB_STEP_SUMMARY: join(directory, "summary"),
    SAAS_CANDIDATE: candidate,
    SAAS_REPORT: report,
    // Redirect only the two fixed production URLs to isolated real Git fixtures.
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: `url.${remote}.insteadOf`,
    GIT_CONFIG_VALUE_0: "https://github.com/Y0UW1SH/rea.git",
    GIT_CONFIG_KEY_1: `url.${upstream}.insteadOf`,
    GIT_CONFIG_VALUE_1: "https://github.com/morluto/rea.git",
  };
  return {
    directory,
    remote,
    upstream,
    base,
    feature,
    forkMain,
    upstreamMain,
    controllerSha,
    controller,
    candidate,
    report,
    env,
    packageManager,
  };
}

async function invoke(
  env: NodeJS.ProcessEnv,
  mode = "prepare",
  cwd = env.GITHUB_WORKSPACE ?? root,
) {
  const source =
    mode === "commands"
      ? script
      : join(cwd, "scripts/ci/saas-upstream-integration.mjs");
  return executeWorkflowFixture(process.execPath, [source, mode], { cwd, env });
}

async function readReport(path: string) {
  return reportSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

// Control command outcomes without running nested builds or a second full suite.
async function gateCommands(
  f: Awaited<ReturnType<typeof fixture>>,
  behavior = "pass",
) {
  const bin = join(f.directory, "bin");
  await mkdir(bin);
  const driver = join(f.directory, "command-fixture.mjs");
  const records = join(f.directory, "commands.jsonl");
  const barrier = join(f.directory, "barrier");
  await writeFile(
    driver,
    `
import { appendFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
const command = basename(process.argv[2]);
const args = process.argv.slice(3);
if (command === "npm" && args[0] === "--version") {
  console.log(${JSON.stringify(f.packageManager.slice(4))});
} else {
  appendFileSync(${JSON.stringify(records)}, JSON.stringify({ command, args, cwd: process.cwd() }) + "\\n");
  if (${JSON.stringify(behavior)} === "mutate" && args.join(" ") === "run knip") writeFileSync("unexpected-module.mjs", "changed");
  if (${JSON.stringify(behavior)} === "cancel") {
    process.on("SIGTERM", () => { writeFileSync(${JSON.stringify(barrier)}, "received"); process.exit(0); });
    writeFileSync(${JSON.stringify(barrier)}, "ready");
    // The handler is ready and the first command is active before cancellation.
    process.kill(process.ppid, "SIGTERM");
    setTimeout(() => process.exit(91), 3000); // Bound cleanup on a broken runner.
  }
}
`,
  );
  for (const command of ["npx", "npm", "node"]) {
    const executable = join(bin, command);
    await writeFile(
      executable,
      '#!/bin/sh\nexec "$FIXTURE_NODE" "$FIXTURE_COMMAND" "$0" "$@"\n',
    );
    await chmod(executable, 0o755);
  }
  return {
    records,
    barrier,
    env: {
      ...f.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      FIXTURE_NODE: process.execPath,
      FIXTURE_COMMAND: driver,
    },
  };
}

it("prepares the exact three-source tree without changing source branches", async () => {
  const f = await fixture();
  await invoke(f.env);
  const report = await readReport(f.report);
  expect(report.status).toBe("prepared");
  expect(report.controllerSha).toBe(f.controllerSha);
  expect(report.controllerTree).toBe(
    await workflowGit(f.controller, ["rev-parse", "HEAD^{tree}"]),
  );
  expect(report.sources).toMatchObject({
    feature: { sha: f.feature },
    forkMain: { sha: f.forkMain },
    upstreamMain: { sha: f.upstreamMain },
  });
  expect(report.merges.map((merge) => merge.name)).toEqual([
    "forkMain",
    "upstreamMain",
  ]);
  expect(report.merges[1]?.beforeSha).toBe(report.merges[0]?.resultSha);
  expect(report.candidateSha).toMatch(sha);
  expect(report.candidateTree).toBe(
    await workflowGit(f.candidate, ["rev-parse", "HEAD^{tree}"]),
  );
  for (const name of ["feature", "fork", "upstream"])
    expect(await readFile(join(f.candidate, `${name}.txt`), "utf8")).toBe(
      `${name}\n`,
    );
  expect(await workflowGit(f.remote, ["rev-parse", featureRef])).toBe(
    f.feature,
  );
  expect(await workflowGit(f.remote, ["rev-parse", "main"])).toBe(f.forkMain);
  expect(
    await workflowGit(f.candidate, [
      "config",
      "--get-regexp",
      "remote\\..*\\.url",
    ]).catch(() => ""),
  ).toBe("");
});

it.each(["forkMain", "upstreamMain"] as const)(
  "reports the %s conflict and never marks the candidate prepared",
  async (stage) => {
    const f = await fixture(stage);
    await expect(invoke(f.env)).rejects.toMatchObject({ code: 1 });
    const report = await readReport(f.report);
    expect(report.status).toBe("failed");
    expect(report.stage).toBe(`merge:${stage}`);
    expect(report.merges.at(-1)?.conflicts).toEqual(["common.txt"]);
    expect(report.candidateTree).toBeUndefined();
  },
);

it("fails closed on a missing feature ref", async () => {
  const f = await fixture();
  await workflowGit(f.remote, [
    "branch",
    "-D",
    "feat/saas-behavior-compatibility",
  ]);
  await expect(invoke(f.env)).rejects.toMatchObject({ code: 1 });
  expect(await readReport(f.report)).toMatchObject({
    status: "failed",
    stage: "resolve:feature",
  });
});

it.each(["main", "feat/saas-behavior-compatibility"])(
  "uses the exact pushed %s SHA after that remote branch advances",
  async (branch) => {
    const f = await fixture();
    const source = branch === "main" ? "forkMain" : "feature";
    const eventSha = f[source];
    const controller = f.controller;
    await workflowGit(controller, ["checkout", "--detach", eventSha]);
    await workflowGit(f.remote, ["switch", branch]);
    await writeFile(join(f.remote, "later.txt"), "not part of this event\n");
    await workflowGit(f.remote, ["add", "."]);
    await workflowGit(f.remote, ["commit", "-m", "later"]);
    await invoke(
      {
        ...f.env,
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF: `refs/heads/${branch}`,
        GITHUB_SHA: eventSha,
      },
      "prepare",
      controller,
    );
    const report = await readReport(f.report);
    expect(report.sources?.[source]?.sha).toBe(eventSha);
    expect(
      await workflowGit(f.candidate, [
        "ls-tree",
        "--name-only",
        "HEAD",
        "later.txt",
      ]),
    ).toBe("");
  },
);

it("records already-contained sources without hiding their verification requirement", async () => {
  const f = await fixture();
  await workflowGit(f.remote, ["update-ref", "refs/heads/main", f.base]);
  await workflowGit(f.upstream, ["update-ref", "refs/heads/main", f.base]);
  await invoke(f.env);
  const report = await readReport(f.report);
  expect(report.status).toBe("prepared");
  expect(report.candidateSha).toBe(f.feature);
  expect(report.merges.map((merge) => merge.alreadyIncluded)).toEqual([
    true,
    true,
  ]);
  expect(report.checks).toEqual([]);
});

it("rejects an unrelated upstream history without guessing a merge", async () => {
  const f = await fixture();
  await workflowGit(f.upstream, ["checkout", "--orphan", "unrelated"]);
  await workflowGit(f.upstream, ["commit", "-m", "unrelated"]);
  await workflowGit(f.upstream, ["update-ref", "refs/heads/main", "HEAD"]);
  await expect(invoke(f.env)).rejects.toMatchObject({ code: 1 });
  expect(await readReport(f.report)).toMatchObject({
    status: "failed",
    stage: "merge:upstreamMain",
  });
});

it("does not reuse an existing candidate directory", async () => {
  const f = await fixture();
  await mkdir(f.candidate);
  await writeFile(join(f.candidate, "keep.txt"), "owned by caller\n");
  await expect(invoke(f.env)).rejects.toMatchObject({ code: 1 });
  expect(await readFile(join(f.candidate, "keep.txt"), "utf8")).toBe(
    "owned by caller\n",
  );
  expect(await readReport(f.report)).toMatchObject({
    status: "failed",
    stage: "create-candidate",
  });
});

it.each([
  { GITHUB_EVENT_NAME: "pull_request_target" },
  { GITHUB_REF: "refs/heads/other" },
  { GITHUB_REPOSITORY: "unknown/rea" },
  { GITHUB_SHA: "--upload-pack=anything" },
])("rejects unsupported authority/input %j", async (overrides) => {
  const f = await fixture();
  await expect(invoke({ ...f.env, ...overrides })).rejects.toMatchObject({
    code: 1,
  });
  expect(await readReport(f.report)).toMatchObject({
    status: "failed",
    stage: "validate",
  });
});

it("rejects a changed candidate before executing any gate commands", async () => {
  const f = await fixture();
  await invoke(f.env);
  await writeFile(join(f.candidate, "feature.txt"), "changed\n");
  await expect(invoke(f.env, "check")).rejects.toMatchObject({ code: 1 });
  expect(await readReport(f.report)).toMatchObject({
    status: "failed",
    stage: "verify-candidate",
  });
});

it("rejects an unexpected untracked candidate module", async () => {
  const f = await fixture();
  await invoke(f.env);
  await writeFile(
    join(f.candidate, "untracked-module.mjs"),
    "throw new Error('unexpected');\n",
  );
  await expect(invoke(f.env, "check")).rejects.toMatchObject({ code: 1 });
  expect(await readReport(f.report)).toMatchObject({
    status: "failed",
    stage: "verify-candidate",
    checks: [],
  });
});

it("rejects a changed controller instead of attributing its code to a clean commit", async () => {
  const f = await fixture();
  await writeFile(join(f.controller, "common.txt"), "changed controller\n");
  await expect(invoke(f.env)).rejects.toMatchObject({ code: 1 });
  expect(await readReport(f.report)).toMatchObject({
    status: "failed",
    stage: "validate",
  });
});

it.each(["prepare", "check"])(
  "binds the executing %s helper to the tracked controller file",
  async (mode) => {
    const f = await fixture();
    if (mode === "check") await invoke(f.env);
    await expect(
      executeWorkflowFixture(process.execPath, [script, mode], {
        cwd: f.controller,
        env: f.env,
      }),
    ).rejects.toMatchObject({ code: 1 });
    expect(await readReport(f.report)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Executing helper"),
    });
  },
);

it("rejects a mismatched tree in the provenance record", async () => {
  const f = await fixture();
  await invoke(f.env);
  const report = JSON.parse(await readFile(f.report, "utf8")) as Record<
    string,
    unknown
  >;
  report.candidateTree = "a".repeat(40);
  await writeFile(f.report, JSON.stringify(report));
  await expect(invoke(f.env, "check")).rejects.toMatchObject({ code: 1 });
  expect(await readReport(f.report)).toMatchObject({
    status: "failed",
    stage: "verify-candidate",
    checks: [],
  });
});

it("rejects the wrong runtime before executing the gate", async () => {
  const f = await fixture();
  await invoke(f.env);
  const report = JSON.parse(await readFile(f.report, "utf8")) as Record<
    string,
    unknown
  >;
  report.toolchain = { node: "0.0.0", npm: f.packageManager };
  await writeFile(f.report, JSON.stringify(report));
  await expect(invoke(f.env, "check")).rejects.toMatchObject({ code: 1 });
  expect(await readReport(f.report)).toMatchObject({
    status: "failed",
    stage: "toolchain",
    checks: [],
  });
});

it.skipIf(process.platform === "win32")(
  "records a gate failure from the candidate cwd and stops before later checks",
  async () => {
    const f = await fixture();
    await invoke(f.env);
    const bin = join(f.directory, "bin");
    await mkdir(bin);
    const executable = join(bin, "npx");
    const cwdRecord = join(f.directory, "gate-cwd");
    await writeFile(
      executable,
      '#!/bin/sh\nprintf "%s" "$PWD" > "$GATE_CWD"\nexit 23\n',
    );
    await chmod(executable, 0o755);
    await expect(
      invoke(
        {
          ...f.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          GATE_CWD: cwdRecord,
        },
        "check",
      ),
    ).rejects.toMatchObject({ code: 1 });
    expect(await readFile(cwdRecord, "utf8")).toBe(f.candidate);
    expect((await readReport(f.report)).checks).toMatchObject([
      { status: "failed", exitCode: 23 },
    ]);
  },
);

it.skipIf(process.platform === "win32")(
  "marks success only after all exact commands complete in the verified candidate",
  async () => {
    const f = await fixture();
    await invoke(f.env);
    const commands = await gateCommands(f);
    await invoke(commands.env, "check");
    const report = await readReport(f.report);
    const inventory = z
      .array(z.array(z.string()))
      .parse(JSON.parse((await invoke(process.env, "commands")).stdout));
    expect(report).toMatchObject({
      status: "passed",
      stage: "complete",
      executedToolchain: { node: process.versions.node, npm: f.packageManager },
    });
    expect(report.checks.map((entry) => entry.command)).toEqual(inventory);
    expect(
      report.checks.every(
        (entry) => entry.status === "passed" && entry.exitCode === 0,
      ),
    ).toBe(true);
    const executions = (await readFile(commands.records, "utf8"))
      .trim()
      .split("\n")
      .map((line) => z.object({ cwd: z.string() }).parse(JSON.parse(line)));
    expect(executions).toHaveLength(inventory.length);
    expect(executions.every((entry) => entry.cwd === f.candidate)).toBe(true);
  },
);

it.skipIf(process.platform === "win32")(
  "rejects candidate mutation by a successful final command",
  async () => {
    const f = await fixture();
    await invoke(f.env);
    const commands = await gateCommands(f, "mutate");
    await expect(invoke(commands.env, "check")).rejects.toMatchObject({
      code: 1,
    });
    expect(await readReport(f.report)).toMatchObject({
      status: "failed",
      stage: "verify-candidate",
    });
  },
);

it.skipIf(process.platform === "win32")(
  "forwards SIGTERM, settles the command and cannot advance or pass after cancellation",
  async () => {
    const f = await fixture();
    await invoke(f.env);
    const commands = await gateCommands(f, "cancel");
    await expect(invoke(commands.env, "check")).rejects.toMatchObject({
      code: 143,
    });
    expect(await readFile(commands.barrier, "utf8")).toBe("received");
    const report = await readReport(f.report);
    expect(report.status).toBe("cancelled");
    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]).toMatchObject({
      status: "cancelled",
      exitCode: 143,
    });
  },
);

it("preserves provenance when writing the presentation summary fails", async () => {
  const f = await fixture();
  await invoke(f.env);
  const before = await readFile(f.report, "utf8");
  await expect(
    invoke(
      {
        ...f.env,
        GITHUB_STEP_SUMMARY: join(f.directory, "missing", "summary"),
      },
      "report",
    ),
  ).rejects.toMatchObject({ code: 1 });
  expect(await readFile(f.report, "utf8")).toBe(before);
});

it("never overwrites controller files through an invalid report path", async () => {
  const f = await fixture();
  const owned = join(f.controller, "common.txt");
  const before = await readFile(owned, "utf8");
  await expect(invoke({ ...f.env, SAAS_REPORT: owned })).rejects.toMatchObject({
    code: 1,
  });
  expect(await readFile(owned, "utf8")).toBe(before);
});

it("preserves an existing caller-owned report on failed preparation", async () => {
  const f = await fixture();
  await writeFile(f.report, "caller-owned record\n");
  await expect(
    invoke({ ...f.env, GITHUB_SHA: "invalid" }),
  ).rejects.toMatchObject({ code: 1 });
  expect(await readFile(f.report, "utf8")).toBe("caller-owned record\n");
});

it("preserves controller bytes when a prepared report is hard-linked into its checkout", async () => {
  const f = await fixture();
  await invoke(f.env);
  const owned = join(f.controller, "common.txt");
  await unlink(owned);
  await link(f.report, owned);
  const before = await readFile(owned, "utf8");
  await expect(invoke(f.env, "check")).rejects.toMatchObject({ code: 1 });
  expect(await readFile(owned, "utf8")).toBe(before);
  expect(await readFile(f.report, "utf8")).toBe(before);
});

it("preserves all existing SaaS workflow commands and adds a read-only manual/push workflow", async () => {
  const { stdout } = await invoke(process.env, "commands");
  const commands = z
    .array(z.array(z.string()))
    .parse(JSON.parse(stdout))
    .map((command) => command.join(" "));
  const workflowSchema = z.object({
    on: z.record(z.string(), z.unknown()),
    permissions: z.record(z.string(), z.string()),
    jobs: z.record(
      z.string(),
      z.object({
        steps: z.array(
          z.object({
            run: z.string().optional(),
            uses: z.string().optional(),
            with: z.record(z.string(), z.unknown()).optional(),
            "working-directory": z.string().optional(),
          }),
        ),
      }),
    ),
  });
  const existing = workflowSchema.parse(
    parse(
      await readFile(
        join(root, ".github/workflows/saas-compatibility.yml"),
        "utf8",
      ),
    ),
  );
  for (const step of existing.jobs["saas-compatibility"]?.steps ?? []) {
    if (
      step.run?.startsWith("npx ") ||
      step.run?.startsWith("npm run ") ||
      step.run?.startsWith("node scripts/")
    )
      expect(commands).toContain(step.run.replace(/\s+/gu, " ").trim());
  }
  const source = await readFile(
    join(root, ".github/workflows/saas-upstream-integration.yml"),
    "utf8",
  );
  const workflow = workflowSchema.parse(parse(source));
  expect(Object.keys(workflow.on).sort()).toEqual([
    "push",
    "workflow_dispatch",
  ]);
  expect(workflow.on.push).toEqual({
    branches: ["main", "feat/saas-behavior-compatibility"],
  });
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(source).not.toMatch(
    /secrets\.|write|actions\/cache|download-artifact|upload-artifact|id-token/u,
  );
  const checkout = Object.values(workflow.jobs)
    .flatMap((job) => job.steps)
    .find((step) => step.uses?.startsWith("actions/checkout@"));
  expect(checkout?.with?.["persist-credentials"]).toBe(false);
  expect(checkout?.with?.ref).toBe("${{ github.sha }}");
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
  expect(
    steps.find((step) => step.uses?.startsWith("actions/setup-node@"))?.with?.[
      "node-version-file"
    ],
  ).toBe("candidate/.nvmrc");
  for (const mode of ["prepare", "check", "report"])
    expect(
      steps.find(
        (step) =>
          step.run === `node scripts/ci/saas-upstream-integration.mjs ${mode}`,
      )?.["working-directory"],
    ).toBe("controller");
  expect(
    steps.find((step) => step.run === "npm ci")?.["working-directory"],
  ).toBe("candidate");
});
