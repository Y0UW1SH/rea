#!/usr/bin/env node
import { basename, dirname, resolve } from "node:path";
import { checkStudyEvidence, readStudyManifest } from "./lib/saas-study.mjs";

const [mode, file, ...flags] = process.argv.slice(2);
const usage =
  "Usage: node scripts/saas-study.mjs validate STUDY.json [--check-evidence]";
if (
  mode !== "validate" ||
  !file ||
  flags.length > 1 ||
  (flags.length === 1 && flags[0] !== "--check-evidence")
) {
  console.error(usage);
  process.exitCode = 2;
} else {
  const path = resolve(file);
  const result = await readStudyManifest(dirname(path), basename(path));
  if (result.status === "valid" && flags.length === 1)
    result.evidence = await checkStudyEvidence(result.study, dirname(path));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode =
    result.status !== "valid"
      ? 2
      : result.evidence?.status === "fail"
        ? 1
        : result.evidence && result.evidence.status !== "verified"
          ? 2
          : 0;
}
