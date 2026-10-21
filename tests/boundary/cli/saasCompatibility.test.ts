import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("verifies the offline SaaS compatibility companion and its CLI", () => {
  const suite = fileURLToPath(
    new URL("../../../scripts/saas-compatibility.test.mjs", import.meta.url),
  );
  const output = execFileSync(process.execPath, ["--test", suite], {
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(output).toContain("fail 0");
});
