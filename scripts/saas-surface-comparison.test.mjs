import test from "node:test";
import assert from "node:assert/strict";
import { reconcileSurface } from "./lib/saas-surface-coverage.mjs";
import {
  SURFACE_ORIGIN,
  buildSurfaceApiSurface,
  buildSurfaceCapture,
} from "./lib/saas-surface-fixture.mjs";
import {
  BUNDLE_FINDINGS,
  analysisOf,
  fixtureInputs,
  input,
  statusesOf,
} from "./saas-surface-test-support.mjs";

// compare_static_and_observed_endpoints results (unmerged 3591 branch) as observed
// evidence: adoption by rank, incompleteness, strict verdict fields, foreign digests.

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

const metricsVerdict = (analysis, overrides) => ({
  static_node_id: nodeFor(analysis, "/api/metrics"),
  mechanisms: ["call:navigator.sendBeacon"],
  status: "not-observed-in-capture",
  method: { values: ["POST"], basis: "api-definition" },
  target: { origin: null, path: "/api/metrics", origin_basis: "declared" },
  ...overrides,
});

const withComparison = (analysis, observed) =>
  reconcileSurface(
    fixtureInputs({
      static: input("static-analysis.json", analysis),
      observed,
    }),
  );

test("adopts a complete 3591 comparison result as observed evidence", () => {
  const analysis = analysisOf(BUNDLE_FINDINGS);
  const comparison = comparisonOf(analysis, [
    metricsVerdict(analysis, {
      status: "matched",
      match_basis: "exact",
      observed: [{ group: 0, basis: "exact" }],
    }),
    {
      static_node_id: nodeFor(analysis, "/live"),
      mechanisms: ["call:WebSocket"],
      status: "not-observed-in-capture",
      method: { values: [], basis: "unknown" },
      target: { origin: null, path: "/live", origin_basis: "declared" },
    },
  ]);
  const report = withComparison(analysis, [
    input("api-surface.json", buildSurfaceApiSurface()),
    input("comparison.json", comparison),
  ]);
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
  const alone = withComparison(analysis, [
    input("comparison.json", comparison),
  ]);
  assert.equal(statusesOf(alone)["network POST /api/metrics"], "exact");
  assert.equal(
    statusesOf(alone)["network POST /api/invoices"],
    "unknown:origin-not-exercised",
  );
});

test("lists comparison groups without a static counterpart as undeclared and rejects partial pages", () => {
  const analysis = analysisOf(BUNDLE_FINDINGS);
  const unmatched = withComparison(analysis, [
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
  ]);
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
    withComparison(analysis, [input("partial.json", partial)]).reason,
    /comparison page is partial/u,
  );
});

test("merges comparison verdicts by rank in any input order and never lowers a proven status", () => {
  const analysis = analysisOf(BUNDLE_FINDINGS);
  const proven = comparisonOf(analysis, [
    metricsVerdict(analysis, {
      status: "matched",
      match_basis: "exact",
      observed: [{ group: 0, basis: "exact" }],
    }),
  ]);
  const absent = comparisonOf(analysis, [metricsVerdict(analysis, {})]);
  const forward = withComparison(analysis, [
    input("proven.json", proven),
    input("absent.json", absent),
  ]);
  const backward = withComparison(analysis, [
    input("absent.json", absent),
    input("proven.json", proven),
  ]);
  assert.deepEqual(statusesOf(forward), statusesOf(backward));
  for (const [report, provenInput] of [
    [forward, 0],
    [backward, 1],
  ]) {
    const metrics = report.surface.find(
      (item) => item.key === "POST /api/metrics",
    );
    assert.equal(metrics.status, "exact");
    assert.deepEqual(
      metrics.evidence.observed.map((entry) => [entry.input, entry.basis]),
      [[provenInput, "exact"]],
    );
  }
});

test("turns a comparison absence into unknown when another input is incomplete", () => {
  const analysis = analysisOf(BUNDLE_FINDINGS);
  const dropped = buildSurfaceCapture();
  dropped.events.dropped = 2;
  const report = withComparison(analysis, [
    input("dropped.json", dropped),
    input(
      "absent.json",
      comparisonOf(analysis, [metricsVerdict(analysis, {})]),
    ),
  ]);
  assert.equal(
    statusesOf(report)["network POST /api/metrics"],
    "unknown:observed-coverage-incomplete",
  );
});

test("validates comparison methods and targets strictly and rejects foreign digests for every collection", () => {
  const analysis = analysisOf(BUNDLE_FINDINGS);
  const invalid = (items, pattern) => {
    const report = withComparison(analysis, [
      input("cmp.json", comparisonOf(analysis, items)),
    ]);
    assert.equal(report.status, "invalid", JSON.stringify(items).slice(0, 120));
    assert.match(report.reason, pattern);
    assert.equal(JSON.stringify(report).includes("SECRETQ"), false);
  };
  invalid(
    [
      metricsVerdict(analysis, {
        method: { values: "POST", basis: "api-definition" },
      }),
    ],
    /method\.values/u,
  );
  invalid(
    [
      metricsVerdict(analysis, {
        method: { values: [], basis: "api-definition" },
      }),
    ],
    /method/u,
  );
  invalid(
    [
      metricsVerdict(analysis, {
        method: { values: ["POST"], basis: "guess" },
      }),
    ],
    /method\.basis/u,
  );
  invalid(
    [
      metricsVerdict(analysis, {
        target: {
          origin: null,
          path: "/api/metrics?token=SECRETQ",
          origin_basis: "declared",
        },
      }),
    ],
    /target\.path/u,
  );
  invalid(
    [
      metricsVerdict(analysis, {
        target: {
          origin: null,
          path: "/api/metrics",
          origin_basis: "declared",
          note: "SECRETQ",
        },
      }),
    ],
    /target/u,
  );
  invalid(
    [
      metricsVerdict(analysis, {
        target: {
          origin: null,
          path: "/api/metrics",
          origin_basis: "somewhere",
        },
      }),
    ],
    /origin_basis/u,
  );
  for (const collection of [
    "static-endpoints",
    "observed-without-static-match",
    "observed-unresolved",
  ]) {
    const foreign = comparisonOf(
      analysis,
      collection === "static-endpoints"
        ? []
        : [
            {
              method: "GET",
              origin: SURFACE_ORIGIN,
              path_template: "/api/orders",
              record_ordinals: [3],
              ...(collection === "observed-unresolved"
                ? {
                    reason: "origin-undeclared",
                    static_node_ids: [nodeFor(analysis, "/api/metrics")],
                  }
                : {}),
            },
          ],
      collection,
    );
    foreign.static.root_artifact_sha256 = "b".repeat(64);
    const report = withComparison(analysis, [input("foreign.json", foreign)]);
    assert.equal(report.status, "invalid", collection);
    assert.match(report.reason, /root_artifact_sha256/u);
  }
});
