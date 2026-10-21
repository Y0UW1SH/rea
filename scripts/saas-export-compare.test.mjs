import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { compareExports } from "./lib/saas-export-comparison.mjs";
const policy = () => ({
  version: 1,
  name: "invoice-export",
  reference: { file: "ref.csv", format: "csv" },
  replacement: { file: "new.json", format: "json" },
  fields: [
    { name: "id", reference: "id", replacement: "id", type: "string" },
    {
      name: "amount",
      reference: "amount",
      replacement: "amount",
      type: "decimal",
    },
    {
      name: "customer",
      reference: "customer",
      replacement: "customer",
      type: "string",
    },
  ],
  keys: ["id"],
  limits: { maxBytes: 10000, maxRecords: 100, maxFields: 20 },
});
async function run(
  t,
  a = "id,amount,customer,ignored\na,100.00,c1,x\nb,0.10,c2,y\n",
  b = JSON.stringify([
    { id: "b", amount: ".10", customer: "c2" },
    { id: "a", amount: "100", customer: "c1" },
  ]),
  modify = () => {},
) {
  const dir = await mkdtemp(join(tmpdir(), "rea-exports-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "ref.csv"), a);
  await writeFile(join(dir, "new.json"), b);
  const p = policy();
  await modify(p, dir);
  return compareExports(p, dir);
}
function changedExportRows() {
  const rows = Array.from({ length: 100 }, (_, i) => ({
    id: String(i),
    amount: "2",
    customer: "c",
  }));
  return {
    reference:
      "id,amount,customer\n" + rows.map((row) => `${row.id},1,c`).join("\n"),
    replacement: JSON.stringify(rows),
  };
}
test("reordered records and exact decimal spellings agree with provenance", async (t) => {
  const r = await run(t);
  assert.equal(r.status, "pass");
  assert.match(r.reference.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(r.reference.excludedFields, ["ignored"]);
  assert.equal(r.reference.records, 2);
});
test("wrong amount and literal relationship fail", async (t) => {
  for (const change of [{ amount: "100.01" }, { customer: "c2" }]) {
    const r = await run(
      t,
      undefined,
      JSON.stringify([
        { id: "b", amount: "0.1", customer: "c2" },
        { id: "a", amount: "100", customer: "c1", ...change },
      ]),
    );
    assert.equal(r.status, "fail");
  }
});
test("exact decimal comparison never rounds large values", async (t) => {
  const r = await run(
    t,
    "id,amount,customer\na,9007199254740993.01,c1",
    JSON.stringify([
      { id: "a", amount: "9007199254740993.02", customer: "c1" },
    ]),
  );
  assert.equal(r.status, "fail");
});
test("quoted commas newline and escaped quotes are preserved", async (t) => {
  const r = await run(
    t,
    'id,amount,customer\n"a,\nb",1,"c""1"\n',
    JSON.stringify([{ id: "a,\nb", amount: "1.0", customer: 'c"1' }]),
  );
  assert.equal(r.status, "pass");
});
test("duplicates missing columns malformed CSV and JSON cannot pass", async (t) => {
  for (const a of [
    "id,amount,customer\na,1,c\na,1,c",
    "id,amount\na,1",
    "id,id,customer\na,1,c",
    'id,amount,customer\na,"1,c',
    'id,amount,customer\na,1"2,c',
    'id,amount,customer\na,"1"x,c',
  ])
    assert.equal((await run(t, a)).status, "invalid");
  for (const b of [
    "{}",
    "[",
    '[{"id":"a","id":"b","amount":"1","customer":"c"}]',
    '[{"id":"a","amount":0.1,"customer":"c"}]',
  ])
    assert.equal((await run(t, undefined, b)).status, "invalid");
});
test("missing and extra record keys remain visible", async (t) => {
  const r = await run(
    t,
    undefined,
    JSON.stringify([
      { id: "a", amount: "100", customer: "c1" },
      { id: "c", amount: "1", customer: "c3" },
    ]),
  );
  assert.equal(r.status, "fail");
  assert.deepEqual(r.missingReplacementKeys, [["b"]]);
  assert.deepEqual(r.extraReplacementKeys, [["c"]]);
});
test("budgets path traversal and missing file fail closed", async (t) => {
  for (const modify of [
    (p) => (p.limits.maxBytes = 10),
    (p) => (p.limits.maxRecords = 1),
    (p) => (p.limits.maxFields = 2),
    (p) => (p.reference.file = "../escape"),
    (p) => (p.reference.file = "/tmp/escape"),
    (p) => (p.reference.file = "missing"),
  ])
    assert.equal(
      (await run(t, undefined, undefined, modify)).status,
      "invalid",
    );
});
test("symlinks outside manifest directory are rejected", async (t) => {
  const outside = await mkdtemp(join(tmpdir(), "rea-exports-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "ref.csv"), "id,amount,customer\na,1,c");
  // A directory link needs no Windows privilege; POSIX ignores the link type.
  const r = await run(t, undefined, undefined, async (p, dir) => {
    await symlink(outside, join(dir, "linked"), "junction");
    p.reference.file = "linked/ref.csv";
  });
  assert.equal(r.status, "invalid");
  assert.match(r.reason, /escapes input directory/);
});
test("invalid UTF-8 and BOM are not silently repaired", async (t) => {
  for (const a of [Buffer.from([0xff]), "\ufeffid,amount,customer\na,1,c"])
    assert.equal((await run(t, a)).status, "invalid");
});
test("invalid UTF-8 retains stable raw input provenance on either side", async (t) => {
  const malformed = Buffer.from([0xff]);
  for (const side of ["reference", "replacement"]) {
    const r = await run(
      t,
      side === "reference" ? malformed : undefined,
      side === "replacement" ? malformed : undefined,
    );
    assert.equal(r.status, "invalid");
    assert.match(r.reason, /utf-8/);
    assert.deepEqual(r.inputs[side], {
      file: side === "reference" ? "ref.csv" : "new.json",
      bytes: 1,
      sha256: createHash("sha256").update(malformed).digest("hex"),
    });
    if (side === "replacement")
      assert.match(r.inputs.reference.sha256, /^[a-f0-9]{64}$/);
  }
});

test("expanded reports fail closed with complete policy and input provenance", async (t) => {
  const alias = "field".repeat(40000);
  const { reference, replacement } = changedExportRows();
  const r = await run(t, reference, replacement, (p) => {
    p.fields[1].name = alias;
  });
  assert.equal(r.status, "invalid");
  assert.match(r.reason, /report: exceeds 16 MiB/);
  assert.equal(r.policy.fields[1].name, alias);
  assert.match(r.inputs.reference.sha256, /^[a-f0-9]{64}$/);
  assert.match(r.inputs.replacement.sha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(r, "changedRecords"), false);
  assert.ok(
    Buffer.byteLength(JSON.stringify(r, null, 2)) + 1 <= 16 * 1024 * 1024,
  );
});

test("report budget includes exact UTF-8 escaping and pretty-print overhead", async (t) => {
  const prefix = 'quotes"\\\b\t\n\f\r\u0000 café 漢字 😀\ud800x\udfff';
  const { reference, replacement } = changedExportRows();
  const baseline = await run(t, reference, replacement, (p) => {
    p.fields[1].name = prefix;
  });
  assert.equal(baseline.status, "fail");
  const limit = 16 * 1024 * 1024;
  const remaining =
    limit - Buffer.byteLength(JSON.stringify(baseline, null, 2)) - 1;
  let repeated = Math.floor(remaining / 101);
  if ((remaining - repeated * 101) % 2) repeated--;
  const alias = prefix + "f".repeat(repeated);
  const padding = "x".repeat((remaining - repeated * 101) / 2);
  const exact = await run(t, reference, replacement, (p) => {
    p.fields[1].name = alias;
    p.name += padding;
  });
  assert.equal(exact.status, "fail");
  assert.equal(Buffer.byteLength(JSON.stringify(exact, null, 2)) + 1, limit);
  const exceeded = await run(t, reference, replacement, (p) => {
    p.fields[1].name = alias;
    p.name += padding + "x";
  });
  assert.equal(exceeded.status, "invalid");
  assert.match(exceeded.reason, /report: exceeds 16 MiB/);
});

test("oversized policies are rejected before reading inputs without echoing them", async (t) => {
  const r = await run(t, undefined, undefined, (p) => {
    p.name = "x".repeat(1024 * 1024);
  });
  assert.equal(r.status, "invalid");
  assert.match(r.reason, /policy: exceeds 1 MiB/);
  assert.deepEqual(r.inputs, {});
  assert.equal(Object.hasOwn(r, "policy"), false);
  assert.ok(Buffer.byteLength(JSON.stringify(r, null, 2)) < 1024);
});

test("policy admission snapshots nested choices before asynchronous reads", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rea-export-policy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "ref.csv"), "id,amount,customer\na,1,c");
  await writeFile(
    join(dir, "new.json"),
    '[{"id":"a","amount":"1","customer":"c"}]',
  );
  const p = policy();
  const expected = structuredClone(p);
  expected.limits.maxValues = 100000;
  const pending = compareExports(p, dir);
  p.fields[1].name = "x".repeat(17 * 1024 * 1024);
  p.keys[0] = "customer";
  p.reference.file = "missing-reference";
  p.replacement.file = "missing-replacement";
  p.limits.maxBytes = 1;
  const report = await pending;
  assert.equal(report.status, "pass");
  assert.deepEqual(report.policy, expected);
  report.policy.fields[0].name = "report-only";
  report.policy.keys[0] = "report-only";
  report.policy.reference.file = "report-only";
  report.policy.replacement.file = "report-only";
  report.policy.limits.maxBytes = 2;
  assert.equal(p.fields[0].name, "id");
  assert.equal(p.keys[0], "customer");
  assert.equal(p.reference.file, "missing-reference");
  assert.equal(p.replacement.file, "missing-replacement");
  assert.equal(p.limits.maxBytes, 1);
});

test("oversized invalid diagnostics retain policy and input provenance within the report cap", async (t) => {
  const key = "\u0000".repeat(2400000);
  const r = await run(
    t,
    `id,amount,customer\n${key},1,c\n${key},1,c`,
    undefined,
    (p) => {
      p.limits.maxBytes = 8 * 1024 * 1024;
    },
  );
  assert.equal(r.status, "invalid");
  assert.match(r.reason, /invalid diagnostic exceeds 16 MiB/);
  assert.equal(r.policy.name, "invoice-export");
  assert.match(r.inputs.reference.sha256, /^[a-f0-9]{64}$/);
  assert.ok(
    Buffer.byteLength(JSON.stringify(r, null, 2)) + 1 <= 16 * 1024 * 1024,
  );
});
test("canonical decimal key collisions and empty keys are invalid", async (t) => {
  const collision = await run(
    t,
    "id,amount,customer\na,1.0,c\nb,01.00,c",
    undefined,
    (p) => (p.keys = ["amount"]),
  );
  assert.equal(collision.status, "invalid");
  assert.equal((await run(t, "id,amount,customer\n,1,c")).status, "invalid");
});
test("malformed JSON syntax cannot pass", async (t) => {
  for (const b of [
    '[{"id":"a",}]',
    "[true false]",
    "[01]",
    '[{"x":NaN}]',
    '["bad\nstring"]',
    "[] trailing",
    '[{"x":"\\q"}]',
  ])
    assert.equal((await run(t, undefined, b)).status, "invalid");
});
test("strict decimal spellings exclude exponent locale whitespace and nonfinite numbers", async (t) => {
  for (const amount of [
    "1e10",
    "1,23",
    " 1",
    "NaN",
    "Infinity",
    "1.",
    "+1",
    "--1",
  ]) {
    const r = await run(
      t,
      undefined,
      JSON.stringify([{ id: "a", amount, customer: "c1" }]),
    );
    assert.equal(r.status, "invalid");
  }
});
test("integer fields remain exact and reject fractions", async (t) => {
  const exact = await run(
    t,
    "id,amount,customer\na,9007199254740993,c1",
    JSON.stringify([{ id: "a", amount: "9007199254740993", customer: "c1" }]),
    (p) => (p.fields[1].type = "integer"),
  );
  assert.equal(exact.status, "pass");
  assert.equal(
    (await run(t, undefined, undefined, (p) => (p.fields[1].type = "integer")))
      .status,
    "invalid",
  );
});
test("prototype-looking columns and keys are ordinary data", async (t) => {
  const a = "__proto__,amount,constructor\nprototype,1,toString";
  const b = '[{"__proto__":"prototype","amount":"1","constructor":"toString"}]';
  assert.equal(
    (
      await run(t, a, b, (p) => {
        p.fields[0] = {
          name: "__proto__",
          reference: "__proto__",
          replacement: "__proto__",
          type: "string",
        };
        p.fields[2] = {
          name: "constructor",
          reference: "constructor",
          replacement: "constructor",
          type: "string",
        };
        p.keys = ["__proto__"];
      })
    ).status,
    "pass",
  );
});
test("malformed input retains successfully read file digest", async (t) => {
  const r = await run(t, "bad");
  assert.equal(r.status, "invalid");
  assert.match(r.inputs.reference.sha256, /^[a-f0-9]{64}$/);
});
test("aggregate JSON and CSV allocation budgets reject expansion", async (t) => {
  const csv = await run(
    t,
    "id,amount,customer\na,1,c",
    undefined,
    (p) => (p.limits.maxValues = 5),
  );
  assert.equal(csv.status, "invalid");
  assert.match(csv.reason, /CSV: exceeds maxValues/);
  const json = await run(
    t,
    "id,amount,customer\na,1,c",
    JSON.stringify([
      { id: "a", amount: "1", customer: "c", nested: [[], [], [], [], []] },
    ]),
    (p) => (p.limits.maxValues = 10),
  );
  assert.equal(json.status, "invalid");
  assert.match(json.reason, /JSON: exceeds maxValues/);
});
test("JSON column union is bounded", async (t) => {
  const r = await run(
    t,
    "id,amount,customer\na,1,c",
    JSON.stringify([
      { id: "a", amount: "1", customer: "c", x: "x" },
      { id: "b", amount: "2", customer: "d", y: "y" },
    ]),
    (p) => (p.limits.maxFields = 4),
  );
  assert.equal(r.status, "invalid");
  assert.match(r.reason, /union/);
});
test("CLI distinguishes pass fail invalid usage and read failure", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const script = new URL("./saas-export-compare.mjs", import.meta.url);
  const dir = await mkdtemp(join(tmpdir(), "rea-export-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "ref.csv"), "id,amount,customer\na,1,c");
  await writeFile(
    join(dir, "new.json"),
    '[{"id":"a","amount":"1","customer":"c"}]',
  );
  await writeFile(join(dir, "manifest.json"), JSON.stringify(policy()));
  const invoke = (args) =>
    spawnSync(process.execPath, [fileURLToPath(script), ...args], {
      encoding: "utf8",
      timeout: 10000,
    });
  let result = invoke([join(dir, "manifest.json")]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "pass");
  await writeFile(
    join(dir, "new.json"),
    '[{"id":"a","amount":"2","customer":"c"}]',
  );
  result = invoke([join(dir, "manifest.json")]);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "fail");
  await writeFile(join(dir, "new.json"), "[");
  result = invoke([join(dir, "manifest.json")]);
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).status, "invalid");
  assert.equal(invoke([]).status, 2);
  assert.equal(invoke([join(dir, "missing")]).status, 2);

  await writeFile(join(dir, "ref.csv"), Buffer.from([0xff]));
  result = invoke([join(dir, "manifest.json")]);
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).inputs.reference.bytes, 1);

  const { reference, replacement } = changedExportRows();
  await writeFile(join(dir, "ref.csv"), reference);
  await writeFile(join(dir, "new.json"), replacement);
  const expanded = policy();
  expanded.fields[1].name = "field".repeat(40000);
  await writeFile(join(dir, "manifest.json"), JSON.stringify(expanded));
  result = invoke([join(dir, "manifest.json")]);
  assert.equal(result.status, 2, result.stderr);
  assert.match(JSON.parse(result.stdout).reason, /report: exceeds 16 MiB/);
  assert.ok(Buffer.byteLength(result.stdout) <= 16 * 1024 * 1024);
});
test("opened descriptor rejects ancestor substitution and concurrent file changes", async () => {
  const { spawnSync } = await import("node:child_process");
  const moduleUrl = new URL("./lib/saas-export-comparison.mjs", import.meta.url)
    .href;
  const source = `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import assert from 'node:assert/strict';
    // The reader opens canonical paths (macOS /private/var, Windows case/short names).
    const root=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'rea-export-race-')));
    const outside=await fs.realpath(await fs.mkdtemp(join(tmpdir(),'rea-export-control-')));
    const original=fs.open;
    try {
      await fs.mkdir(join(root,'selected'));
      await fs.writeFile(join(root,'selected','export.txt'),'inside');
      await fs.writeFile(join(outside,'export.txt'),'outside');
      const target=join(root,'selected','export.txt');let closes=0;
      fs.open=async(path,...args)=>{
        if(path===target){await fs.rename(join(root,'selected'),join(root,'original'));await fs.symlink(outside,join(root,'selected'),'junction');}
        const handle=await original(path,...args);const close=handle.close.bind(handle);handle.close=async()=>{closes++;return close();};return handle;
      };
      syncBuiltinESMExports();
      const {readBoundedExport}=await import(${JSON.stringify(moduleUrl)});
      await assert.rejects(readBoundedExport(root,'selected/export.txt',100),/selected path changed/);
      assert.equal(closes,1);
      fs.open=original;syncBuiltinESMExports();
      const changing=join(root,'changing.txt');await fs.writeFile(changing,'before');
      fs.open=async(path,...args)=>{const handle=await original(path,...args);if(path===changing){const read=handle.read.bind(handle);let first=true;handle.read=async(...params)=>{const result=await read(...params);if(first){first=false;await fs.writeFile(changing,'after!');}return result;};}return handle;};
      syncBuiltinESMExports();
      await assert.rejects(readBoundedExport(root,'changing.txt',100),/changed during read/);
    }finally{fs.open=original;syncBuiltinESMExports();await fs.rm(root,{recursive:true,force:true});await fs.rm(outside,{recursive:true,force:true});}
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", source],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.status, 0, result.stderr);
});
test("quoted large fields retain exact bytes without per-character array expansion", async (t) => {
  const label = "x".repeat(100000) + '"'.repeat(10000);
  const r = await run(
    t,
    'id,amount,customer\na,1,"' + label.replaceAll('"', '""') + '"',
    JSON.stringify([{ id: "a", amount: "1.00", customer: label }]),
    (p) => (p.limits.maxBytes = 200000),
  );
  assert.equal(r.status, "pass");
});

test("JSON root record budget is enforced independently of reference rows", async (t) => {
  const r = await run(
    t,
    "id,amount,customer\na,1,c",
    JSON.stringify([
      { id: "a", amount: "1", customer: "c" },
      { id: "b", amount: "2", customer: "d" },
    ]),
    (p) => (p.limits.maxRecords = 1),
  );
  assert.equal(r.status, "invalid");
  assert.match(r.reason, /JSON: exceeds array record budget/);
});
