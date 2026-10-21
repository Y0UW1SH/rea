import test from "node:test";
import assert from "node:assert/strict";
import {
  AMBIGUOUS_REASON,
  ENDPOINT_TRAFFIC_PROTOCOLS,
  ENDPOINT_TRAFFIC_UNKNOWN_REASONS,
  METHOD_BASES,
  ORIGIN_BASES,
  PAIRING_BASES,
  STATIC_ITEM_STATUSES,
  classifyStaticEndpoint,
  groupShapeKey,
  indexObservedGroups,
  networkEndpointFacts,
  nodeMethod,
  pairingBasis,
  parseStaticTarget,
  requestOrigin,
  routeKey,
  staticShapeKey,
} from "./lib/saas-surface-matching.mjs";

const APP = "https://app.example.test";

// Vocabulary of src/domain/javascript/javascriptEndpointTrafficComparisonSchemas.ts
// on the unmerged branch feat/3591-endpoint-traffic-comparison, copied here so a
// drift in the port fails this test instead of silently changing report words.
const OWNER_UNKNOWN_REASONS = [
  "candidate-endpoint",
  "rpc-operation-not-path",
  "rpc-transport-base-url",
  "relative-reference-base-unknown",
  "unsupported-url-scheme",
  "value-not-url-or-path",
  "target-not-canonical",
  "origin-undeclared",
  "origin-not-exercised",
  "observed-coverage-incomplete",
];

let nodes = 0;
const node = (
  value,
  mechanisms,
  { kind = "network", candidate = false } = {},
) => ({
  node_id: `jag_node_${String(++nodes).padStart(64, "0")}`,
  kind: "endpoint",
  observations: mechanisms.map((mechanism) => ({
    properties: {
      endpoint_kind: kind,
      value,
      mechanism,
      ...(candidate ? { interpretation: "candidate" } : {}),
    },
  })),
});
const group = (method, origin, pathTemplate, segments = []) => ({
  method,
  origin,
  path_template: pathTemplate,
  templated_segments: segments.map(
    ([segment_index, rule, observed_values]) => ({
      segment_index,
      rule,
      basis: "inferred",
      observed_values,
    }),
  ),
  record_ordinals: [0],
  statuses: [200],
});
const observedOf = (groups, records = {}) =>
  indexObservedGroups({
    groups,
    records: {
      examined: groups.length,
      total: groups.length,
      excluded: 0,
      ...records,
    },
  });
const classify = (value, mechanisms, groups, options = {}) =>
  classifyStaticEndpoint(
    networkEndpointFacts(node(value, mechanisms, options)),
    observedOf(groups, options.records),
    options.origins ?? [],
  );

test("pins the 3591 status, basis and reason vocabulary", () => {
  assert.deepEqual(
    [...ENDPOINT_TRAFFIC_UNKNOWN_REASONS],
    OWNER_UNKNOWN_REASONS,
  );
  assert.deepEqual(
    [...STATIC_ITEM_STATUSES],
    ["matched", "ambiguous", "not-observed-in-capture", "unknown"],
  );
  assert.deepEqual([...PAIRING_BASES], ["exact", "template-compatible"]);
  assert.deepEqual(
    [...METHOD_BASES],
    ["callee-name", "api-definition", "unknown"],
  );
  assert.deepEqual([...ORIGIN_BASES], ["literal", "declared", "undeclared"]);
  assert.equal(AMBIGUOUS_REASON, "method-inference-disagrees");
  assert.deepEqual([...ENDPOINT_TRAFFIC_PROTOCOLS].sort(), [
    "http:",
    "https:",
    "ws:",
    "wss:",
  ]);
  for (const value of [
    ENDPOINT_TRAFFIC_UNKNOWN_REASONS,
    STATIC_ITEM_STATUSES,
    PAIRING_BASES,
    METHOD_BASES,
    ORIGIN_BASES,
  ])
    assert.ok(Object.isFrozen(value));
});

test("parses static targets without echoing values beyond origin and path", () => {
  assert.deepEqual(
    parseStaticTarget("https://api.example.test/v1/items?token=secret#frag"),
    { kind: "absolute", origin: "https://api.example.test", path: "/v1/items" },
  );
  assert.deepEqual(parseStaticTarget("/api/users?x=1#y"), {
    kind: "relative",
    path: "/api/users",
  });
  for (const [value, reason] of [
    ["api/users", "relative-reference-base-unknown"],
    ["//cdn.example.test/x", "relative-reference-base-unknown"],
    ["not a url", "relative-reference-base-unknown"],
    ["file:///etc/hosts", "unsupported-url-scheme"],
    ["mailto:someone@example.test", "unsupported-url-scheme"],
    ["http://", "value-not-url-or-path"],
    ["/files/my file", "target-not-canonical"],
    [`${APP}/a/%2e%2e/admin`, "target-not-canonical"],
    [`${APP}/x\\y`, "target-not-canonical"],
    ["/a/../b", "target-not-canonical"],
  ])
    assert.deepEqual(
      parseStaticTarget(value),
      { kind: "ineligible", reason },
      value,
    );
});

