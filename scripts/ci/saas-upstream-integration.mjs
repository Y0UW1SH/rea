import { execFile, spawn } from "node:child_process";
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const fork = "Y0UW1SH/rea";
const featureRef = "refs/heads/feat/saas-behavior-compatibility";
const helperPath = "scripts/ci/saas-upstream-integration.mjs";
const shaPattern = /^[0-9a-f]{40}$/u;
const commands = [
  [
    "npx",
    "--no-install",
    "oxfmt",
    "--check",
    "README.md",
    "docs/saas-change-ledger.md",
    ".github/workflows/saas-compatibility.yml",
  ],
  ["npm", "run", "test:saas"],
  [
    "npm",
    "run",
    "test:local",
    "--",
    "src/domain/browserScenarioDiff.test.ts",
    "tests/conformance/managedSkillInventory.test.ts",
    "tests/conformance/readmeConsistency.test.ts",
  ],
  [
    "node",
    "scripts/run-exact-tests.mjs",
    "run",
    "tests/boundary/filesystem/workflowActionPinning.test.ts",
    "tests/boundary/filesystem/workflowForkSafety.test.ts",
  ],
  [
    "npm",
    "run",
    "test:focused",
    "--",
    "tests/boundary/cli/browserCli.test.ts",
    "tests/boundary/mcp/browserScenarioMcp.test.ts",
    "tests/boundary/cli/saasCompatibility.test.ts",
    "tests/boundary/cli/saasCompatibilityLab.test.ts",
    "tests/boundary/cli/saasProductProfile.test.ts",
    "tests/boundary/cli/saasExportCompare.test.ts",
    "tests/boundary/cli/saasApiContract.test.ts",
    "tests/boundary/cli/saasSurfaceCoverage.test.ts",
    "tests/boundary/filesystem/saasSurfaceFixtures.test.ts",
    "tests/acceptance/setup/selectedSkillSetup.test.ts",
    "tests/boundary/filesystem/setupSkill.test.ts",
    "tests/boundary/filesystem/qwenClientConfiguration.test.ts",
  ],
  [
    "npm",
    "run",
    "test:focused",
    "--",
    "src/browser/PlaywrightBrowserScenarioProvider.test.ts",
    "src/browser/PlaywrightScenarioBrowser.test.ts",
    "src/browser/PlaywrightScenarioSession.test.ts",
    "tests/boundary/process/browserScenarioProbeLifecycle.test.ts",
    "tests/process-global/browserScenarioCleanup.test.ts",
    "tests/acceptance/browser/browserScenarioCancellationCli.test.ts",
  ],
  [
    "node",
    "scripts/run-exact-tests.mjs",
    "run",
    "tests/boundary/filesystem/saasUpstreamIntegration.test.ts",
  ],
  ["npm", "run", "check:fast"],
  ["npm", "run", "docs:check"],
  ["npm", "run", "format:check"],
  ["npm", "run", "knip"],
];

