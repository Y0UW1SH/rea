#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import {
  evaluateCompatibility,
  parseCompatibilityJson,
} from "./lib/saas-compatibility.mjs";
const args = process.argv.slice(2);
if (args.length !== 1) {
  console.error("Usage: node scripts/saas-compatibility.mjs CASE.json");
  process.exitCode = 2;
} else {
  try {
    const report = evaluateCompatibility(
      parseCompatibilityJson(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          await readFile(args[0]),
        ),
      ),
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode =
      report.status === "pass" ? 0 : report.status === "fail" ? 1 : 2;
  } catch (error) {
    process.stderr.write(
      `Cannot evaluate compatibility case: ${error.message}\n`,
    );
    process.exitCode = 2;
  }
}
