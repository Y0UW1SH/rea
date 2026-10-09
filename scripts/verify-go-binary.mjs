#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { parseEvidence } from "../dist/domain/evidence.js";
import { goBinarySchema } from "../dist/domain/go/goBinary.js";
import { PrivateRuntimeRoot } from "../dist/process/PrivateRuntimeRoot.js";
import { mcpTextValue } from "./lib/mcp-verifier-results.mjs";
import { createVerifierRun, completeVerifierRun } from "./lib/verifier-run.mjs";

const execute = promisify(execFile);
const compiler = process.env.REA_VERIFY_GO_COMMAND ?? "go";
if (process.env.REA_VERIFY_GO_COMMAND !== undefined && !isAbsolute(compiler))
  throw new Error(
    "REA_VERIFY_GO_COMMAND must be an absolute Go compiler path.",
  );
let compilerVersion = null;
const run = createVerifierRun();
const root = await PrivateRuntimeRoot.create({ prefix: "rea-go-verifier-" });
const entrypoint = fileURLToPath(new URL("./rea.mjs", import.meta.url));
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([, value]) => typeof value === "string"),
);
const goEnvironment = {
  ...environment,
  CGO_ENABLED: "0",
  GOENV: "off",
  GOFLAGS: "",
  GOMAXPROCS: "2",
  GOTOOLCHAIN: "local",
  GOWORK: "off",
  GOPROXY: "off",
  GOSUMDB: "off",
  GOPATH: join(root.path, "gopath"),
  GOCACHE: join(root.path, "cache"),
  GOMODCACHE: join(root.path, "modules"),
  GOTMPDIR: join(root.path, "tmp"),
  // Go's own verifier seam isolates telemetry; no global configuration is changed.
  TEST_TELEMETRY_DIR: join(root.path, "telemetry"),
};
const client = new Client({ name: "go-binary-verifier", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entrypoint, "mcp"],
  env: environment,
  stderr: "pipe",
});
const targets = [
  ["linux", "amd64", "elf", 64, "little"],
  ["linux", "386", "elf", 32, "little"],
  ["linux", "arm64", "elf", 64, "little"],
  ["linux", "ppc64", "elf", 64, "big"],
  ["windows", "amd64", "pe", 64, "little"],
  ["windows", "386", "pe", 32, "little"],
  ["darwin", "amd64", "macho", 64, "little"],
  ["darwin", "arm64", "macho", 64, "little"],
];
const verified = [];
const failures = [];
try {
  await prepareFixture();
  try {
    compilerVersion = (
      await execute(compiler, ["version"], {
        cwd: root.path,
        env: goEnvironment,
        timeout: 10_000,
      })
    ).stdout.trim();
  } catch (cause) {
    throw new Error(
      "verify:go:binary requires Go on PATH or absolute REA_VERIFY_GO_COMMAND; Go is only a fixture producer, not a REA runtime dependency.",
      { cause },
    );
  }
  const host = (await go(["env", "GOHOSTOS", "GOHOSTARCH"])).stdout
    .trim()
    .split("\n");
  const oracle = join(
    root.path,
    host[0] === "windows" ? "buildinfo-oracle.exe" : "buildinfo-oracle",
  );
  await go(
    ["build", "-trimpath", "-buildvcs=false", "-o", oracle, "./oracle"],
    { GOOS: host[0], GOARCH: host[1] },
  );
  await client.connect(transport);
  for (const target of targets) {
    const [os, arch] = target;
    const path = join(
      root.path,
      `${os}-${arch}${os === "windows" ? ".exe" : ""}`,
    );
    await go(
      [
        "build",
        "-trimpath",
        "-buildvcs=false",
        "-ldflags=-s -w",
        "-o",
        path,
        ".",
      ],
      { GOOS: os, GOARCH: arch },
    );
    await verify(path, target, oracle);
    if (os === "linux" && arch === "amd64") {
      const sectionless = join(root.path, "linux-amd64-sectionless");
      const bytes = Buffer.from(await readFile(path));
      bytes.fill(0, 40, 48); // ELF64 e_shoff.
      bytes.fill(0, 58, 64); // e_shentsize, e_shnum and e_shstrndx.
      await writeFile(sectionless, bytes);
      await verify(sectionless, target, oracle);
    }
  }
} catch (cause) {
  failures.push(cause);
} finally {
  for (const close of [
    () => client.close(),
    () => transport.close(),
    () => root.close(),
  ]) {
    try {
      await close();
    } catch (cause) {
      failures.push(cause);
    }
  }
}
const verifier = await completeVerifierRun(run);
try {
  await assert.rejects(readFile(join(root.path, "go.mod")), { code: "ENOENT" });
  if (verifier.process_lineage.status === "verified")
    assert.deepEqual(verifier.process_lineage.descendants, []);
} catch (cause) {
  failures.push(cause);
}
if (failures.length > 0) {
  console.error(
    JSON.stringify(
      { status: "failed", compiler: compilerVersion, verified, verifier },
      null,
      2,
    ),
  );
  throw new AggregateError(
    failures,
    "Real Go metadata verification failed; cleanup failures are retained.",
  );
}
console.log(
  JSON.stringify(
    {
      status: "passed",
      compiler: compilerVersion,
      binaries: verified.length,
      public_cases: verified.length * 2,
      verified,
      fixture_execution:
        "not-requested; only the test-owned buildinfo oracle was executed",
      verifier,
    },
    null,
    2,
  ),
);

