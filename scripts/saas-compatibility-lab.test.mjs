import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runLabCase, runLab } from "./lib/saas-compatibility-lab.mjs";

const cli = fileURLToPath(
  new URL("./saas-compatibility-lab.mjs", import.meta.url),
);

for (const workflow of ["accounting", "retail"]) {
  test(`${workflow}: independently persisted implementations agree`, () => {
    const result = runLabCase({ workflow });
    assert.equal(result.report.status, "pass");
    assert.notEqual(result.case.reference.runId, result.case.replacement.runId);
    assert.ok(
      result.case.entities.every((e) => e.reference.id !== e.replacement.id),
    );
  });
  for (const mutation of [
    "wrong_amount",
    "wrong_relationship",
    "no_persistence",
    "duplicate_retry",
  ]) {
    test(`${workflow}: detects ${mutation}`, () => {
      const result = runLabCase({ workflow, mutation });
      assert.equal(result.report.status, "fail");
      assert.ok(result.report.checks.some((c) => c.status === "fail"));
    });
  }
}
test("unseen customer, amount and quantity produce newly computed outcomes", () => {
  const accounting = runLabCase({
    workflow: "accounting",
    input: { customer: "Synthetic Customer Z", total: 19317, payment: 6419 },
  });
  assert.equal(accounting.report.status, "pass");
  assert.equal(accounting.case.reference.observations[0].value.balance, 12898);
  const retail = runLabCase({
    workflow: "retail",
    input: {
      product: "Synthetic Widget Z",
      stock: 19,
      quantity: 7,
      returned: 3,
      unitPrice: 217,
    },
  });
  assert.equal(retail.report.status, "pass");
  assert.equal(retail.case.replacement.observations[0].value.stock, 15);
  assert.equal(retail.case.replacement.observations[0].value.net, 868);
});
test("invalid or unsafe input fails before execution", () => {
  for (const args of [
    { workflow: "other" },
    { mutation: "other" },
    { input: { total: 1, payment: 2 } },
    { input: { total: Number.MAX_SAFE_INTEGER + 1 } },
    { workflow: "retail", input: { stock: 2, quantity: 3 } },
    {
      workflow: "retail",
      input: { unitPrice: Number.MAX_SAFE_INTEGER, quantity: 2 },
    },
  ]) {
    assert.throws(() => runLabCase(args));
  }
});
test("CLI emits structured cases and verifies all expected mutation results", () => {
  const result = JSON.parse(
    execFileSync(process.execPath, [cli], { encoding: "utf8" }),
  );
  assert.equal(result.status, "pass");
  assert.equal(result.results.length, 12);
  assert.equal(runLab().status, "pass");
});
test("CLI rejects unsupported arguments", () => {
  assert.throws(() =>
    execFileSync(process.execPath, [cli, "--unknown"], { stdio: "pipe" }),
  );
});
test("wrong relationship fails even when customer labels and all other values agree", () => {
  const result = runLabCase({ mutation: "wrong_relationship" });
  const a = result.case.reference.observations[0].value;
  const b = result.case.replacement.observations[0].value;
  assert.equal(a.label, b.label);
  assert.equal(a.balance, b.balance);
  assert.equal(result.report.status, "fail");
});
test("success receipts cannot conceal an unsaved operation", () => {
  const result = runLabCase({ mutation: "no_persistence" });
  const snapshot = Object.values(result.evidence)[1];
  assert.ok(snapshot.receipts.every((r) => r.status === "success"));
  assert.equal(snapshot.persisted.effects.length, 0);
  assert.equal(result.case.replacement.observations[0].value.balance, 10000);
  assert.equal(result.report.status, "fail");
});
test("generated inputs exercise both implementations and every mutation", () => {
  for (let n = 1; n <= 20; n++) {
    for (const workflow of ["accounting", "retail"]) {
      const input =
        workflow === "accounting"
          ? {
              customer: `Generated Customer ${n}`,
              total: n * 791 + 113,
              payment: n * 193 + 17,
            }
          : {
              product: `Generated Product ${n}`,
              stock: n * 5 + 3,
              quantity: n + 2,
              returned: n,
              unitPrice: n * 97 + 31,
            };
      for (const mutation of [
        "none",
        "wrong_amount",
        "wrong_relationship",
        "no_persistence",
        "duplicate_retry",
      ]) {
        const result = runLabCase({ workflow, mutation, input });
        assert.equal(
          result.report.status,
          mutation === "none" ? "pass" : "fail",
          `${workflow}, ${mutation}, input ${n}`,
        );
        const reference = result.case.reference.observations[0].value;
        if (workflow === "accounting")
          assert.equal(reference.balance, input.total - input.payment);
        else {
          assert.equal(
            reference.stock,
            input.stock - input.quantity + input.returned,
          );
          assert.equal(
            reference.net,
            (input.quantity - input.returned) * input.unitPrice,
          );
        }
      }
    }
  }
});
test("file-write failures propagate and remove owned temporary directories", () => {
  const root = mkdtempSync(join(tmpdir(), "rea-lab-failure-test-"));
  const moduleUrl = new URL("./lib/saas-compatibility-lab.mjs", import.meta.url)
    .href;
  const program = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    let writes = 0;
    let failAt = 1;
    const original = fs.writeFileSync;
    fs.writeFileSync = (...args) => {
      if (++writes === failAt) throw new Error('injected-write-failure');
      return original(...args);
    };
    syncBuiltinESMExports();
    const { runLabCase } = await import(${JSON.stringify(moduleUrl)});
    for (const workflow of ['accounting', 'retail']) {
      for (const point of [1, 4, 5, 6]) {
        writes = 0;
        failAt = point;
        assert.throws(() => runLabCase({ workflow }), /injected-write-failure/);
        assert.deepEqual(fs.readdirSync(${JSON.stringify(root)}), []);
      }
    }
  `;
  try {
    execFileSync(process.execPath, ["--input-type=module", "--eval", program], {
      env: { ...process.env, TMPDIR: root, TEMP: root, TMP: root },
      timeout: 10000,
      stdio: "pipe",
    });
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports identify the actual implementation source revision", () => {
  const result = runLabCase();
  assert.match(result.case.reference.revision, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(
    result.case.replacement.revision,
    result.report.runs.replacement.revision,
  );
});
