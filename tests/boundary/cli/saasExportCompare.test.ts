import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
it("compares selected offline export contents through the CLI", () => {
  const script = fileURLToPath(
    new URL("../../../scripts/saas-export-compare.mjs", import.meta.url),
  );
  const fixture = fileURLToPath(
    new URL(
      "../../../scripts/fixtures/saas-exports/manifest.json",
      import.meta.url,
    ),
  );
  const suite = fileURLToPath(
    new URL("../../../scripts/saas-export-compare.test.mjs", import.meta.url),
  );
  expect(
    JSON.parse(
      execFileSync(process.execPath, [script, fixture], {
        encoding: "utf8",
        timeout: 30000,
      }),
    ),
  ).toMatchObject({
    status: "pass",
    reference: { records: 2, excludedFields: ["note"] },
  });
  expect(
    execFileSync(process.execPath, ["--test", suite], {
      encoding: "utf8",
      timeout: 30000,
    }),
  ).toContain("fail 0");
});
