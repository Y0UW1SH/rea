#!/usr/bin/env node
import { runLab } from "./lib/saas-compatibility-lab.mjs";
import { serializeReport } from "./lib/saas-report-json.mjs";
if (process.argv.length !== 2) {
  console.error("Usage: node scripts/saas-compatibility-lab.mjs");
  process.exitCode = 2;
} else {
  try {
    const report = runLab();
    process.stdout.write(serializeReport(report));
    process.exitCode = report.status === "pass" ? 0 : 1;
  } catch (error) {
    console.error(`Synthetic lab failed: ${error.message}`);
    process.exitCode = 2;
  }
}
