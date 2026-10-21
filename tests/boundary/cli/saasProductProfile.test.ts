import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
it("validates SaaS profile plans and exposes unknown setup through the CLI", () => {
  const script = fileURLToPath(
    new URL("../../../scripts/saas-product-profile.mjs", import.meta.url),
  );
  const fixture = fileURLToPath(
    new URL(
      "../../../scripts/fixtures/saas-profiles/lightspeed.json",
      import.meta.url,
    ),
  );
  const suite = fileURLToPath(
    new URL("../../../scripts/saas-product-profile.test.mjs", import.meta.url),
  );
  const output = execFileSync(process.execPath, [script, fixture], {
    encoding: "utf8",
    timeout: 30000,
  });
  expect(JSON.parse(output)).toMatchObject({
    status: "valid_plan",
    coverage: { verified: 0 },
  });
  expect(
    execFileSync(process.execPath, ["--test", suite], {
      encoding: "utf8",
      timeout: 30000,
    }),
  ).toContain("fail 0");
});
