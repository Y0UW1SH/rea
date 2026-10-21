#!/usr/bin/env node
import { reconcileSurface } from "./lib/saas-surface-coverage.mjs";
import { exitCodeFor, readSurfaceFile } from "./lib/saas-surface-report.mjs";
import { serializeReport } from "./lib/saas-report-json.mjs";

const USAGE = [
  "Usage:",
  "  node scripts/saas-surface-coverage.mjs --static ANALYSIS.json --observed OBSERVED.json [--observed ...]",
  "      [--origins ORIGINS.json] [--profile PROFILE.json --workflow-id ID] [--workflow-id ID]",
  "Exit 0 when every declared endpoint, operation, procedure and route was exercised,",
  "1 when gaps were found, 2 when an input is invalid or unreadable.",
].join("\n");
const emit = (report) => process.stdout.write(serializeReport(report));

function parseArguments(argv) {
  const options = { observed: [] };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(USAGE);
    if (flag === "--observed") options.observed.push(value);
    else if (
      ["--static", "--origins", "--profile", "--workflow-id"].includes(flag) &&
      options[flag.slice(2)] === undefined
    )
      options[flag.slice(2)] = value;
    else throw new Error(USAGE);
  }
  if (
    options.static === undefined ||
    options.observed.length === 0 ||
    (options.profile !== undefined && options["workflow-id"] === undefined)
  )
    throw new Error(USAGE);
  return options;
}

try {
  const options = parseArguments(process.argv.slice(2));
  const inputs = {
    static: await readSurfaceFile(options.static),
    observed: [],
    workflowId: options["workflow-id"],
  };
  for (const path of options.observed)
    inputs.observed.push(await readSurfaceFile(path));
  if (options.origins !== undefined)
    inputs.origins = (await readSurfaceFile(options.origins)).value;
  if (options.profile !== undefined)
    inputs.profile = await readSurfaceFile(options.profile);
  const report = reconcileSurface(inputs);
  emit(report);
  process.exitCode = exitCodeFor(report);
} catch (error) {
  console.error(
    error instanceof Error && error.message !== USAGE
      ? `Cannot run surface coverage: ${error.message}`
      : USAGE,
  );
  process.exitCode = 2;
}