async function selectedCommands(directory) {
  const studyTest = "tests/boundary/cli/saasStudy.test.ts";
  let present = false;
  try {
    const metadata = await lstat(resolve(directory, studyTest));
    if (!metadata.isFile())
      throw new Error("Study test must be a regular file");
    present = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const workflow = await readFile(
    resolve(directory, ".github/workflows/saas-compatibility.yml"),
    "utf8",
  );
  const declared = workflow.split(/\s+/u).includes(studyTest);
  if (present !== declared)
    throw new Error(
      "Study test inventory differs between the file and focused workflow",
    );
  // Only this known companion suite is conditional. The full workflow command
  // mirror remains mandatory and rejects any other missing or changed command.
  return commands.map((command) =>
    command.flatMap((argument) =>
      present && argument === "tests/boundary/cli/saasSurfaceCoverage.test.ts"
        ? [argument, studyTest]
        : [argument],
    ),
  );
}

const [mode, ...extra] = process.argv.slice(2);
const candidate = resolve(process.env.SAAS_CANDIDATE ?? "candidate");
const reportPath = resolve(process.env.SAAS_REPORT ?? "saas-integration.json");
let ownsReport = false;
let gateChild;
let shutdownSignal;
const signalExitCodes = { SIGINT: 130, SIGTERM: 143 };
if (mode === "check")
  for (const signal of Object.keys(signalExitCodes))
    process.on(signal, () => {
      if (shutdownSignal) return;
      shutdownSignal = signal;
      if (
        gateChild &&
        gateChild.exitCode === null &&
        gateChild.signalCode === null
      ) {
        // The owned-command supervisor retains its group/job identity through
        // forced cleanup. Do not kill its wrapper early and orphan descendants.
        gateChild.kill(signal);
      }
    });
let report = {
  schemaVersion: 1,
  status: "incomplete",
  stage: "validate",
  merges: [],
  checks: [],
};

async function save() {
  if (!ownsReport) throw new Error("Report is not owned by this operation");
  await verifyReportPlacement();
  await verifyReportFile();
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

async function verifyReportFile() {
  const metadata = await lstat(reportPath);
  if (!metadata.isFile() || metadata.nlink !== 1)
    throw new Error("Report must be a regular file without hard links");
}

function within(path, directory) {
  const inside = relative(directory, path);
  return (
    inside === "" ||
    (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
  );
}

async function canonicalLocation(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return resolve(await realpath(dirname(path)), basename(path));
  }
}

async function verifyReportPlacement() {
  const [controllerPath, candidatePath, outputPath] = await Promise.all([
    realpath(process.cwd()),
    canonicalLocation(candidate),
    canonicalLocation(reportPath),
  ]);
  if (within(outputPath, controllerPath) || within(outputPath, candidatePath))
    throw new Error("Report must be outside controller and candidate");
  if (within(controllerPath, candidatePath))
    throw new Error("Controller must be outside candidate");
}

function requireRunning() {
  if (shutdownSignal) throw new Error(`Cancelled by ${shutdownSignal}`);
}

async function runGate(args) {
  requireRunning();
  return new Promise((resolveCode, reject) => {
    gateChild = spawn(
      process.execPath,
      [
        resolve(candidate, "scripts/run-exclusive.mjs"),
        "saas-integration",
        ...args,
      ],
      {
        cwd: candidate,
        stdio: "inherit",
        env: { ...process.env, HUSKY: "0" },
      },
    );
    gateChild.once("error", reject);
    gateChild.once("close", (exitCode) => {
      gateChild = undefined;
      resolveCode(
        shutdownSignal ? signalExitCodes[shutdownSignal] : (exitCode ?? 1),
      );
    });
  });
}

async function git(args, cwd = candidate, raw = false) {
  const { stdout } = await execute(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=REA integration check",
      "-c",
      "user.email=integration@example.invalid",
      ...args,
    ],
    { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 120_000 },
  );
  return raw ? stdout : stdout.trim();
}

function requireSha(value) {
  if (!shaPattern.test(value ?? ""))
    throw new Error("Expected a full lowercase commit SHA");
  return value;
}

async function ancestor(older, newer) {
  try {
    await git(["merge-base", "--is-ancestor", older, newer]);
    return true;
  } catch (error) {
    if (error.code === 1) return false;
    throw error;
  }
}

async function verifyExecutingHelper() {
  const expected = resolve(process.cwd(), helperPath);
  if (
    !(await lstat(expected)).isFile() ||
    (await realpath(fileURLToPath(import.meta.url))) !==
      (await realpath(expected))
  )
    throw new Error("Executing helper must be the controller's tracked script");
  await git(["ls-files", "--error-unmatch", "--", helperPath], process.cwd());
}

async function verifyCandidateHelper() {
  report.stage = "verify-candidate-helper";
  for (const [name, cwd] of [
    ["controller", process.cwd()],
    ["candidate", candidate],
  ]) {
    const entry = await git(
      ["ls-tree", "-z", "HEAD", "--", helperPath],
      cwd,
      true,
    );
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t([^\0]+)\0$/u.exec(
      entry,
    );
    if (!match || match[3] !== helperPath)
      throw new Error("Integration helper must be a tracked regular file");
    report[`${name}HelperMode`] = match[1];
    report[`${name}HelperBlob`] = match[2];
  }
  // The controller owns execution. A candidate's self-tests cannot establish
  // that an older controller retained newly merged commands or helper guards.
  if (
    report.controllerHelperBlob !== report.candidateHelperBlob ||
    report.controllerHelperMode !== report.candidateHelperMode
  )
    throw new Error(
      "Candidate integration helper differs; use a reviewed controller containing the merged gate changes",
    );
}

async function eventIdentity(name, ref, sha, controller) {
  const event = { name, ref, sha };
  if (name !== "pull_request") return event;
  const payload = JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      await readFile(process.env.GITHUB_EVENT_PATH),
    ),
  );
  const pr = payload?.pull_request;
  if (
    !Number.isSafeInteger(payload?.number) ||
    payload.number <= 0 ||
    pr?.number !== payload.number ||
    ref !== `refs/pull/${payload.number}/merge` ||
    payload.repository?.full_name !== fork ||
    pr.base?.repo?.full_name !== fork ||
    !["main", "feat/saas-behavior-compatibility"].includes(pr.base?.ref) ||
    typeof pr.head?.repo?.full_name !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(pr.head.repo.full_name) ||
    typeof pr.head?.ref !== "string"
  )
    throw new Error("Unsupported pull request identity");
  await git(["check-ref-format", `refs/heads/${pr.head.ref}`], controller);
  event.pullRequest = {
    number: payload.number,
    base: { repository: fork, ref: pr.base.ref, sha: requireSha(pr.base.sha) },
    head: {
      repository: pr.head.repo.full_name,
      ref: pr.head.ref,
      sha: requireSha(pr.head.sha),
    },
  };
  // checkout's depth-one boundary hides parents from revision walking (%P).
  // Read only the raw commit headers, never the commit message or a later ref.
  const headers = (await git(["cat-file", "-p", sha], controller, true)).split(
    "\n\n",
    1,
  )[0];
  const parents = headers
    .split("\n")
    .filter((line) => line.startsWith("parent "))
    .map((line) => line.slice(7));
  if (
    parents.length !== 2 ||
    parents[0] !== pr.base.sha ||
    parents[1] !== pr.head.sha
  )
    throw new Error(
      "Controller merge parents do not match the pull request event",
    );
  return event;
}

