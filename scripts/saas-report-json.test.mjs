import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serializeContract } from "./lib/saas-api-contract-admission.mjs";
import { admitReport } from "./lib/saas-export-budget.mjs";

const fixture = () =>
  JSON.parse(
    readFileSync(
      new URL("./fixtures/saas-compatibility/accounting.json", import.meta.url),
    ),
  );

test("CLI preserves signed-zero evidence without changing comparison verdicts", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "rea-compatibility-signed-zero-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "case.json");
  const cli = fileURLToPath(
    new URL("./saas-compatibility.mjs", import.meta.url),
  );
  const nested =
    '{"array":[-0,0,{"value":-0}],"__proto__":-0,"constructor":"-0","text":"__NEGATIVE_ZERO__ 客户 😀 \\u0000 \\ud800"}';
  for (const [reference, replacement, status] of [
    ["-0", "0", "fail"],
    ["0", "-0", "fail"],
    ["-0", "-0", "pass"],
    ["0", "0", "pass"],
    ['"-0"', "-0", "fail"],
    [nested, nested, "pass"],
  ]) {
    const input = fixture();
    input.reference.observations[0].value.payload = JSON.parse(reference);
    input.replacement.observations[0].value.payload = JSON.parse(replacement);
    for (const run of [input.reference, input.replacement])
      run.context.signedZero = {
        provenance: "caller_declared",
        value: [-0, 0, "-0"],
      };
    input.contextKeys.push("signedZero");
    writeFileSync(
      file,
      JSON.stringify(input, (_key, value) =>
        Object.is(value, -0) ? JSON.rawJSON("-0") : value,
      ),
    );
    const result = spawnSync(process.execPath, [cli, file], {
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(result.status, status === "pass" ? 0 : 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, status);
    assert.equal(
      report.checks[0].reason,
      status === "pass" ? "observed_values_match" : "observed_values_differ",
    );
    for (const [side, source] of [
      ["reference", reference],
      ["replacement", replacement],
    ]) {
      assert.deepEqual(
        report.checks[0][side].observation.value.payload,
        JSON.parse(source),
      );
      assert.deepEqual(report.context[side].signedZero.value, [-0, 0, "-0"]);
    }
  }
});

test("contract serialization preserves numeric signs and literal JSON data", () => {
  const value = JSON.parse(
    '{"nested":[-0,0,{"value":-0}],"__proto__":-0,"constructor":"-0"}',
  );
  value.strings = [
    "-0",
    "__NEGATIVE_ZERO__",
    '{"value":-0}',
    '\\"-0\\"',
    "客户 😀 \u0000 \ud800",
  ];
  value.numbers = [Number.MIN_VALUE, Number.MAX_SAFE_INTEGER, 1.25, -1];
  const before = structuredClone(value);
  const serialized = serializeContract(value);
  assert.deepEqual(JSON.parse(serialized), before);
  assert.deepEqual(value, before);
  assert.match(serialized, /"__proto__": -0/);
  assert.ok(serialized.endsWith("\n"));
  assert.equal(serializeContract(-0), "-0\n");
  assert.equal(serializeContract(0), "0\n");
  assert.equal(serializeContract("-0"), '"-0"\n');
});

test("report budget includes the numeric negative-zero sign", () => {
  const maximum = 16 * 1024 * 1024;
  const empty = '{\n  "value": -0,\n  "padding": ""\n}\n';
  const report = { value: -0, padding: "x".repeat(maximum - empty.length) };
  assert.equal(admitReport(report), report);
  report.padding += "x";
  assert.throws(() => admitReport(report), /report: exceeds 16 MiB/);
});
