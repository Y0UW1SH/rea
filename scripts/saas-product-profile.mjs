#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { inspectProductProfile } from "./lib/saas-product-profile.mjs";
try {
  if (process.argv.length !== 3)
    throw new Error(
      "Usage: node scripts/saas-product-profile.mjs PROFILE.json",
    );
  const report = inspectProductProfile(
    JSON.parse(await readFile(process.argv[2], "utf8")),
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.status === "invalid" ? 2 : 0;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
}
