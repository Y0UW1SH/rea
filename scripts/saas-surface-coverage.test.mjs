import test from "node:test";
import assert from "node:assert/strict";
import {
  SURFACE_FAMILIES,
  SURFACE_STATUSES,
  SURFACE_UNKNOWN_REASONS,
  reconcileSurface,
} from "./lib/saas-surface-coverage.mjs";
import { ENDPOINT_TRAFFIC_UNKNOWN_REASONS } from "./lib/saas-surface-matching.mjs";
import {
  SURFACE_ORIGIN,
  SURFACE_REPLACEMENT_ORIGIN,
  buildSurfaceApiSurface,
  buildSurfaceCapture,
} from "./lib/saas-surface-fixture.mjs";
import {
  BUNDLE_FINDINGS,
  SHA,
  analysisOf,
  expectedBundleStatuses,
  experimentId,
  fixtureInputs,
  input,
  setRequestBody,
  statusesOf,
} from "./saas-surface-test-support.mjs";

test("pins the companion families, statuses and reason superset", () => {
  assert.deepEqual(
    [...SURFACE_FAMILIES],
    ["network", "trpc", "graphql", "route"],
  );
  assert.deepEqual(
    [...SURFACE_STATUSES],
    ["exact", "templated", "ambiguous", "unmatched", "unknown"],
  );
  assert.deepEqual(
    SURFACE_UNKNOWN_REASONS.slice(0, ENDPOINT_TRAFFIC_UNKNOWN_REASONS.length),
    [...ENDPOINT_TRAFFIC_UNKNOWN_REASONS],
  );
  assert.deepEqual(
    SURFACE_UNKNOWN_REASONS.slice(ENDPOINT_TRAFFIC_UNKNOWN_REASONS.length),
    [
      "target-unresolved",
      "rpc-bodies-not-retained",
      "rpc-link-base-undeclared",
      "route-pattern-unsupported",
    ],
  );
});

test("reconciles every declared family against api-surface groups and a capture", () => {
  const report = reconcileSurface(fixtureInputs());
  assert.equal(report.status, "complete", JSON.stringify(report.limitations));
  assert.deepEqual(statusesOf(report), expectedBundleStatuses(report));
  assert.deepEqual(report.declared, {
    network: 9,
    trpc: 2,
    graphql: 2,
    route: 3,
  });
  assert.deepEqual(report.summary.network, {
    declared: 9,
    exact: 5,
    templated: 0,
    ambiguous: 0,
    unmatched: 1,
    unknown: 3,
  });
  assert.deepEqual(report.summary.unknown_reasons, [
    { reason: "candidate-endpoint", count: 1 },
    { reason: "origin-not-exercised", count: 1 },
    { reason: "rpc-bodies-not-retained", count: 1 },
    { reason: "target-unresolved", count: 1 },
  ]);
  assert.equal(report.gaps, 7);
  assert.equal(Object.hasOwn(report, "profileUpdate"), false);
});

test("cites static locations and observed ordinals, transactions or steps per item", () => {
  const report = reconcileSurface(fixtureInputs());
  const find = (key) => report.surface.find((item) => item.key === key);
  const customers = find("* https://app.example.test/api/customers/42");
  assert.equal(customers.confidence, "high");
  assert.deepEqual(customers.inferences, []);
  assert.deepEqual(customers.method, { values: [], basis: "unknown" });
  assert.equal(customers.evidence.static.artifact_sha256, SHA);
  assert.deepEqual(customers.evidence.static.locations, [
    { source: "main.js", line: 1, column: 0 },
  ]);
  assert.deepEqual(customers.evidence.static.mechanisms, ["call:fetch"]);
  assert.match(customers.evidence.static.node_id, /^jag_node_/u);
  assert.deepEqual(
    customers.evidence.observed.map((entry) => [entry.input, entry.basis]),
    [
      [0, "exact"],
      [1, "exact"],
    ],
  );
  assert.deepEqual(customers.evidence.observed[0].record_ordinals, [1, 2]);
  assert.deepEqual(customers.evidence.observed[1].transactions, [
    { transaction_id: "t2", step_id: "open-invoices", status: 200 },
    { transaction_id: "t3", step_id: "open-invoices", status: 200 },
  ]);
  const archive = find("* https://app.example.test/api/invoices/archive");
  assert.equal(archive.confidence, "high");
  assert.deepEqual(archive.inferences, []);
  assert.deepEqual(archive.method, { values: [], basis: "unknown" });
  const declaredJoin = find("POST /api/invoices");
  assert.equal(declaredJoin.confidence, "medium");
  assert.deepEqual(declaredJoin.inferences, [
    "origin-declared",
    "method-callee-name",
  ]);
  const route = find("/invoices/:id");
  assert.equal(route.confidence, "medium");
  assert.deepEqual(route.evidence.observed, [
    {
      input: 1,
      kind: "scenario-capture",
      origin: SURFACE_ORIGIN,
      path: "/invoices/17",
      steps: ["create-invoice", "open-help"],
    },
  ]);
  assert.deepEqual(find("query ListCustomers").evidence.observed, [
    {
      input: 1,
      kind: "scenario-capture",
      method: "POST",
      origin: SURFACE_ORIGIN,
      path_template: "/graphql",
      transactions: [
        { transaction_id: "t8", step_id: "create-invoice", status: 200 },
      ],
    },
  ]);
  assert.equal(
    find("query user.byId").evidence.observed[0].path_template,
    "/trpc/user.byId,user.list",
  );
});

