#!/usr/bin/env node
import { runLab } from "./lib/saas-compatibility-lab.mjs";
if (process.argv.length !== 2) {
  console.error("Usage: node scripts/saas-compatibility-lab.mjs");
  process.exitCode = 2;
} else {
  try {
    const report = runLab();
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === "pass" ? 0 : 1;
  } catch (error) {
    console.error(`Synthetic lab failed: ${error.message}`);
    process.exitCode = 2;
  }
}