function selectedSourceSha(owner, sourceRef, observedSha) {
  if (owner !== fork) return observedSha;
  const { ref, sha, pullRequest } = report.event;
  if (!pullRequest) return sourceRef === ref ? sha : observedSha;
  if (sourceRef === `refs/heads/${pullRequest.base.ref}`) return sha;
  if (
    pullRequest.head.repository === fork &&
    sourceRef === `refs/heads/${pullRequest.head.ref}`
  )
    return pullRequest.head.sha;
  return observedSha;
}

async function prepare() {
  const {
    GITHUB_EVENT_NAME: event,
    GITHUB_REF: ref,
    GITHUB_SHA: eventSha,
    GITHUB_REPOSITORY: repository,
  } = process.env;
  if (
    repository !== fork ||
    !["push", "workflow_dispatch", "pull_request"].includes(event) ||
    (event !== "pull_request" && ![featureRef, "refs/heads/main"].includes(ref))
  )
    throw new Error("Unsupported repository, event or branch");
  requireSha(eventSha);
  await verifyExecutingHelper();
  const controller = process.cwd();
  report.controllerSha = requireSha(
    await git(["rev-parse", "HEAD"], controller),
  );
  report.controllerTree = requireSha(
    await git(["rev-parse", "HEAD^{tree}"], controller),
  );
  if (report.controllerSha !== eventSha)
    throw new Error("Controller checkout does not match the triggering SHA");
  if (await git(["status", "--porcelain", "--untracked-files=all"], controller))
    throw new Error("Controller checkout must be clean");
  report.event = await eventIdentity(event, ref, eventSha, controller);
  report.observedAt = new Date().toISOString();
  await snapshotSources(controller);
  report.stage = "create-candidate";
  await save();
  await mkdir(candidate); // Never reuse/reset an existing directory or checkout.
  await git(["init", "--quiet"]);
  for (const [name, source] of Object.entries(report.sources)) {
    report.stage = `fetch:${name}`;
    await save();
    await git([
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      `https://github.com/${source.repository}.git`,
      source.sha,
    ]);
    if ((await git(["rev-parse", "FETCH_HEAD^{commit}"])) !== source.sha)
      throw new Error(`Fetched ${name} does not match the snapshot`);
  }
  await git(["checkout", "--detach", report.sources.feature.sha]);
  await mergeSources();
  report.candidateSha = requireSha(await git(["rev-parse", "HEAD"]));
  report.candidateTree = requireSha(await git(["rev-parse", "HEAD^{tree}"]));
  await verifyCandidateHelper();
  report.stage = "toolchain";
  const nodeVersion = (
    await readFile(resolve(candidate, ".nvmrc"), "utf8")
  ).trim();
  const { packageManager } = JSON.parse(
    await readFile(resolve(candidate, "package.json"), "utf8"),
  );
  if (
    !/^\d+\.\d+\.\d+$/u.test(nodeVersion) ||
    !/^npm@\d+\.\d+\.\d+$/u.test(packageManager ?? "")
  )
    throw new Error("Expected exact Node and npm versions");
  report.toolchain = { node: nodeVersion, npm: packageManager };
  report.status = "prepared"; // Preparation alone is never a passing gate.
  await save();
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `npm_spec=${packageManager}\n`);
}

