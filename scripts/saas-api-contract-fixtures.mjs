#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  CONTRACT_FIXTURE_VARIANTS,
  buildContractFixture,
  contractFixtureManifest,
  serializeFixture,
} from "./lib/saas-api-contract-fixture.mjs";

// Regenerates (default) or checks (--check) the committed synthetic captures under
// scripts/fixtures/saas-api-contract/. Committed bytes must equal the builder output.
const directory = fileURLToPath(
  new URL("./fixtures/saas-api-contract/", import.meta.url),
);
const args = process.argv.slice(2);
const check = args[0] === "--check";
if (args.length > 1 || (args.length === 1 && !check)) {
  console.error("Usage: node scripts/saas-api-contract-fixtures.mjs [--check]");
  process.exitCode = 2;
} else {
  const files = [
    ["manifest.json", serializeFixture(contractFixtureManifest())],
    ...CONTRACT_FIXTURE_VARIANTS.map((variant) => [
      `${variant}.json`,
      serializeFixture(buildContractFixture(variant)),
    ]),
  ];
  let stale = 0;
  if (!check) await mkdir(directory, { recursive: true });
  for (const [name, expected] of files) {
    const path = new URL(name, `file://${directory.replaceAll("\\", "/")}/`);
    if (check) {
      const actual = await readFile(path, "utf8").catch(() => null);
      if (actual !== expected) {
        stale += 1;
        console.error(`stale fixture: ${name}`);
      }
    } else await writeFile(path, expected);
  }
  if (check) {
    console.log(
      stale === 0 ? "fixtures are current" : `${stale} stale fixture(s)`,
    );
    process.exitCode = stale === 0 ? 0 : 1;
  } else console.log(`wrote ${files.length} fixtures to ${directory}`);
}