test("infers methods from callee names and API definitions only", () => {
  assert.deepEqual(nodeMethod(["call:api.post"]), {
    values: ["POST"],
    basis: "callee-name",
  });
  assert.deepEqual(nodeMethod(["call:EventSource"]), {
    values: ["GET"],
    basis: "api-definition",
  });
  assert.deepEqual(nodeMethod(["call:navigator.sendBeacon"]), {
    values: ["POST"],
    basis: "api-definition",
  });
  assert.deepEqual(nodeMethod(["call:api.get", "call:api.delete"]), {
    values: ["DELETE", "GET"],
    basis: "callee-name",
  });
  assert.deepEqual(nodeMethod(["call:EventSource", "call:client.get"]), {
    values: ["GET"],
    basis: "callee-name",
  });
  for (const mechanisms of [
    ["call:fetch"],
    ["call:api.get", "call:fetch"],
    ["property:path"],
    ["unknown"],
  ])
    assert.deepEqual(nodeMethod(mechanisms), { values: [], basis: "unknown" });
});

test("maps WebSocket constructor origins to ws schemes and leaves others alone", () => {
  assert.equal(requestOrigin("call:WebSocket", APP), "wss://app.example.test");
  assert.equal(
    requestOrigin("call:window.WebSocket", "http://localhost:3000"),
    "ws://localhost:3000",
  );
  assert.equal(requestOrigin("call:fetch", APP), APP);
  assert.equal(requestOrigin("call:WebSocket", "wss://x.test"), "wss://x.test");
});

test("keys route shapes by the api-surface segment rules as composite tuples", () => {
  const shape = JSON.stringify([
    [0, "users"],
    [1, "numeric"],
  ]);
  assert.equal(staticShapeKey("/users/8812"), shape);
  assert.equal(
    groupShapeKey(
      group("GET", APP, "/users/{numeric}", [[1, "numeric", ["8812"]]]),
    ),
    shape,
  );
  assert.equal(routeKey(APP, shape), JSON.stringify([APP, shape]));
  assert.notEqual(staticShapeKey("/users/me"), shape);
  assert.equal(
    staticShapeKey("/a/0f8fad5b-d9cb-469f-a165-70867728950e/2026-02-28"),
    JSON.stringify([
      [0, "a"],
      [1, "uuid"],
      [1, "iso-date"],
    ]),
  );
});

test("pairs exactly only when every templated value occurred and one position varied", () => {
  const single = group("GET", APP, "/users/{numeric}", [
    [1, "numeric", ["8812", "9031"]],
  ]);
  assert.equal(pairingBasis(single, "/users/8812"), "exact");
  assert.equal(pairingBasis(single, "/users/0"), "template-compatible");
  const two = group("GET", APP, "/a/{numeric}/b/{numeric}", [
    [1, "numeric", ["1", "3"]],
    [3, "numeric", ["2", "4"]],
  ]);
  assert.equal(pairingBasis(two, "/a/1/b/4"), "template-compatible");
  const fixed = group("GET", APP, "/c/{numeric}/d/{numeric}", [
    [1, "numeric", ["5"]],
    [3, "numeric", ["6"]],
  ]);
  assert.equal(pairingBasis(fixed, "/c/5/d/6"), "exact");
  assert.equal(pairingBasis(group("GET", APP, "/plain"), "/plain"), "exact");
});

test("reads network endpoint facts and prefers literal readings over candidates", () => {
  assert.equal(
    networkEndpointFacts({ kind: "javascript-asset", observations: [] }),
    undefined,
  );
  assert.equal(
    networkEndpointFacts(
      node("/settings", ["property:path"], { kind: "route" }),
    ),
    undefined,
  );
  const mixed = {
    node_id: "jag_node_mixed",
    kind: "endpoint",
    observations: [
      {
        properties: {
          endpoint_kind: "network",
          value: "/api/settings",
          mechanism: "call:cache.get",
          interpretation: "candidate",
        },
      },
      {
        properties: {
          endpoint_kind: "network",
          value: "/api/settings",
          mechanism: "call:fetch",
        },
      },
    ],
  };
  assert.deepEqual(networkEndpointFacts(mixed), {
    node: mixed,
    value: "/api/settings",
    mechanisms: ["call:fetch"],
    candidate: false,
  });
  const facts = networkEndpointFacts(
    node("KEY", ["call:translate.get"], { candidate: true }),
  );
  assert.equal(facts.candidate, true);
  assert.deepEqual(facts.mechanisms, ["call:translate.get"]);
});