async function snapshotSources(controller) {
  report.sources = {};
  for (const [name, owner, sourceRef] of [
    ["feature", fork, featureRef],
    ["forkMain", fork, "refs/heads/main"],
    ["upstreamMain", "morluto/rea", "refs/heads/main"],
  ]) {
    report.stage = `resolve:${name}`;
    const url = `https://github.com/${owner}.git`;
    const listing = await git(
      ["ls-remote", "--exit-code", "--refs", url, sourceRef],
      controller,
    );
    const entries = listing.split("\n").map((line) => line.split("\t"));
    if (entries.length !== 1 || entries[0][1] !== sourceRef)
      throw new Error(`Missing or ambiguous ${name} ref`);
    const observedSha = requireSha(entries[0][0]);
    report.sources[name] = {
      repository: owner,
      ref: sourceRef,
      observedSha,
      sha: selectedSourceSha(owner, sourceRef, observedSha),
    };
  }
}

async function mergeSources() {
  for (const name of ["forkMain", "upstreamMain"]) {
    report.stage = `merge:${name}`;
    await save();
    const beforeSha = requireSha(await git(["rev-parse", "HEAD"]));
    const targetSha = report.sources[name].sha;
    const merge = {
      name,
      beforeSha,
      targetSha,
      alreadyIncluded: await ancestor(targetSha, beforeSha),
      mergeBases: (
        await git(["merge-base", "--all", beforeSha, targetSha])
      ).split("\n"),
    };
    report.merges.push(merge);
    try {
      // Only this disposable detached repository receives local merge commits.
      await git(["merge", "--no-ff", "--no-edit", targetSha]);
    } catch (error) {
      merge.conflicts = (
        await git(
          ["diff", "--name-only", "--diff-filter=U", "-z"],
          candidate,
          true,
        )
      )
        .split("\0")
        .filter(Boolean);
      throw error;
    }
    merge.resultSha = requireSha(await git(["rev-parse", "HEAD"]));
    merge.parents = (await git(["show", "-s", "--format=%P", "HEAD"])).split(
      " ",
    );
  }
}