async function go(args, overrides = {}) {
  return execute(compiler, args, {
    cwd: root.path,
    env: { ...goEnvironment, ...overrides },
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
}

async function prepareFixture() {
  await mkdir(join(root.path, "tmp"));
  await mkdir(join(root.path, "telemetry"));
  await writeFile(join(root.path, "telemetry", "mode"), "off\n");
  await mkdir(join(root.path, "dependency"));
  await mkdir(join(root.path, "oracle"));
  await writeFile(
    join(root.path, "go.mod"),
    "module example.test/rea-go-fixture\n\ngo 1.20\n\nrequire example.test/dependency v1.2.3\nreplace example.test/dependency => ./dependency\n",
  );
  await writeFile(
    join(root.path, "dependency", "go.mod"),
    "module example.test/dependency\n\ngo 1.20\n",
  );
  await writeFile(
    join(root.path, "dependency", "dependency.go"),
    'package dependency\nfunc Value() string { return "REA fixture" }\n',
  );
  await writeFile(
    join(root.path, "main.go"),
    'package main\nimport ("fmt"; "example.test/dependency")\nfunc main() { fmt.Println(dependency.Value()) }\n',
  );
  await writeFile(
    join(root.path, "oracle", "main.go"),
    'package main\nimport ("debug/buildinfo"; "encoding/json"; "os")\nfunc main() { info, err := buildinfo.ReadFile(os.Args[1]); if err != nil { panic(err) }; if err := json.NewEncoder(os.Stdout).Encode(info); err != nil { panic(err) } }\n',
  );
}

async function inspect(mode, path) {
  let envelope;
  if (mode === "cli") {
    const { stdout } = await execute(
      process.execPath,
      [entrypoint, "inspect-go-binary", path, "--json"],
      { env: environment, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
    );
    envelope = JSON.parse(stdout);
  } else {
    const response = await client.callTool(
      { name: "inspect_go_binary", arguments: { path } },
      { timeout: 30_000 },
    );
    assert.notEqual(response.isError, true, mcpTextValue(response));
    envelope = JSON.parse(mcpTextValue(response));
  }
  const evidence = parseEvidence(envelope);
  assert.equal(evidence.subject.local_path, path);
  const report = goBinarySchema.parse(evidence.normalized_result);
  assert.equal(evidence.subject.digest.sha256, report.artifact.sha256);
  return report;
}

async function verify(path, target, oracle) {
  const bytes = await readFile(path);
  const expected = JSON.parse(
    (await execute(oracle, [path], { timeout: 10_000, maxBuffer: 1024 * 1024 }))
      .stdout,
  );
  const reports = [];
  for (const mode of ["cli", "mcp"]) {
    const report = await inspect(mode, path);
    assert.equal(report.format, target[2]);
    assert.equal(report.architecture, target[1]);
    assert.equal(report.bits, target[3]);
    assert.equal(report.byte_order, target[4]);
    assert.equal(report.artifact.path, path);
    assert.equal(report.artifact.bytes, bytes.length);
    assert.equal(
      report.artifact.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    const info = report.build_info;
    assert.notEqual(info, null);
    assert.equal(info.go_version, expected.GoVersion);
    assert.equal(info.module.path, expected.Path);
    assert.deepEqual(
      normalizeObservedModule(info.module.main),
      normalizeModule(expected.Main),
    );
    assert.deepEqual(
      info.module.dependencies.map(normalizeObservedModule),
      (expected.Deps ?? []).map(normalizeModule),
    );
    assert.deepEqual(
      info.module.settings,
      (expected.Settings ?? []).map(({ Key, Value }) => ({
        key: Key,
        value: Value,
      })),
    );
    assert.equal(info.module.complete, true);
    assert.deepEqual(info.module.unparsed_lines, []);
    verifySource(info, bytes);
    reports.push(report);
    assert.deepEqual(
      await readFile(path),
      bytes,
      `${mode} changed source bytes`,
    );
  }
  assert.deepEqual(
    reports[0],
    reports[1],
    "Public CLI and MCP projections disagree",
  );
  verified.push({
    target: `${target[0]}/${target[1]}`,
    file: path.endsWith("sectionless") ? "sectionless" : "stripped",
    go_version: expected.GoVersion,
  });
}

function normalizeModule(module) {
  const identity = ({ Path, Version, Sum }) => ({
    path: Path,
    version: Version,
    sum: Sum === "" || Sum === undefined ? null : Sum,
  });
  return {
    ...identity(module),
    replacement: module.Replace == null ? null : identity(module.Replace),
  };
}

function normalizeObservedModule(module) {
  // debug/buildinfo JSON represents both absent and explicitly empty sums as "".
  const identity = (value) => ({
    ...value,
    sum: value.sum === "" ? null : value.sum,
  });
  return {
    ...identity(module),
    replacement:
      module.replacement === null ? null : identity(module.replacement),
  };
}

function verifySource(info, bytes) {
  assert.deepEqual(
    bytes.subarray(info.header_offset, info.header_offset + 14),
    Buffer.from("ff20476f206275696c64696e663a", "hex"),
  );
  assert.equal(
    info.encoding,
    "inline",
    "Current compiler fixture must use inline string encoding",
  );
  const version = inlineString(bytes, info.header_offset + 32);
  const module = inlineString(bytes, version.offset + version.bytes.length);
  assert.deepEqual(info.version_location, {
    offset: version.offset,
    bytes: version.bytes.length,
  });
  assert.deepEqual(info.module_location, {
    offset: module.offset,
    bytes: module.bytes.length,
  });
  assert.equal(version.bytes.toString("utf8"), info.go_version);
  assert.equal(module.bytes.toString("base64"), info.module_bytes_base64);
  assert.deepEqual(
    module.bytes.subarray(0, 16),
    Buffer.from("3077af0c9274080241e1c107e6d618e6", "hex"),
  );
  assert.deepEqual(
    module.bytes.subarray(-16),
    Buffer.from("f932433186182072008242104116d8f2", "hex"),
  );
  assert.equal(
    module.bytes.subarray(16, -16).toString("utf8"),
    info.module_text,
  );
  assert.equal(info.module_text.endsWith("\n"), true);
}

function inlineString(bytes, start) {
  let length = 0;
  let offset = start;
  let shift = 0;
  for (;;) {
    assert.ok(
      offset < bytes.length && shift < 49,
      "Fixture string length is invalid",
    );
    const byte = bytes[offset++];
    length += (byte & 127) * 2 ** shift;
    if ((byte & 128) === 0) break;
    shift += 7;
  }
  assert.ok(
    length <= bytes.length - offset,
    "Fixture string contents are truncated",
  );
  return { offset, bytes: bytes.subarray(offset, offset + length) };
}
