#!/usr/bin/env node
import { basename, dirname, resolve } from "node:path";
import {
  decodeExportText,
  parseExportJson,
  readBoundedExport,
} from "./lib/saas-export-comparison.mjs";
import {
  inferContract,
  verifyContract,
  writeContract,
} from "./lib/saas-api-contract.mjs";

const USAGE = [
  "Usage:",
  "  node scripts/saas-api-contract.mjs infer MANIFEST.json --out DIR",
  "  node scripts/saas-api-contract.mjs verify CONTRACT_DIR CAPTURE.json [--origin-map REF=REP]...",
].join("\n");
const emit = (report) =>
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
const fail = (message) => {
  console.error(message);
  process.exitCode = 2;
};

const [mode, ...rest] = process.argv.slice(2);
try {
  if (mode === "infer") {
    const outIndex = rest.indexOf("--out");
    if (rest.length !== 3 || outIndex !== 1) throw new Error(USAGE);
    const manifestPath = resolve(rest[0]);
    const source = await readBoundedExport(
      dirname(manifestPath),
      basename(manifestPath),
      1024 * 1024,
    );
    const manifest = parseExportJson(decodeExportText(source));
    const result = await inferContract(manifest, dirname(manifestPath));
    if (result.status === "produced") {
      await writeContract(resolve(rest[2]), result);
      emit(result.report);
      process.exitCode = 0;
    } else {
      emit(result.report);
      process.exitCode = 2;
    }
  } else if (mode === "verify") {
    if (rest.length < 2) throw new Error(USAGE);
    const [contractDirectory, capturePath, ...flags] = rest;
    const originPairs = [];
    for (let index = 0; index < flags.length; index += 2) {
      const separator = flags[index + 1]?.indexOf("=") ?? -1;
      if (flags[index] !== "--origin-map" || separator < 1)
        throw new Error(USAGE);
      originPairs.push({
        before_origin: flags[index + 1].slice(0, separator),
        after_origin: flags[index + 1].slice(separator + 1),
      });
    }
    const capture = resolve(capturePath);
    const report = await verifyContract(
      resolve(contractDirectory),
      dirname(capture),
      basename(capture),
      { originPairs },
    );
    emit(report);
    process.exitCode =
      report.status === "pass" ? 0 : report.status === "fail" ? 1 : 2;
  } else throw new Error(USAGE);
} catch (error) {
  fail(
    error instanceof Error && error.message !== USAGE
      ? `Cannot run contract command: ${error.message}`
      : USAGE,
  );
}
