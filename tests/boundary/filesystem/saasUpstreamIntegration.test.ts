import { spawn } from "node:child_process";
import {
  chmod,
  link,
  mkdir,
  readFile,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it, vi } from "vitest";
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
  controllerHelperBlob: z.string().optional(),
  candidateHelperBlob: z.string().optional(),
  controllerHelperMode: z.string().optional(),
  candidateHelperMode: z.string().optional(),
  event: z
    .object({
      name: z.string(),
      ref: z.string(),
      sha: z.string(),
      pullRequest: z
        .object({
          number: z.number(),
          base: z.object({
            repository: z.string(),
            ref: z.string(),
            sha: z.string(),
          }),
          head: z.object({
            repository: z.string(),
            ref: z.string(),
            sha: z.string(),
          }),
        })
        .optional(),
    })
    .optional(),
  sources: z
    .record(z.string(), z.object({ sha: z.string(), observedSha: z.string() }))
    .optional(),
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
  for (const path of [
    "scripts/run-exclusive.mjs",
    "scripts/run-exclusive-command.mjs",
    "scripts/lib/windows-owned-command.mjs",
    ".github/workflows/saas-compatibility.yml",
  ]) {
    await mkdir(join(remote, path, ".."), { recursive: true });
    const content = await readFile(join(root, path), "utf8");
    // Start the isolated fixture without the optional study feature, even when
    // the real checkout contains it; dedicated cases add both halves explicitly.
    await writeFile(
      join(remote, path),
      path.endsWith("saas-compatibility.yml")
        ? content.replace(
            /^.*tests\/boundary\/cli\/saasStudy\.test\.ts.*\n/gmu,
            "",
          )
        : content,
    );
  }
  await writeFile(join(remote, ".gitignore"), "node_modules\n.cache/\n");
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
  await workflowGit(controller, ["checkout", "--detach", feature]);
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