test("reports undeclared traffic, plans experiments and stays deterministic", () => {
  const report = reconcileSurface(fixtureInputs());
  assert.deepEqual(
    report.undeclared_observed.map((entry) => [
      entry.family,
      entry.method ?? null,
      entry.origin,
      entry.path ?? entry.path_template ?? entry.procedure,
    ]),
    [
      ["network", "GET", "https://app.example.test", "/assets/logo.png"],
      ["network", "GET", "https://cdn.example.test", "/lib.json"],
      ["trpc", null, "https://app.example.test", "user.list"],
      ["route", null, "https://app.example.test", "/"],
      ["route", null, "https://app.example.test", "/help"],
    ],
  );
  assert.equal(report.undeclared_observed[0].evidence.length, 2);
  assert.deepEqual(
    report.experiments.map((experiment) => experiment.id),
    [
      experimentId("network", "POST /api/metrics"),
      experimentId("network", "* /live"),
      ...report.surface
        .filter((item) => item.key.startsWith("node:"))
        .map((item) => item.key)
        .sort()
        .map((key) => experimentId("network", key)),
      experimentId("trpc", "mutate user.rename"),
      experimentId("graphql", "mutation RenameCustomer"),
      experimentId("route", "/settings"),
    ],
  );
  assert.deepEqual(report.experiments[0], {
    id: experimentId("network", "POST /api/metrics"),
    workflowId: "surface-coverage",
    uncertainty:
      "Static network endpoint POST /api/metrics (call:navigator.sendBeacon at main.js:1:0) was not exercised by any supplied observation; its behavior is unknown, not absent.",
    proposedObservation:
      "Record a browser scenario on https://app.example.test reaching the UI that issues POST /api/metrics, with network bodies; rerun surface coverage.",
    status: "planned",
    evidence: [],
  });
  assert.deepEqual(
    report.experimentPriorities.map((entry) => entry.rank),
    report.experiments.map((_, index) => index + 1),
  );
  assert.deepEqual(report.experimentPriorities[0], {
    id: report.experiments[0].id,
    rank: 1,
    family: "network",
    status: "unmatched",
    mutating: true,
  });
  assert.ok(report.limitations.some((line) => /string-built/u.test(line)));
  assert.ok(report.limitations.some((line) => /feature-flag/u.test(line)));
  const text = JSON.stringify(report);
  assert.equal(
    text.includes("page=1"),
    false,
    "query strings are never echoed",
  );
  assert.equal(text.includes("missing code"), false);
  assert.equal(JSON.stringify(reconcileSurface(fixtureInputs())), text);
});

test("fails closed on malformed inputs and tolerates envelope extras", () => {
  const invalid = (inputs, pattern) => {
    const report = reconcileSurface(inputs);
    assert.equal(report.status, "invalid");
    assert.match(report.reason, pattern);
  };
  invalid(
    fixtureInputs({ observed: [input("x.json", { unexpected: true })] }),
    /observed\[0\]: unrecognized/u,
  );
  invalid(
    fixtureInputs({
      static: input("s.json", { root_artifact_sha256: SHA, graph: null }),
    }),
    /static.*expected object/u,
  );
  const tampered = buildSurfaceCapture();
  tampered.events.items.find(
    (event) => event.kind === "network-content",
  ).body.sha256 = "0".repeat(64);
  invalid(fixtureInputs({ observed: [input("c.json", tampered)] }), /digest/u);
  const surface = buildSurfaceApiSurface();
  surface.groups[0].templated_segments = [{ segment_index: 1, rule: "glob" }];
  invalid(fixtureInputs({ observed: [input("a.json", surface)] }), /rule/u);
  invalid(
    fixtureInputs({
      origins: {
        declared_origins: ["https://app.example.test/"],
        origin_pairs: [],
      },
    }),
    /declared_origins/u,
  );
  const envelope = reconcileSurface(
    fixtureInputs({
      static: input("evidence.json", {
        evidence_id: `ev_${"1".repeat(64)}`,
        normalized_result: analysisOf(BUNDLE_FINDINGS),
        extra: { ignored: true },
      }),
      observed: [
        input("surface.json", {
          ...buildSurfaceApiSurface(),
          parent_digest: "x",
        }),
      ],
    }),
  );
  assert.equal(envelope.status, "complete", envelope.reason);
  assert.equal(envelope.inputs.static.root_artifact_sha256, SHA);
});

