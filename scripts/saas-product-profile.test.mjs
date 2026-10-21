import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspectProductProfile } from "./lib/saas-product-profile.mjs";
const read = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/saas-profiles/${name}.json`, import.meta.url),
    ),
  );
test("vendor profiles remain plans with explicit missing access and edition", () => {
  for (const name of ["lightspeed", "quickbooks", "generic"]) {
    const report = inspectProductProfile(read(name));
    assert.equal(report.status, "valid_plan");
    assert.equal(report.coverage.verified, 0);
    assert.ok(report.unknownSetup.includes("edition"));
    assert.ok(
      report.externalDependencies.every((effect) => effect.mode === "untested"),
    );
    assert.ok(report.nextExperiments.length);
  }
});
test("a claimed verified workflow requires evidence", () => {
  const input = read("generic");
  input.workflows[0].status = "verified";
  assert.equal(inspectProductProfile(input).status, "invalid");
});
test("live dependency observation requires explicit evidence", () => {
  const input = read("generic");
  input.externalDependencies[0].mode = "observed";
  assert.equal(inspectProductProfile(input).status, "invalid");
});
test("duplicate workflow identity and experiment references fail closed", () => {
  const input = read("generic");
  input.workflows.push(structuredClone(input.workflows[0]));
  assert.equal(inspectProductProfile(input).status, "invalid");
  const other = read("generic");
  other.experiments[0].workflowId = "absent";
  assert.equal(inspectProductProfile(other).status, "invalid");
});
test("unknown and unverified never become verified from matching plans", () => {
  const input = read("generic");
  input.workflows[0].status = "recorded";
  input.workflows[0].evidence = ["local:evidence"];
  const report = inspectProductProfile(input);
  assert.equal(report.coverage.recorded, 1);
  assert.equal(report.coverage.verified, 0);
  assert.match(report.limitations.join(" "), /not authenticated/);
});
test("malformed plans and unrecognized capabilities are rejected", () => {
  for (const value of [null, {}, [], { version: 1 }])
    assert.equal(inspectProductProfile(value).status, "invalid");
  const input = read("generic");
  input.extra = true;
  assert.equal(inspectProductProfile(input).status, "invalid");
});
test("resolved experiments require evidence and duplicate experiment IDs reject", () => {
  const input = read("generic");
  input.experiments[0].status = "resolved";
  assert.equal(inspectProductProfile(input).status, "invalid");
  input.experiments[0].status = "planned";
  input.experiments.push(structuredClone(input.experiments[0]));
  assert.equal(inspectProductProfile(input).status, "invalid");
});
test("unknown setup cannot assert values and observed setup needs evidence", () => {
  const input = read("generic");
  input.setup.edition.value = "invented";
  assert.equal(inspectProductProfile(input).status, "invalid");
  input.setup.edition.provenance = "observed";
  assert.equal(inspectProductProfile(input).status, "invalid");
});
test("profile inspection preserves input and reviewed external boundaries", () => {
  const input = read("generic");
  input.externalDependencies[0].mode = "simulated";
  input.externalDependencies[0].evidence = ["synthetic:payment-response"];
  const before = JSON.stringify(input);
  const report = inspectProductProfile(input);
  assert.equal(report.status, "valid_plan");
  assert.equal(report.externalDependencies[0].mode, "simulated");
  assert.equal(JSON.stringify(input), before);
});
test("whitespace cannot satisfy required evidence, case paths or observed facts", () => {
  for (const mutate of [
    (p) => {
      p.workflows[0].status = "verified";
      p.workflows[0].casePath = " ";
      p.workflows[0].evidence = [" "];
    },
    (p) => {
      p.setup.product.value = "  ";
    },
    (p) => {
      p.externalDependencies[0].mode = "observed";
      p.externalDependencies[0].evidence = ["\t"];
    },
    (p) => {
      p.experiments[0].id = " ";
    },
  ]) {
    const input = read("generic");
    mutate(input);
    assert.equal(inspectProductProfile(input).status, "invalid");
  }
});

test("published schema enforces resolved-experiment evidence on its own", () => {
  const validate = new Ajv2020({ strict: true }).compile(
    read("profile.schema"),
  );
  const input = read("generic");
  input.experiments[0].status = "resolved";
  assert.equal(validate(input), false);
  input.experiments[0].evidence = ["local:verified-observation"];
  assert.equal(validate(input), true);
});

test("CLI rejects malformed UTF-8 workflow identities before linking experiments", () => {
  const directory = mkdtempSync(join(tmpdir(), "rea-profile-utf8-"));
  const file = join(directory, "profile.json");
  const cli = fileURLToPath(
    new URL("./saas-product-profile.mjs", import.meta.url),
  );
  const input = read("generic");
  input.workflows[0].id = "WORKFLOW_ID";
  input.experiments[0].workflowId = "WORKFLOW_LINK";
  const [start, rest] = JSON.stringify(input).split("WORKFLOW_ID");
  const [middle, end] = rest.split("WORKFLOW_LINK");
  try {
    for (const [id, link] of [
      [Buffer.from([0x80]), Buffer.from([0x81])],
      [Buffer.from([0x80]), Buffer.from("\ufffd")],
      [Buffer.from("valid"), Buffer.from([0xe2, 0x82])],
    ]) {
      writeFileSync(
        file,
        Buffer.concat([
          Buffer.from(start),
          id,
          Buffer.from(middle),
          link,
          Buffer.from(end),
        ]),
      );
      const result = spawnSync(process.execPath, [cli, file], {
        encoding: "utf8",
      });
      assert.equal(result.status, 2, result.stdout);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /utf-8/i);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI preserves valid Unicode identities and its leading-BOM rejection", () => {
  const directory = mkdtempSync(join(tmpdir(), "rea-profile-unicode-"));
  const file = join(directory, "profile.json");
  const cli = fileURLToPath(
    new URL("./saas-product-profile.mjs", import.meta.url),
  );
  const input = read("generic");
  input.workflows[0].id = "客户 café 😀 \ufffd \ufeff";
  input.experiments[0].workflowId = input.workflows[0].id;
  try {
    writeFileSync(file, JSON.stringify(input));
    let result = spawnSync(process.execPath, [cli, file], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, "valid_plan");
    input.experiments[0].workflowId += "different";
    writeFileSync(file, JSON.stringify(input));
    result = spawnSync(process.execPath, [cli, file], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).status, "invalid");
    writeFileSync(file, `\ufeff${JSON.stringify(read("generic"))}`);
    result = spawnSync(process.execPath, [cli, file], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