test("classifies static endpoints with the 3591 statuses and reasons", () => {
  const login = {
    ...group("POST", APP, "/rest/user/login"),
    record_ordinals: [0, 1],
  };
  const matched = classify("/rest/user/login", ["call:http.post"], [login], {
    origins: [APP],
  });
  assert.deepEqual(matched.item, {
    static_node_id: matched.item.static_node_id,
    mechanisms: ["call:http.post"],
    method: { values: ["POST"], basis: "callee-name" },
    target: {
      origin: null,
      path: "/rest/user/login",
      origin_basis: "declared",
    },
    status: "matched",
    match_basis: "exact",
  });
  assert.deepEqual(
    matched.pairs.map(({ group: paired, basis }) => [paired, basis]),
    [[login, "exact"]],
  );
  assert.deepEqual(matched.referenced, [login]);
  assert.equal(matched.inferred, true);
  const absent = classify("/api/admin/export", ["call:fetch"], [login], {
    origins: [APP],
  });
  assert.equal(absent.item.status, "not-observed-in-capture");
  assert.deepEqual(absent.item.method, { values: [], basis: "unknown" });
  assert.equal(absent.inferred, true);
  const candidate = classify("KEY", ["call:translate.get"], [login], {
    origins: [APP],
    candidate: true,
  });
  assert.deepEqual(candidate.item, {
    static_node_id: candidate.item.static_node_id,
    mechanisms: ["call:translate.get"],
    status: "unknown",
    reason: "candidate-endpoint",
    method: null,
    target: null,
  });
  for (const [value, mechanisms, reason] of [
    ["GetUser", ["graphql:query"], "rpc-operation-not-path"],
    ["user.byId", ["trpc:procedure:query"], "rpc-operation-not-path"],
    ["/trpc", ["trpc:link:httpBatchLink"], "rpc-transport-base-url"],
    ["file:///etc/hosts", ["call:win.loadURL"], "unsupported-url-scheme"],
    ["api/users", ["call:fetch"], "relative-reference-base-unknown"],
  ])
    assert.equal(
      classify(value, mechanisms, [login], { origins: [APP] }).item.reason,
      reason,
      value,
    );
});

test("leaves undeclared origins unresolved and requires complete exercised coverage", () => {
  const users = group("GET", APP, "/api/users");
  const undeclared = classify("/api/users", ["call:fetch"], [users]);
  assert.equal(undeclared.item.status, "unknown");
  assert.equal(undeclared.item.reason, "origin-undeclared");
  assert.deepEqual(undeclared.item.target, {
    origin: null,
    path: "/api/users",
    origin_basis: "undeclared",
  });
  assert.deepEqual(undeclared.unresolved, [users]);
  const literal = classify(`${APP}/api/users`, ["call:fetch"], [users]);
  assert.equal(literal.item.status, "matched");
  assert.equal(literal.item.target.origin_basis, "literal");
  assert.equal(literal.inferred, false);
  assert.equal(
    classify("https://other.example.test/x", ["call:fetch"], [users]).item
      .reason,
    "origin-not-exercised",
  );
  const present = group("GET", APP, "/present");
  assert.equal(
    classify("/missing", ["call:fetch"], [present], {
      origins: [APP],
      records: { total: 5 },
    }).item.reason,
    "observed-coverage-incomplete",
  );
  assert.equal(
    classify("/missing", ["call:fetch"], [present], {
      origins: [APP],
      records: { excluded: 1 },
    }).item.reason,
    "observed-coverage-incomplete",
  );
  assert.equal(
    classify("/missing", ["call:fetch"], [present], {
      origins: [APP, "https://staging.example.test"],
    }).item.reason,
    "origin-not-exercised",
  );
  assert.equal(
    classify("/missing", ["call:fetch"], [present], { origins: [APP] }).item
      .status,
    "not-observed-in-capture",
  );
});

test("separates exact literals from template-compatible shapes and disagreeing methods", () => {
  const users = group(
    "GET",
    APP,
    "/users/{numeric}",
    [[1, "numeric", ["8812", "9031"]]],
    [0, 1],
  );
  const exact = classify(`${APP}/users/8812`, ["call:fetch"], [users]);
  assert.equal(exact.item.match_basis, "exact");
  assert.equal(exact.inferred, false);
  const compatible = classify(`${APP}/users/0`, ["call:fetch"], [users]);
  assert.equal(compatible.item.match_basis, "template-compatible");
  assert.equal(compatible.inferred, true);
  assert.equal(
    classify(`${APP}/users/me`, ["call:fetch"], [users]).item.status,
    "not-observed-in-capture",
  );
  const getX = group("GET", APP, "/x");
  const ambiguous = classify("/x", ["call:api.post"], [getX], {
    origins: [APP],
  });
  assert.equal(ambiguous.item.status, "ambiguous");
  assert.equal(ambiguous.item.reason, "method-inference-disagrees");
  assert.deepEqual(ambiguous.referenced, [getX]);
  assert.deepEqual(ambiguous.pairs, [{ group: getX, basis: "exact" }]);
  const both = classify(
    "/both",
    ["call:fetch"],
    [group("POST", APP, "/both"), group("GET", APP, "/both")],
    { origins: [APP] },
  );
  assert.deepEqual(
    both.pairs.map(({ group: paired }) => paired.method),
    ["GET", "POST"],
  );
  const socket = classify(
    "/socket",
    ["call:WebSocket"],
    [group("GET", "wss://app.example.test", "/socket")],
    {
      origins: [APP],
    },
  );
  assert.equal(socket.item.status, "matched");
  assert.equal(socket.pairs[0].group.origin, "wss://app.example.test");
});
