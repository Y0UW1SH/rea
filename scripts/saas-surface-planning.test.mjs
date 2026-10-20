import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectProductProfile } from "./lib/saas-product-profile.mjs";
import { reconcileSurface } from "./lib/saas-surface-coverage.mjs";
import {
  buildSurfaceApiSurface,
  buildSurfaceCapture,
  surfaceFixtureFiles,
  surfaceOrigins,
} from "./lib/saas-surface-fixture.mjs";
import {
  BUNDLE_FINDINGS,
  EXERCISED_VALUES,
  analysisOf,
  cliPath,
  expectedBundleStatuses,
  fixtureInputs,
  fixturesDirectory,
  generatorPath,
  genericProfile,
  input,
  statusesOf,
} from "./saas-surface-test-support.mjs";

// Profile planning, the CLI contract and the committed fixtures of the surface
// coverage companion.

test("appends experiments to a profile without overwriting existing ones", () => {
  const report = reconcileSurface(
    fixtureInputs({
      profile: input("profile.json", genericProfile()),
      workflowId: "first-workflow",
    }),
  );
  assert.equal(report.status, "complete", report.reason);
  const update = report.profileUpdate;
  assert.equal(update.profileId, "generic-planning-template");
  assert.equal(update.workflowId, "first-workflow");
  assert.deepEqual(
    update.added,
    report.experiments.map((experiment) => experiment.id),
  );
  assert.deepEqual(update.existing, []);
  assert.equal(update.profile.experiments.length, 8);
  assert.equal(update.profile.experiments[0].id, "fresh-read");
  assert.ok(
    report.experiments.every(
      (experiment) => experiment.workflowId === "first-workflow",
    ),
  );
  assert.equal(inspectProductProfile(update.profile).status, "valid_plan");
  const edited = structuredClone(update.profile);
  edited.experiments[1].uncertainty = "edited by the operator";
  const again = reconcileSurface(
    fixtureInputs({
      profile: input("profile.json", edited),
      workflowId: "first-workflow",
    }),
  );
  assert.deepEqual(again.profileUpdate.added, []);
  assert.equal(again.profileUpdate.existing.length, 7);
  assert.deepEqual(again.profileUpdate.profile.experiments, edited.experiments);
  assert.match(
    reconcileSurface(
      fixtureInputs({
        profile: input("profile.json", genericProfile()),
        workflowId: "absent-workflow",
      }),
    ).reason,
    /workflow absent-workflow/u,
  );
  assert.equal(
    reconcileSurface(
      fixtureInputs({
        profile: input("profile.json", { ...genericProfile(), version: 2 }),
        workflowId: "first-workflow",
      }),
    ).status,
    "invalid",
  );
});

test("CLI maps exit codes to all exercised, gaps found and invalid input", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rea-surface-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = async (name, value) => {
    const path = join(dir, name);
    await writeFile(path, `${JSON.stringify(value)}\n`);
    return path;
  };
  const gaps = await file("static.json", analysisOf(BUNDLE_FINDINGS));
  const exercised = await file(
    "exercised.json",
    analysisOf(
      BUNDLE_FINDINGS.filter(({ value }) => EXERCISED_VALUES.has(value)),
    ),
  );
  const surface = await file("api-surface.json", buildSurfaceApiSurface());
  const capture = await file("capture.json", buildSurfaceCapture());
  const origins = await file("origins.json", surfaceOrigins());
  const profile = await file("profile.json", genericProfile());
  const run = (args) =>
    spawnSync(process.execPath, [cliPath, ...args], {
      encoding: "utf8",
      timeout: 60_000,
    });
  const observed = ["--observed", surface, "--observed", capture];
  const found = run(["--static", gaps, ...observed, "--origins", origins]);
  assert.equal(found.status, 1, found.stderr);
  assert.equal(JSON.parse(found.stdout).gaps, 7);
  const clean = run(["--static", exercised, ...observed, "--origins", origins]);
  assert.equal(clean.status, 0, clean.stderr);
  const cleanReport = JSON.parse(clean.stdout);
  assert.equal(cleanReport.gaps, 0);
  assert.deepEqual(cleanReport.experiments, []);
  const planned = run([
    "--static",
    gaps,
    ...observed,
    "--origins",
    origins,
    "--profile",
    profile,
    "--workflow-id",
    "first-workflow",
  ]);
  assert.equal(planned.status, 1, planned.stderr);
  assert.equal(JSON.parse(planned.stdout).profileUpdate.added.length, 7);
  const invalid = run(["--static", gaps, "--observed", origins]);
  assert.equal(invalid.status, 2);
  assert.equal(JSON.parse(invalid.stdout).status, "invalid");
  assert.equal(
    run(["--static", join(dir, "absent.json"), ...observed]).status,
    2,
  );
  for (const args of [
    [],
    ["--static", gaps],
    ["--static", gaps, ...observed, "--profile", profile],
    ["--static", gaps, ...observed, "--unknown", origins],
    ["--static", gaps, "--observed"],
    ["--static", gaps, "--static", gaps, ...observed],
  ])
    assert.equal(run(args).status, 2, args.join(" "));
});

test("committed fixtures equal the builder output and the real analysis declares the bundle surface", async () => {
  for (const [name, expected] of surfaceFixtureFiles())
    assert.equal(
      await readFile(join(fixturesDirectory, name), "utf8"),
      expected,
      name,
    );
  const check = spawnSync(process.execPath, [generatorPath, "--check"], {
    encoding: "utf8",
  });
  assert.equal(check.status, 0, check.stderr);
  const analysis = JSON.parse(
    await readFile(join(fixturesDirectory, "static-analysis.json"), "utf8"),
  );
  assert.equal(analysis.input_path, "scripts/fixtures/saas-surface/bundle");
  assert.equal(Object.hasOwn(analysis, "normalized_result"), false);
  const committed = (name) =>
    input(
      name,
      JSON.parse(readFileSync(join(fixturesDirectory, name), "utf8")),
    );
  const report = reconcileSurface({
    static: committed("static-analysis.json"),
    observed: [
      committed("api-surface.json"),
      committed("scenario-capture.json"),
    ],
    origins: committed("origins.json").value,
  });
  assert.equal(report.status, "complete", report.reason);
  assert.deepEqual(statusesOf(report), expectedBundleStatuses(report));
  assert.equal(report.inputs.static.endpoint_nodes, 17);
  assert.equal(report.gaps, 7);
  const metrics = report.surface.find(
    (item) => item.key === "POST /api/metrics",
  );
  assert.deepEqual(metrics.evidence.static.locations, [
    { source: "main.js", line: 36, column: 9 },
  ]);
  assert.equal(
    metrics.evidence.static.artifact_sha256.length,
    64,
    "the node identity cites the analyzed file digest",
  );
  const run = (args) =>
    spawnSync(process.execPath, [cliPath, ...args], {
      encoding: "utf8",
      timeout: 60_000,
    });
  const fixture = (name) => join(fixturesDirectory, name);
  const found = run([
    "--static",
    fixture("static-analysis.json"),
    "--observed",
    fixture("api-surface.json"),
    "--observed",
    fixture("scenario-capture.json"),
    "--origins",
    fixture("origins.json"),
    "--profile",
    fixture("profile.json"),
    "--workflow-id",
    "first-workflow",
  ]);
  assert.equal(found.status, 1, found.stderr);
  const parsed = JSON.parse(found.stdout);
  assert.equal(parsed.gaps, 7);
  assert.equal(parsed.profileUpdate.added.length, 7);
});
