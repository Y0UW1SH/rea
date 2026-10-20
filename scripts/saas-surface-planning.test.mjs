import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectProductProfile } from "./lib/saas-product-profile.mjs";
import { reconcileSurface } from "./lib/saas-surface-coverage.mjs";
import {
  SURFACE_ORIGIN,
  buildSurfaceApiSurface,
  buildSurfaceCapture,
  surfaceOrigins,
} from "./lib/saas-surface-fixture.mjs";
import {
  BUNDLE_FINDINGS,
  EXERCISED_VALUES,
  analysisOf,
  cliPath,
  fixtureInputs,
  genericProfile,
  input,
  statusesOf,
} from "./saas-surface-test-support.mjs";

// Comparison-result inputs, profile planning and the CLI contract of the surface
// coverage companion.

const comparisonOf = (analysis, items, collection = "static-endpoints") => ({
  collection,
  static: {
    evidence_id: `ev_${"1".repeat(64)}`,
    graph_id: analysis.graph.graph_id,
    root_artifact_sha256: analysis.root_artifact_sha256,
  },
  observed: {
    evidence_id: `ev_${"2".repeat(64)}`,
    artifact: { path: "/captures/session.har", sha256: null },
  },
  declared_origins: [SURFACE_ORIGIN],
  page: { offset: 0, limit: 50, total: items.length, next_offset: null },
  items,
  ...(collection === "static-endpoints"
    ? {
        paired_groups: [
          {
            method: "POST",
            origin: SURFACE_ORIGIN,
            path_template: "/api/metrics",
            record_ordinals: [12],
          },
        ],
      }
    : {}),
  coverage: {
    static_graph: "complete",
    observed_records: { examined: 13, total: 13, excluded: 0 },
  },
  evidence_links: [`ev_${"1".repeat(64)}`, `ev_${"2".repeat(64)}`],
  limitations: ["quoted from the comparison"],
});

const nodeFor = (analysis, value) =>
  analysis.graph.nodes.find(
    (node) =>
      node.kind === "endpoint" &&
      node.observations[0].properties.value === value,
  ).node_id;

test("adopts a complete 3591 comparison result as observed evidence", () => {
  const analysis = analysisOf(BUNDLE_FINDINGS);
  const items = [
    {
      static_node_id: nodeFor(analysis, "/api/metrics"),
      mechanisms: ["call:navigator.sendBeacon"],
      status: "matched",
      method: { values: ["POST"], basis: "api-definition" },
      target: { origin: null, path: "/api/metrics", origin_basis: "declared" },
      match_basis: "exact",
      observed: [{ group: 0, basis: "exact" }],
    },
    {
      static_node_id: nodeFor(analysis, "/live"),
      mechanisms: ["call:WebSocket"],
      status: "not-observed-in-capture",
      method: { values: [], basis: "unknown" },
      target: { origin: null, path: "/live", origin_basis: "declared" },
    },
  ];
  const comparison = comparisonOf(analysis, items);
  const report = reconcileSurface(
    fixtureInputs({
      static: input("static-analysis.json", analysis),
      observed: [
        input("api-surface.json", buildSurfaceApiSurface()),
        input("comparison.json", comparison),
      ],
    }),
  );
  assert.equal(report.status, "complete", report.reason);
  const statuses = statusesOf(report);
  assert.equal(statuses["network POST /api/metrics"], "exact");
  assert.equal(statuses["network * /live"], "unmatched");
  const metrics = report.surface.find(
    (item) => item.key === "POST /api/metrics",
  );
  assert.deepEqual(metrics.evidence.observed, [
    {
      input: 1,
      kind: "endpoint-traffic-comparison",
      method: "POST",
      origin: SURFACE_ORIGIN,
      path_template: "/api/metrics",
      record_ordinals: [12],
      basis: "exact",
    },
  ]);
  assert.ok(
    report.limitations.some((line) =>
      /comparison\.json.*comparison/u.test(line),
    ),
  );
  assert.ok(
    report.limitations.includes("comparison.json: quoted from the comparison"),
  );
  const alone = reconcileSurface(
    fixtureInputs({
      static: input("static-analysis.json", analysis),
      observed: [input("comparison.json", comparison)],
    }),
  );
  assert.equal(statusesOf(alone)["network POST /api/metrics"], "exact");
  assert.equal(
    statusesOf(alone)["network POST /api/invoices"],
    "unknown:origin-not-exercised",
  );
});

test("lists comparison groups without a static counterpart as undeclared and rejects partial or foreign pages", () => {
  const analysis = analysisOf(BUNDLE_FINDINGS);
  const unmatched = reconcileSurface(
    fixtureInputs({
      static: input("static-analysis.json", analysis),
      observed: [
        input(
          "unmatched.json",
          comparisonOf(
            analysis,
            [
              {
                method: "GET",
                origin: SURFACE_ORIGIN,
                path_template: "/api/orders",
                record_ordinals: [3],
              },
            ],
            "observed-without-static-match",
          ),
        ),
      ],
    }),
  );
  assert.deepEqual(unmatched.undeclared_observed, [
    {
      family: "network",
      method: "GET",
      origin: SURFACE_ORIGIN,
      path_template: "/api/orders",
      evidence: [
        {
          input: 0,
          kind: "endpoint-traffic-comparison",
          record_ordinals: [3],
        },
      ],
    },
  ]);
  const partial = comparisonOf(analysis, []);
  partial.page.total = 3;
  assert.match(
    reconcileSurface(
      fixtureInputs({
        static: input("static-analysis.json", analysis),
        observed: [input("partial.json", partial)],
      }),
    ).reason,
    /comparison page is partial/u,
  );
  const foreign = comparisonOf(analysis, []);
  foreign.static.root_artifact_sha256 = "b".repeat(64);
  assert.match(
    reconcileSurface(
      fixtureInputs({
        static: input("static-analysis.json", analysis),
        observed: [input("foreign.json", foreign)],
      }),
    ).reason,
    /root_artifact_sha256/u,
  );
});

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