async function verifyCandidate() {
  report.stage = "verify-candidate";
  if (
    (await git(["rev-parse", "HEAD"])) !== requireSha(report.candidateSha) ||
    (await git(["rev-parse", "HEAD^{tree}"])) !==
      requireSha(report.candidateTree)
  )
    throw new Error("Candidate identity differs from the prepared tree");
  if (await git(["status", "--porcelain", "--untracked-files=all"]))
    throw new Error("Candidate files differ from the prepared tree");
}

async function check() {
  await verifyReportFile();
  const previous = JSON.parse(await readFile(reportPath, "utf8"));
  if (
    previous?.schemaVersion !== 1 ||
    previous.status !== "prepared" ||
    !Array.isArray(previous.merges) ||
    !Array.isArray(previous.checks)
  )
    throw new Error("An exact prepared candidate is required");
  for (const name of [
    "controllerSha",
    "controllerTree",
    "candidateSha",
    "candidateTree",
  ])
    requireSha(previous[name]);
  report = previous;
  ownsReport = true;
  requireRunning();
  report.stage = "verify-controller";
  await verifyExecutingHelper();
  if (
    (await git(["rev-parse", "HEAD"], process.cwd())) !==
      requireSha(report.controllerSha) ||
    (await git(["rev-parse", "HEAD^{tree}"], process.cwd())) !==
      requireSha(report.controllerTree) ||
    (await git(
      ["status", "--porcelain", "--untracked-files=all"],
      process.cwd(),
    ))
  )
    throw new Error("Controller differs from its recorded clean identity");
  await verifyCandidate();
  requireRunning();
  await verifyCandidateHelper();
  requireRunning();
  report.stage = "toolchain";
  const { stdout: npmVersion } = await execute("npm", ["--version"], {
    cwd: candidate,
    timeout: 30_000,
  });
  report.executedToolchain = {
    node: process.versions.node,
    npm: `npm@${npmVersion.trim()}`,
  };
  requireRunning();
  if (
    report.executedToolchain.node !== report.toolchain.node ||
    report.executedToolchain.npm !== report.toolchain.npm
  )
    throw new Error(
      "Execution must use the candidate-pinned Node and npm versions",
    );
  report.stage = "command-inventory";
  const inventory = await selectedCommands(candidate);
  report.status = "checking";
  await save();
  for (const args of inventory) {
    report.stage = args.join(" ");
    console.log(`\nSaaS integration: ${report.stage}`);
    const result = { command: args, status: "running" };
    report.checks.push(result);
    await save();
    const code = await runGate(args);
    result.exitCode = code;
    result.status = shutdownSignal
      ? "cancelled"
      : code === 0
        ? "passed"
        : "failed";
    requireRunning();
    if (code !== 0)
      throw new Error(`Gate command failed with exit code ${code}`);
  }
  await verifyCandidate();
  requireRunning();
  report.status = "passed";
  report.stage = "complete";
  await save();
  requireRunning();
}

try {
  if (extra.length) throw new Error("Unexpected arguments");
  if (mode === "commands")
    console.log(JSON.stringify(await selectedCommands(process.cwd())));
  else if (mode === "prepare") {
    await verifyReportPlacement();
    const created = await open(reportPath, "wx");
    await created.close();
    await verifyReportFile();
    ownsReport = true;
    await prepare();
  } else if (mode === "check") {
    await verifyReportPlacement();
    await check();
  } else if (mode === "report") {
    const text = await readFile(reportPath, "utf8");
    console.log(text);
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `### SaaS combined candidate\n\nOnly status \`passed\` establishes this supplemental gate completed.\n\n\`\`\`json\n${text}\`\`\`\n`,
      );
  } else throw new Error("Expected prepare, check, report or commands");
} catch (error) {
  report.status = shutdownSignal ? "cancelled" : "failed";
  report.error = error instanceof Error ? error.message : String(error);
  if (ownsReport) await save();
  console.error(`${report.stage}: ${report.error}`);
  process.exitCode = shutdownSignal ? signalExitCodes[shutdownSignal] : 1;
}