test("flips absence to unknown under incomplete coverage and names body-less RPC limits", () => {
  const partialRecords = buildSurfaceApiSurface();
  partialRecords.records.total += 1;
  const incomplete = reconcileSurface(
    fixtureInputs({ observed: [input("a.json", partialRecords)] }),
  );
  assert.equal(incomplete.status, "partial");
  const statuses = statusesOf(incomplete);
  assert.equal(
    statuses["network POST /api/metrics"],
    "unknown:observed-coverage-incomplete",
  );
  assert.equal(
    statuses["graphql query ListCustomers"],
    "unknown:rpc-bodies-not-retained",
  );
  assert.equal(statuses["route /invoices"], "unknown:origin-not-exercised");
  assert.equal(statuses["trpc query user.byId"], "exact");
  assert.ok(
    incomplete.limitations.some((line) => /a\.json.*examined/u.test(line)),
    incomplete.limitations.join("\n"),
  );
  const dropped = buildSurfaceCapture();
  dropped.events.dropped = 3;
  const droppedReport = reconcileSurface(
    fixtureInputs({ observed: [input("c.json", dropped)] }),
  );
  assert.equal(
    statusesOf(droppedReport)["route /settings"],
    "unknown:observed-coverage-incomplete",
  );
  assert.equal(
    statusesOf(droppedReport)["graphql mutation RenameCustomer"],
    "unknown:observed-coverage-incomplete",
  );
  const partialStatic = reconcileSurface(
    fixtureInputs({
      static: input("s.json", analysisOf(BUNDLE_FINDINGS, "partial")),
    }),
  );
  assert.equal(partialStatic.status, "partial");
  assert.ok(
    partialStatic.limitations.some((line) =>
      /Static graph coverage is partial/u.test(line),
    ),
  );
  assert.equal(
    statusesOf(partialStatic)["network POST /api/metrics"],
    "unmatched",
  );
});

test("folds replacement origins onto reference origins before joining", () => {
  const replacement = buildSurfaceCapture(SURFACE_REPLACEMENT_ORIGIN);
  const report = reconcileSurface(
    fixtureInputs({ observed: [input("replacement.json", replacement)] }),
  );
  const statuses = statusesOf(report);
  for (const key of [
    "network POST /api/invoices",
    "network * https://app.example.test/api/customers/42",
    "trpc query user.byId",
    "graphql query ListCustomers",
    "route /invoices",
  ])
    assert.equal(statuses[key], "exact", key);
  const invoices = report.surface.find(
    (item) => item.key === "POST /api/invoices",
  );
  assert.equal(invoices.evidence.observed[0].origin, SURFACE_ORIGIN);
  assert.equal(
    invoices.evidence.observed[0].recorded_origin,
    SURFACE_REPLACEMENT_ORIGIN,
  );
  assert.ok(
    report.undeclared_observed.some(
      (entry) => entry.origin === "https://cdn.example.test",
    ),
  );
  const unpaired = reconcileSurface(
    fixtureInputs({
      observed: [input("replacement.json", replacement)],
      origins: { declared_origins: [SURFACE_ORIGIN], origin_pairs: [] },
    }),
  );
  assert.equal(
    statusesOf(unpaired)["network POST /api/invoices"],
    "unknown:origin-not-exercised",
  );
  assert.equal(
    statusesOf(unpaired)["route /invoices"],
    "unknown:origin-not-exercised",
  );
});

