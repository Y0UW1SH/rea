import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("executes independent synthetic SaaS workflows and detects seeded defects", () => {
  const suite = fileURLToPath(
    new URL(
      "../../../scripts/saas-compatibility-lab.test.mjs",
      import.meta.url,
    ),
  );
  const output = execFileSync(process.execPath, ["--test", suite], {
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(output).toContain("fail 0");
});

it("runs the documented lab command and returns a synthetic report", () => {
  const script = fileURLToPath(
    new URL("../../../scripts/saas-compatibility-lab.mjs", import.meta.url),
  );
  const output = execFileSync(process.execPath, [script], {
    encoding: "utf8",
    timeout: 30000,
  });
  expect(JSON.parse(output)).toMatchObject({
    kind: "synthetic-workflow-lab",
    status: "pass",
  });
});
