#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  serializeFixture,
  surfaceFixtureFiles,
} from "./lib/saas-surface-fixture.mjs";

// Fixtures under scripts/fixtures/saas-surface/:
//   default      regenerate the builder-made files (api-surface.json, scenario-capture.json,
//                origins.json, profile.json); bundle/main.js is a hand-authored input.
//   --import F   normalize the JSON that `rea analyze-javascript-application
//                scripts/fixtures/saas-surface/bundle --artifact-format directory --format json`
//                printed into static-analysis.json: the recorded input paths become the
//                repository-relative bundle path and the bytes take the committed serialization.
//   --check      committed builder files must equal the builder output, and
//                static-analysis.json must be normalized and byte-stable.
const directory = new URL("./fixtures/saas-surface/", import.meta.url);
const BUNDLE_PATH = "scripts/fixtures/saas-surface/bundle";
const STATIC_FILE = "static-analysis.json";
const USAGE =
  "Usage: node scripts/saas-surface-fixtures.mjs [--check | --import ANALYSIS.json]";

const plain = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * The committed form of one CLI analysis: the normalized_result of the Evidence envelope
 * the CLI prints (or that result itself) with the recorded input path made
 * repository-relative. The envelope is dropped because its evidence_id authenticates
 * the record as written for the original absolute path.
 */
function normalizeAnalysis(printed) {
  if (!plain(printed))
    throw new Error("import: expected the JSON the CLI prints");
  const result = plain(printed.normalized_result)
    ? printed.normalized_result
    : printed;
  if (!plain(result.graph) || typeof result.root_artifact_sha256 !== "string")
    throw new Error(
      "import: expected an analyze_javascript_application result",
    );
  return { ...structuredClone(result), input_path: BUNDLE_PATH };
}

async function checkStatic() {
  const path = new URL(STATIC_FILE, directory);
  const actual = await readFile(path, "utf8").catch(() => null);
  if (actual === null) return `missing fixture: ${STATIC_FILE}`;
  let parsed;
  try {
    parsed = normalizeAnalysis(JSON.parse(actual));
  } catch (error) {
    return `${STATIC_FILE}: ${error instanceof Error ? error.message : error}`;
  }
  return serializeFixture(parsed) === actual
    ? null
    : `stale fixture: ${STATIC_FILE} (not normalized or not in the committed serialization)`;
}

const args = process.argv.slice(2);
try {
  if (args[0] === "--import" && args.length === 2) {
    const printed = JSON.parse(await readFile(args[1], "utf8"));
    await mkdir(directory, { recursive: true });
    await writeFile(
      new URL(STATIC_FILE, directory),
      serializeFixture(normalizeAnalysis(printed)),
    );
    console.log(`wrote ${STATIC_FILE} to ${fileURLToPath(directory)}`);
  } else if (
    args.length === 0 ||
    (args.length === 1 && args[0] === "--check")
  ) {
    const check = args.length === 1;
    const files = surfaceFixtureFiles();
    const problems = [];
    if (!check) await mkdir(directory, { recursive: true });
    for (const [name, expected] of files) {
      const path = new URL(name, directory);
      if (!check) await writeFile(path, expected);
      else if ((await readFile(path, "utf8").catch(() => null)) !== expected)
        problems.push(`stale fixture: ${name}`);
    }
    if (check) {
      const stale = await checkStatic();
      if (stale !== null) problems.push(stale);
      for (const problem of problems) console.error(problem);
      console.log(
        problems.length === 0
          ? "fixtures are current"
          : `${problems.length} stale fixture(s)`,
      );
      process.exitCode = problems.length === 0 ? 0 : 1;
    } else
      console.log(
        `wrote ${files.length} fixtures to ${fileURLToPath(directory)}`,
      );
  } else throw new Error(USAGE);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