test("claims GraphQL absence only when every input retained bodies on an exercised declared origin", () => {
  const quiet = buildSurfaceCapture();
  quiet.events.items = quiet.events.items.filter(
    (event) => event.transaction_id !== "t8",
  );
  quiet.events.retained = quiet.events.items.length;
  const alone = reconcileSurface(
    fixtureInputs({ observed: [input("quiet.json", quiet)] }),
  );
  assert.equal(statusesOf(alone)["graphql query ListCustomers"], "unmatched");
  const mixed = reconcileSurface(
    fixtureInputs({
      observed: [
        input("quiet.json", quiet),
        input("a.json", buildSurfaceApiSurface()),
      ],
    }),
  );
  assert.equal(
    statusesOf(mixed)["graphql query ListCustomers"],
    "unknown:rpc-bodies-not-retained",
  );
  const truncated = buildSurfaceCapture();
  const content = truncated.events.items.find(
    (event) =>
      event.kind === "network-content" &&
      event.transaction_id === "t8" &&
      event.phase === "request",
  );
  content.body = {
    state: "unavailable",
    reason: "body-size-limit",
    message: "Request body exceeded the retained size limit",
    limit_bytes: 65_536,
    observed_bytes: 70_000,
  };
  const cut = reconcileSurface(
    fixtureInputs({ observed: [input("cut.json", truncated)] }),
  );
  assert.equal(
    statusesOf(cut)["graphql query ListCustomers"],
    "unknown:rpc-bodies-not-retained",
  );
  assert.ok(
    cut.inputs.observed[0].body_incompleteness.some((line) =>
      /request bod/u.test(line),
    ),
  );
  assert.ok(
    cut.limitations.some((line) => /cut\.json.*request bod/u.test(line)),
  );
  const away = reconcileSurface(
    fixtureInputs({
      observed: [
        input("away.json", buildSurfaceCapture("https://other.example.test")),
      ],
    }),
  );
  assert.equal(
    statusesOf(away)["graphql mutation RenameCustomer"],
    "unknown:origin-not-exercised",
  );
});

test("reads persisted-query bodies by operationName and ignores names outside the GraphQL grammar", () => {
  const apq = buildSurfaceCapture();
  setRequestBody(
    apq,
    "t8",
    JSON.stringify({
      operationName: "ListCustomers",
      variables: { first: 10 },
      extensions: {
        persistedQuery: { version: 1, sha256Hash: "0".repeat(64) },
      },
    }),
  );
  assert.equal(
    statusesOf(
      reconcileSurface(fixtureInputs({ observed: [input("apq.json", apq)] })),
    )["graphql query ListCustomers"],
    "exact",
  );
  const hostile = buildSurfaceCapture();
  setRequestBody(
    hostile,
    "t8",
    JSON.stringify({
      operationName: "(a+)+b SECRETNAME(",
      query: "query ListCustomers { customers { id } }",
    }),
  );
  const report = reconcileSurface(
    fixtureInputs({ observed: [input("hostile.json", hostile)] }),
  );
  assert.notEqual(report.status, "invalid", report.reason);
  assert.equal(JSON.stringify(report).includes("SECRETNAME"), false);
  assert.equal(statusesOf(report)["graphql query ListCustomers"], "exact");
});

test("treats an api-surface page beyond the first or short of its total as incomplete", () => {
  const paged = buildSurfaceApiSurface();
  paged.view.offset = 50;
  paged.coverage = {
    status: "page",
    examined: 9,
    total: 59,
    next_offset: null,
    exhausted: true,
  };
  const report = reconcileSurface(
    fixtureInputs({ observed: [input("page.json", paged)] }),
  );
  assert.equal(report.status, "partial");
  assert.equal(
    statusesOf(report)["network POST /api/metrics"],
    "unknown:observed-coverage-incomplete",
  );
  assert.ok(
    report.inputs.observed[0].incompleteness.some((line) =>
      /groups examined 9 of 59|offset 50/u.test(line),
    ),
  );
});

test("never echoes a route literal with a query or fragment", () => {
  const report = reconcileSurface(
    fixtureInputs({
      static: input(
        "s.json",
        analysisOf([
          ...BUNDLE_FINDINGS,
          {
            value: "/reset?token=SECRETVALUE",
            mechanisms: ["property:path"],
            kind: "route",
          },
        ]),
      ),
    }),
  );
  const item = report.surface.find(
    (entry) =>
      entry.family === "route" && entry.reason === "route-pattern-unsupported",
  );
  assert.ok(item.key.startsWith("node:"), item.key);
  assert.equal(Object.hasOwn(item, "route"), false);
  assert.equal(JSON.stringify(report).includes("SECRETVALUE"), false);
});
