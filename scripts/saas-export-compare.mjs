#!/usr/bin/env node
import { dirname, basename, resolve } from "node:path";
import {
  readBoundedExport,
  parseExportJson,
  compareExports,
} from "./lib/saas-export-comparison.mjs";
const args = process.argv.slice(2);
if (args.length !== 1) {
  console.error("Usage: node scripts/saas-export-compare.mjs MANIFEST.json");
  process.exitCode = 2;
} else {
  try {
    const path = resolve(args[0]);
    const input = await readBoundedExport(
      dirname(path),
      basename(path),
      1024 * 1024,
    );
    const report = await compareExports(
      parseExportJson(input.text),
      dirname(path),
    );
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode =
      report.status === "pass" ? 0 : report.status === "fail" ? 1 : 2;
  } catch (error) {
    console.error(`Cannot compare exports: ${error.message}`);
    process.exitCode = 2;
  }
}
