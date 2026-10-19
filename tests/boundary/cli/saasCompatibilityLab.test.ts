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
