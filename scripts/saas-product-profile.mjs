#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { inspectProductProfile } from "./lib/saas-product-profile.mjs";
import { serializeReport } from "./lib/saas-report-json.mjs";
try {
  if (process.argv.length !== 3)
    throw new Error(
      "Usage: node scripts/saas-product-profile.mjs PROFILE.json",
    );
  const report = inspectProductProfile(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        await readFile(process.argv[2]),
      ),
    ),
  );
  process.stdout.write(serializeReport(report));
  process.exitCode = report.status === "invalid" ? 2 : 0;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}
