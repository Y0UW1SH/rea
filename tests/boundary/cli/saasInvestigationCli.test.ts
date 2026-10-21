import { execFile } from "node:child_process";
import { expect, test } from "vitest";

test("installed CLI exposes live investigations and reports shared input diagnostics", async () => {
  const result = await new Promise<{
    code: number | string | undefined;
    stdout: string;
  }>((resolve) => {
    execFile(
      process.execPath,
      ["scripts/rea.mjs", "run-saas-investigation", "{}", "--json"],
      { timeout: 30000 },
      (error, stdout) => resolve({ code: error?.code, stdout }),
    );
  });
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    code: "invalid_request",
    details: {
      operation: "run_saas_investigation",
      issues: [{ path: ["plan"] }, { path: ["journal_path"] }],
    },
  });
});
