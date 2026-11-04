import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { evaluateCompatibility } from "./lib/saas-compatibility.mjs";
const fixture = (name = "accounting") =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/saas-compatibility/${name}.json`, import.meta.url),
    ),
  );
const evaluate = (modify, name) => {
  const input = fixture(name);
  modify?.(input);
  return evaluateCompatibility(input);
};
test("synthetic accounting and retail pass with explicit identities", () => {
  for (const name of ["accounting", "retail"])
    assert.equal(evaluate(undefined, name).status, "pass");
});
test("wrong business amount fails", () =>
  assert.equal(
    evaluate((x) => {
      x.replacement.observations[0].value.balance = 61;
    }).status,
    "fail",
  ));
test("wrong relationship remains visible", () =>
  assert.equal(
    evaluate((x) => {
      x.replacement.observations[0].value.customer.$entity.id = "wrong";
    }).status,
    "unknown",
  ));
test("missing observation cannot pass", () =>
  assert.equal(
    evaluate((x) => {
      x.replacement.observations = [];
    }).status,
    "unknown",
  ));
test("toast without persisted read cannot pass", () =>
  assert.equal(
    evaluate((x) => {
      x.replacement.observations[0].kind = "ui";
    }).status,
    "unknown",
  ));
test("stale observation cannot establish persistence", () =>
  assert.equal(
    evaluate((x) => {
      x.replacement.observations[0].elapsedMs = 0;
    }).status,
    "unknown",
  ));
test("deadline exhausted differs from observer stopping early", () => {
  const early = evaluate((x) => {
    x.replacement.observations = [];
  });
  const late = evaluate((x) => {
    x.replacement.observations = [];
    x.replacement.windows[0].observedUntilMs = 1000;
  });
  assert.equal(early.checks[0].reason, "observation_incomplete");
  assert.equal(late.checks[0].reason, "deadline_exceeded");
  assert.equal(late.status, "fail");
});
test("late result does not satisfy deadline", () =>
  assert.equal(
    evaluate((x) => {
      x.replacement.observations[0].elapsedMs = 1001;
      x.replacement.windows[0].observedUntilMs = 1001;
    }).status,
    "fail",
  ));
test("context mismatch and unknown provenance are unknown", () => {
  assert.equal(
    evaluate((x) => {
      x.replacement.context.currency.value = "EUR";
    }).status,
    "unknown",
  );
  assert.equal(
    evaluate((x) => {
      x.replacement.context.currency = { provenance: "unknown" };
    }).status,
    "unknown",
  );
});
test("duplicate and ambiguous mappings reject input", () => {
  assert.equal(
    evaluate((x) => {
      x.entities.push(structuredClone(x.entities[0]));
    }).status,
    "invalid",
  );
  assert.equal(
    evaluate((x) => {
      x.entities.push({ ...x.entities[0], logicalId: "other" });
    }).status,
    "invalid",
  );
});
test("mapping cannot normalize an amount or unrelated entity type", () => {
  assert.equal(
    evaluate((x) => {
      x.replacement.observations[0].value.balance = "c18";
    }).status,
    "fail",
  );
  assert.equal(
    evaluate((x) => {
      x.replacement.observations[0].value.customer.$entity.type = "product";
    }).status,
    "unknown",
  );
});
test("duplicate records differ", () =>
  assert.equal(
    evaluate((x) => {
      x.replacement.observations[0].value.extra = [1, 1];
    }).status,
    "fail",
  ));
test("malformed and unknown keys fail closed", () => {
  for (const modify of [
    (x) => {
      x.checks = [];
    },
    (x) => {
      x.checks[0].persisted = "yes";
    },
    (x) => {
      x.extra = true;
    },
    (x) => {
      x.replacement.observations[0].evidence = [];
    },
    (x) => {
      x.replacement.windows[0].coverage = "truncated";
    },
  ])
    assert.equal(evaluate(modify).status, "invalid");
  for (const input of [null, [], {}, { version: 1 }])
    assert.equal(evaluateCompatibility(input).status, "invalid");
});
test("wrong relationship to another explicitly mapped customer fails", () => {
  assert.equal(
    evaluate((x) => {
      const second = structuredClone(x.entities[0]);
      second.logicalId = "second-customer";
      second.reference.id = "6733";
      second.replacement.id = "c19";
      x.entities.push(second);
      x.replacement.observations[0].value.customer.$entity.id = "c19";
    }).status,
    "fail",
  );
});
test("JSON objects cannot impersonate normalized identity values", () =>
  assert.equal(
    evaluate((x) => {
      x.replacement.observations[0].value.customer = {
        $logicalEntity: '["customer","test-customer"]',
      };
    }).status,
    "fail",
  ));
test("prototype names cannot satisfy absent context requirements", () =>
  assert.equal(
    evaluate((x) => {
      x.contextKeys.push("__proto__");
    }).status,
    "unknown",
  ));
test("incomplete capture never passes even with matching visible observations", () =>
  assert.equal(
    evaluate((x) => {
      x.replacement.windows[0].coverage = "incomplete";
    }).status,
    "unknown",
  ));
test("reload returning an old balance fails", () =>
  assert.equal(
    evaluate((x) => {
      const old = structuredClone(x.replacement.observations[0]);
      old.elapsedMs = 200;
      old.value.balance = 100;
      x.replacement.observations.push(old);
      x.replacement.windows[0].observedUntilMs = 200;
    }).status,
    "fail",
  ));
test("mapping order does not change comparison results", () =>
  assert.equal(
    evaluate((x) => {
      x.entities.reverse();
    }).status,
    "pass",
  ));
test("wrong entity scope and ambiguous observation timestamps are invalid", () => {
  assert.equal(
    evaluate((x) => {
      x.entities[0].reference.workspace = "other";
    }).status,
    "invalid",
  );
  assert.equal(
    evaluate((x) => {
      x.replacement.observations.push(
        structuredClone(x.replacement.observations[0]),
      );
    }).status,
    "invalid",
  );
});
test("deliberately incorrect synthetic fixture outcomes fail", () => {
  for (const name of ["accounting-incorrect", "retail-incorrect"])
    assert.equal(evaluate(undefined, name).status, "fail");
});

test("CLI emits evidence-linked reports and distinct exit codes", () => {
  const cli = fileURLToPath(
    new URL("./saas-compatibility.mjs", import.meta.url),
  );
  for (const [name, status, exit] of [
    ["accounting", "pass", 0],
    ["retail-incorrect", "fail", 1],
  ]) {
    const input = fileURLToPath(
      new URL(`./fixtures/saas-compatibility/${name}.json`, import.meta.url),
    );
    const result = spawnSync(process.execPath, [cli, input], {
      encoding: "utf8",
    });
    assert.equal(result.status, exit, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, status);
    assert.ok(report.checks[0].replacement.evidence.length);
  }
  const missing = spawnSync(process.execPath, [cli], { encoding: "utf8" });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /Usage:/);
});
test("run capture date and revision are required and preserved", () => {
  for (const date of [
    "2026-02-30T00:00:00.000Z",
    "yesterday",
    "2026-10-19",
    "2026-10-19T00:00:00Z",
  ]) {
    assert.equal(
      evaluate((x) => {
        x.reference.collectedAt = date;
      }).status,
      "invalid",
    );
  }
  assert.equal(
    evaluate((x) => {
      delete x.replacement.revision;
    }).status,
    "invalid",
  );
  const report = evaluate();
  assert.equal(report.runs.replacement.revision, "synthetic-fixture-v1");
  assert.equal(report.runs.reference.collectedAt, "2026-10-19T00:00:00.000Z");
  assert.equal(report.contextAlignment, "conditional_on_caller_declarations");
});
test("report retains the exact predicate and observation window for audit", () => {
  const report = evaluate();
  assert.deepEqual(report.contextKeys, ["currency", "role"]);
  assert.equal(report.checks[0].persisted, true);
  assert.equal(report.checks[0].deadlineMs, 1000);
  assert.equal(report.checks[0].observation, "saved-record");
  assert.equal(report.checks[0].replacement.window.coverage, "complete");
  assert.equal(report.checks[0].replacement.window.observedUntilMs, 100);
});

test("unsafe numeric observation and context values cannot pass", () => {
  for (const value of [
    Number.MAX_SAFE_INTEGER + 1,
    Number.MIN_SAFE_INTEGER - 1,
    1e20,
    Infinity,
    -Infinity,
    NaN,
  ]) {
    for (const context of [false, true]) {
      const input = fixture();
      for (const side of ["reference", "replacement"]) {
        if (context) input[side].context.currency.value = { nested: [value] };
        else input[side].observations[0].value.balance = value;
      }
      const before = structuredClone(input);
      assert.equal(evaluateCompatibility(input).status, "invalid");
      assert.deepEqual(input, before);
    }
  }
});

test("supported numeric values and exact numeric strings remain literal", () => {
  for (const value of [
    Number.MAX_SAFE_INTEGER,
    Number.MIN_SAFE_INTEGER,
    0,
    -0,
    0.1,
    -123.45,
    1e-7,
    Number.MIN_VALUE,
    "9007199254740993",
    "1.0000000000000001",
  ]) {
    const input = fixture();
    for (const side of ["reference", "replacement"])
      input[side].observations[0].value.balance = value;
    const before = structuredClone(input);
    assert.equal(evaluateCompatibility(input).status, "pass");
    assert.deepEqual(input, before);
  }
  assert.equal(
    evaluate((x) => {
      x.reference.observations[0].value.balance = "9007199254740992";
      x.replacement.observations[0].value.balance = "9007199254740993";
    }).status,
    "fail",
  );
});

test("CLI rejects numeric token information loss before comparison", () => {
  const directory = mkdtempSync(join(tmpdir(), "rea-saas-numbers-"));
  const file = join(directory, "case.json");
  const cli = fileURLToPath(
    new URL("./saas-compatibility.mjs", import.meta.url),
  );
  const input = fixture();
  input.reference.observations[0].value.balance = "REFERENCE_NUMBER";
  input.replacement.observations[0].value.balance = "REPLACEMENT_NUMBER";
  const source = JSON.stringify(input);
  try {
    for (const [before, after] of [
      ["9007199254740992", "9007199254740993"],
      ["-9007199254740992", "-9007199254740993"],
      ["9007199254740992.0", "9007199254740993.0"],
      ["9.007199254740992e15", "9.007199254740993e15"],
      ["1", "1.0000000000000001"],
      ["0.12345678901234568", "0.123456789012345678"],
      ["0", "1e-400"],
      ["0", "-1e-400"],
      ["1e400", "1e400"],
    ]) {
      writeFileSync(
        file,
        source
          .replace('"REFERENCE_NUMBER"', before)
          .replace('"REPLACEMENT_NUMBER"', after),
      );
      const result = spawnSync(process.execPath, [cli, file], {
        encoding: "utf8",
      });
      assert.equal(result.status, 2, `${before} / ${after}: ${result.stdout}`);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /number.*string/i);
    }
    for (const [before, after] of [
      ["1e3", "1000"],
      ["1.2300e2", "123"],
      ["-1e-7", "-0.0000001"],
      ["0.1", "0.10"],
      ["-0", "-0.0"],
      ["5e-324", "5e-324"],
      ["9007199254740991", "9007199254740991.0"],
      ["-9007199254740991", "-9007199254740991.0"],
    ]) {
      writeFileSync(
        file,
        source
          .replace('"REFERENCE_NUMBER"', before)
          .replace('"REPLACEMENT_NUMBER"', after),
      );
      const result = spawnSync(process.execPath, [cli, file], {
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).status, "pass");
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI rejects malformed UTF-8 before different bytes can compare equal", () => {
  const directory = mkdtempSync(join(tmpdir(), "rea-saas-utf8-"));
  const file = join(directory, "case.json");
  const cli = fileURLToPath(
    new URL("./saas-compatibility.mjs", import.meta.url),
  );
  const input = fixture();
  input.reference.observations[0].value.label = "REFERENCE_TEXT";
  input.replacement.observations[0].value.label = "REPLACEMENT_TEXT";
  const [start, rest] = JSON.stringify(input).split("REFERENCE_TEXT");
  const [middle, end] = rest.split("REPLACEMENT_TEXT");
  try {
    for (const bytes of [
      [0x80],
      [0xc0, 0xaf],
      [0xed, 0xa0, 0x80],
      [0xf4, 0x90, 0x80, 0x80],
      [0xe2, 0x82],
    ]) {
      for (const [reference, replacement] of [
        [Buffer.from(bytes), Buffer.from([0x81])],
        [Buffer.from(bytes), Buffer.from("\ufffd")],
        [Buffer.from("valid"), Buffer.from(bytes)],
      ]) {
        writeFileSync(
          file,
          Buffer.concat([
            Buffer.from(start),
            reference,
            Buffer.from(middle),
            replacement,
            Buffer.from(end),
          ]),
        );
        const result = spawnSync(process.execPath, [cli, file], {
          encoding: "utf8",
        });
        assert.equal(result.status, 2, `${bytes}: ${result.stdout}`);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /utf-8/i);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI preserves valid Unicode values and its leading-BOM rejection", () => {
  const directory = mkdtempSync(join(tmpdir(), "rea-saas-unicode-"));
  const file = join(directory, "case.json");
  const cli = fileURLToPath(
    new URL("./saas-compatibility.mjs", import.meta.url),
  );
  try {
    for (const [reference, replacement, status] of [
      ["客户 café 😀 \ufffd \ufeff", "客户 café 😀 \ufffd \ufeff", "pass"],
      ["é", "e\u0301", "fail"],
      ["\ufffd", "different", "fail"],
      ["\ufeffx", "x", "fail"],
    ]) {
      const input = fixture();
      input.reference.observations[0].value.label = reference;
      input.replacement.observations[0].value.label = replacement;
      writeFileSync(file, JSON.stringify(input));
      const result = spawnSync(process.execPath, [cli, file], {
        encoding: "utf8",
      });
      assert.equal(result.status, status === "pass" ? 0 : 1, result.stderr);
      assert.equal(JSON.parse(result.stdout).status, status);
    }
    writeFileSync(file, `\ufeff${JSON.stringify(fixture())}`);
    const result = spawnSync(process.execPath, [cli, file], {
      encoding: "utf8",
    });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