async function pullRequestFixture(
  target: "main" | "feat/saas-behavior-compatibility",
  headRepository = "Y0UW1SH/rea",
  headBranch = "hardening",
) {
  const f = await fixture();
  const baseSha = target === "main" ? f.forkMain : f.feature;
  const headBase =
    headBranch === "feat/saas-behavior-compatibility"
      ? f.feature
      : headBranch === "main"
        ? f.forkMain
        : baseSha;
  await workflowGit(f.remote, ["checkout", "-B", headBranch, headBase]);
  await writeFile(join(f.remote, "pr-only.txt"), "this PR must be checked\n");
  await workflowGit(f.remote, ["add", "."]);
  await workflowGit(f.remote, ["commit", "-m", "PR-only sentinel"]);
  const headSha = await workflowGit(f.remote, ["rev-parse", "HEAD"]);
  await workflowGit(f.remote, ["checkout", "--detach", baseSha]);
  await workflowGit(f.remote, ["merge", "--no-ff", "--no-edit", headSha]);
  const mergeSha = await workflowGit(f.remote, ["rev-parse", "HEAD"]);
  await workflowGit(f.remote, ["update-ref", "refs/pull/7/merge", mergeSha]);
  // Match actions/checkout's shallow merge checkout, whose %P is empty.
  await workflowGit(f.controller, ["fetch", "--depth=1", f.remote, mergeSha]);
  await workflowGit(f.controller, ["checkout", "--detach", mergeSha]);
  const eventPath = join(f.directory, "event.json");
  const payload = {
    number: 7,
    repository: { full_name: "Y0UW1SH/rea" },
    pull_request: {
      number: 7,
      base: { repo: { full_name: "Y0UW1SH/rea" }, ref: target, sha: baseSha },
      head: {
        repo: { full_name: headRepository },
        ref: headBranch,
        sha: headSha,
      },
    },
  };
  await writeFile(eventPath, JSON.stringify(payload));
  return {
    ...f,
    payload,
    eventPath,
    baseSha,
    headSha,
    mergeSha,
    env: {
      ...f.env,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REF: "refs/pull/7/merge",
      GITHUB_SHA: mergeSha,
      GITHUB_EVENT_PATH: eventPath,
    },
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
  try {
    await symlink(
      join(root, "node_modules"),
      join(f.candidate, "node_modules"),
      "junction",
    );
  } catch (error) {
    // Prepare-failure fixtures have no candidate and never execute commands.
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
  }
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
  expect(report.controllerHelperBlob).toMatch(sha);
  expect(report.candidateHelperBlob).toBe(report.controllerHelperBlob);
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
  // The candidate honours the host's checkout conversion (CRLF on Windows Git).
  for (const name of ["feature", "fork", "upstream"])
    expect(
      (await readFile(join(f.candidate, `${name}.txt`), "utf8")).replaceAll(
        "\r\n",
        "\n",
      ),
    ).toBe(`${name}\n`);
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

it.each([
  ["push", "main"],
  ["push", "feat/saas-behavior-compatibility"],
  ["workflow_dispatch", "main"],
  ["workflow_dispatch", "feat/saas-behavior-compatibility"],
])(
  "uses the exact %s %s SHA after that remote branch advances",
  async (event, branch) => {
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
        GITHUB_EVENT_NAME: event,
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

it.each(["main", "feat/saas-behavior-compatibility"] as const)(
  "includes the exact PR merge into %s even after its base and head refs advance",
  async (target) => {
    const f = await pullRequestFixture(target);
    for (const branch of [target, "hardening"]) {
      await workflowGit(f.remote, ["checkout", branch]);
      await writeFile(join(f.remote, "later.txt"), "outside this event\n");
      await workflowGit(f.remote, ["add", "."]);
      await workflowGit(f.remote, ["commit", "-m", "later change"]);
    }
    await invoke(f.env);
    const report = await readReport(f.report);
    const selected = target === "main" ? "forkMain" : "feature";
    expect(report.sources?.[selected]?.sha).toBe(f.mergeSha);
    expect(report.sources?.[selected]?.observedSha).not.toBe(f.baseSha);
    expect(report.event?.pullRequest).toEqual({
      number: 7,
      base: { repository: "Y0UW1SH/rea", ref: target, sha: f.baseSha },
      head: { repository: "Y0UW1SH/rea", ref: "hardening", sha: f.headSha },
    });
    expect(await workflowGit(f.candidate, ["show", "HEAD:pr-only.txt"])).toBe(
      "this PR must be checked",
    );
    expect(
      await workflowGit(f.candidate, [
        "ls-tree",
        "--name-only",
        "HEAD",
        "later.txt",
      ]),
    ).toBe("");
    expect(
      await workflowGit(f.controller, ["rev-parse", "--is-shallow-repository"]),
    ).toBe("true");
  },
);

it.each([
  ["main", "feat/saas-behavior-compatibility", "Y0UW1SH/rea"],
  ["feat/saas-behavior-compatibility", "main", "Y0UW1SH/rea"],
  ["main", "feat/saas-behavior-compatibility", "external/rea"],
] as const)(
  "binds the PR into %s from %s only when its repository matches (%s)",
  async (target, headBranch, headRepository) => {
    const f = await pullRequestFixture(target, headRepository, headBranch);
    await workflowGit(f.remote, ["checkout", headBranch]);
    await writeFile(join(f.remote, "later-feature.txt"), "later feature\n");
    await workflowGit(f.remote, ["add", "."]);
    await workflowGit(f.remote, ["commit", "-m", "advance feature"]);
    const advanced = await workflowGit(f.remote, ["rev-parse", "HEAD"]);
    await invoke(f.env);
    const report = await readReport(f.report);
    expect(
      report.sources?.[headBranch === "main" ? "forkMain" : "feature"],
    ).toEqual({
      observedSha: advanced,
      sha: headRepository === "Y0UW1SH/rea" ? f.headSha : advanced,
    });
    expect(await workflowGit(f.candidate, ["show", "HEAD:pr-only.txt"])).toBe(
      "this PR must be checked",
    );
  },
);

it.each([
  "number",
  "ref",
  "repository",
  "target",
  "baseSha",
  "headSha",
  "parents",
  "missingEvent",
])(
  "rejects invalid PR %s provenance before creating a candidate",
  async (invalid) => {
    const f = await pullRequestFixture("feat/saas-behavior-compatibility");
    if (invalid === "number") f.payload.pull_request.number = 8;
    if (invalid === "ref") f.env.GITHUB_REF = "refs/pull/8/merge";
    if (invalid === "repository")
      f.payload.pull_request.base.repo.full_name = "external/rea";
    if (invalid === "baseSha") f.payload.pull_request.base.sha = "not-a-sha";
    if (invalid === "headSha") f.payload.pull_request.head.sha = f.baseSha;
    if (invalid === "parents") {
      await workflowGit(f.controller, ["fetch", f.remote, f.headSha]);
      await workflowGit(f.controller, ["checkout", "--detach", f.headSha]);
      f.env.GITHUB_SHA = f.headSha;
    }
    if (invalid === "missingEvent")
      f.env.GITHUB_EVENT_PATH = join(f.directory, "missing.json");
    await writeFile(
      f.eventPath,
      JSON.stringify(
        invalid === "target"
          ? {
              ...f.payload,
              pull_request: {
                ...f.payload.pull_request,
                base: { ...f.payload.pull_request.base, ref: "other" },
              },
            }
          : f.payload,
      ),
    );
    await expect(invoke(f.env)).rejects.toMatchObject({ code: 1 });
    expect(await readReport(f.report)).toMatchObject({
      status: "failed",
      stage: "validate",
      checks: [],
    });
    await expect(
      readFile(join(f.candidate, "pr-only.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
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

it.skipIf(process.platform === "win32").each(["prepare", "check"] as const)(
  "rejects a candidate-only required gate during %s before an older controller can omit it",
  async (mode) => {
    const f = await fixture();
    if (mode === "check") await invoke(f.env);
    const changed = mode === "prepare" ? f.remote : f.candidate;
    const helperPath = "scripts/ci/saas-upstream-integration.mjs";
    const source = await readFile(join(changed, helperPath), "utf8");
    await writeFile(
      join(changed, helperPath),
      source.replace(
        "const commands = [",
        'const commands = [\n  ["node", "scripts/required-sync-regression.mjs"],',
      ),
    );
    await writeFile(
      join(changed, "scripts/required-sync-regression.mjs"),
      'throw new Error("Required sync regression must fail");\n',
    );
    await workflowGit(changed, ["add", "."]);
    await workflowGit(changed, [
      "commit",
      "-m",
      "add required sync regression",
    ]);
    if (mode === "check") {
      const prepared = JSON.parse(await readFile(f.report, "utf8")) as Record<
        string,
        unknown
      >;
      // Keep the stale matching helper claim while naming the changed candidate.
      // This must reach helper revalidation, not only the existing tree guard.
      prepared.candidateSha = await workflowGit(f.candidate, [
        "rev-parse",
        "HEAD",
      ]);
      prepared.candidateTree = await workflowGit(f.candidate, [
        "rev-parse",
        "HEAD^{tree}",
      ]);
      prepared.controllerHelperBlob = await workflowGit(f.controller, [
        "rev-parse",
        `HEAD:${helperPath}`,
      ]);
      prepared.candidateHelperBlob = prepared.controllerHelperBlob;
      await writeFile(f.report, JSON.stringify(prepared));
    }
    const commands = await gateCommands(f);
    await expect(invoke(commands.env, mode)).rejects.toMatchObject({
      code: 1,
    });
    await expect(
      executeWorkflowFixture(
        process.execPath,
        ["scripts/required-sync-regression.mjs"],
        { cwd: f.candidate },
      ),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Required sync regression must fail"),
    });
    const report = await readReport(f.report);
    expect(report).toMatchObject({
      status: "failed",
      stage: "verify-candidate-helper",
      controllerHelperBlob: await workflowGit(f.controller, [
        "rev-parse",
        `HEAD:${helperPath}`,
      ]),
      candidateHelperBlob: await workflowGit(f.candidate, [
        "rev-parse",
        `HEAD:${helperPath}`,
      ]),
      checks: [],
      error: expect.stringContaining("reviewed controller"),
    });
    expect(report.candidateHelperBlob).not.toBe(report.controllerHelperBlob);
    await expect(readFile(commands.records, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    if (mode === "prepare")
      await expect(readFile(f.env.GITHUB_OUTPUT, "utf8")).rejects.toMatchObject(
        { code: "ENOENT" },
      );
  },
);

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

it("rejects a candidate-only helper mode change even with identical content", async () => {
  const f = await fixture();
  await workflowGit(f.remote, [
    "update-index",
    "--chmod=+x",
    "scripts/ci/saas-upstream-integration.mjs",
  ]);
  await workflowGit(f.remote, ["commit", "-m", "change helper mode"]);
  await expect(invoke(f.env)).rejects.toMatchObject({ code: 1 });
  const report = await readReport(f.report);
  expect(report).toMatchObject({
    status: "failed",
    stage: "verify-candidate-helper",
    controllerHelperMode: "100644",
    candidateHelperMode: "100755",
    checks: [],
  });
  expect(report.candidateHelperBlob).toBe(report.controllerHelperBlob);
});

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
    await symlink(
      join(root, "node_modules"),
      join(f.candidate, "node_modules"),
      "junction",
    );
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
      .parse(JSON.parse((await invoke(f.env, "commands")).stdout));
    expect(report).toMatchObject({
      status: "passed",
      stage: "complete",
      executedToolchain: { node: process.versions.node, npm: f.packageManager },
    });
    expect(report.controllerHelperBlob).toMatch(sha);
    expect(report.candidateHelperBlob).toBe(report.controllerHelperBlob);
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

it.skipIf(process.platform === "win32").each(["SIGINT", "SIGTERM"] as const)(
  "settles real npx descendants before reporting %s cancellation",
  async (signal) => {
    const f = await fixture();
    await invoke(f.env);
    await mkdir(join(f.candidate, "node_modules/.bin"), { recursive: true });
    await symlink(
      join(root, "node_modules/cross-spawn"),
      join(f.candidate, "node_modules/cross-spawn"),
      "junction",
    );
    const ready = join(f.directory, "descendant-ready");
    const late = join(f.directory, "descendant-outlived-owner");
    const executable = join(f.candidate, "node_modules/.bin/oxfmt");
    await writeFile(
      executable,
      `#!${process.execPath}
const fs = require("node:fs");
process.on("SIGTERM", () => {});
process.on("SIGINT", () => {});
fs.writeFileSync(${JSON.stringify(ready)}, "ready");
setTimeout(() => { fs.writeFileSync(${JSON.stringify(late)}, "escaped"); process.exit(0); }, 2500);
`,
    );
    await chmod(executable, 0o755);
    const child = spawn(
      process.execPath,
      [join(f.controller, "scripts/ci/saas-upstream-integration.mjs"), "check"],
      {
        cwd: f.controller,
        env: f.env,
        stdio: "ignore",
      },
    );
    const closed = new Promise((resolveCode, reject) => {
      child.once("error", reject);
      child.once("close", resolveCode);
    });
    try {
      await vi.waitFor(
        async () => expect(await readFile(ready, "utf8")).toBe("ready"),
        { timeout: 5000 },
      );
      child.kill(signal);
      expect(await closed).toBe(signal === "SIGINT" ? 130 : 143);
      const report = await readReport(f.report);
      expect(report.status).toBe("cancelled");
      expect(report.checks).toHaveLength(1);
      expect(report.checks[0]).toMatchObject({
        status: "cancelled",
        exitCode: signal === "SIGINT" ? 130 : 143,
      });
      // The bounded fixture writes after 2.5s if only npx, rather than its owned
      // process group, was stopped. Wait beyond that deadline on broken code.
      await new Promise((resolveWait) => setTimeout(resolveWait, 2800));
      await expect(readFile(late)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
      await closed;
    }
  },
  15000,
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

const studyTest = "tests/boundary/cli/saasStudy.test.ts";
const focusedWorkflow = ".github/workflows/saas-compatibility.yml";

async function addStudyInventory(
  directory: string,
  file: boolean,
  declaration: boolean,
) {
  if (file) {
    await mkdir(join(directory, "tests/boundary/cli"), { recursive: true });
    await writeFile(join(directory, studyTest), "// study fixture\n");
  }
  if (declaration) {
    const source = await readFile(join(directory, focusedWorkflow), "utf8");
    await writeFile(
      join(directory, focusedWorkflow),
      source.replace(
        "tests/boundary/cli/saasSurfaceCoverage.test.ts",
        `tests/boundary/cli/saasSurfaceCoverage.test.ts\n          ${studyTest}`,
      ),
    );
  }
}

it.each([false, true])(
  "selects the complete declared study inventory when present=%s",
  async (present) => {
    const f = await fixture();
    await addStudyInventory(f.controller, present, present);
    const { stdout } = await invoke(f.env, "commands");
    const inventory = z.array(z.array(z.string())).parse(JSON.parse(stdout));
    expect(inventory.flat().includes(studyTest)).toBe(present);
  },
);

it.each([
  [true, false],
  [false, true],
])(
  "rejects one-sided study inventory drift (file=%s, declaration=%s)",
  async (file, declaration) => {
    const f = await fixture();
    await addStudyInventory(f.controller, file, declaration);
    await expect(invoke(f.env, "commands")).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Study test inventory differs"),
    });
  },
);

it("rejects a non-regular declared study test", async () => {
  const f = await fixture();
  await addStudyInventory(f.controller, false, true);
  await mkdir(join(f.controller, studyTest), { recursive: true });
  await expect(invoke(f.env, "commands")).rejects.toMatchObject({ code: 1 });
});

it.skipIf(process.platform === "win32")(
  "uses the candidate study inventory even when the controller lacks it",
  async () => {
    const f = await fixture();
    await addStudyInventory(f.upstream, true, true);
    await workflowGit(f.upstream, ["add", "."]);
    await workflowGit(f.upstream, ["commit", "-m", "add study coverage"]);
    await workflowGit(f.upstream, ["branch", "-f", "main", "HEAD"]);
    await invoke(f.env);
    const commands = await gateCommands(f);
    await invoke(commands.env, "check");
    const report = await readReport(f.report);
    expect(report.status).toBe("passed");
    expect(report.checks.flatMap((entry) => entry.command)).toContain(
      studyTest,
    );
  },
);

it("preserves all SaaS workflow commands and a read-only PR/manual/push workflow", async () => {
  // GitHub's outer workspace differs from the candidate checkout in the
  // combined workflow. Real-source inspection must use this checkout's root.
  const outerWorkspace = await createTestTempDirectory("rea-saas-outer-");
  const { stdout } = await invoke(
    { ...process.env, GITHUB_WORKSPACE: outerWorkspace },
    "commands",
    root,
  );
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
    "pull_request",
    "push",
    "workflow_dispatch",
  ]);
  expect(workflow.on.push).toEqual({
    branches: ["main", "feat/saas-behavior-compatibility"],
  });
  expect(workflow.on.pull_request).toEqual({
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
