import { expect, it } from "vitest";

import { WebNetworkApiSurfaceAccumulator } from "../analysisView/WebNetworkApiSurfaceAccumulator.js";
import type { WebNetworkCaptureRecord } from "../webNetworkCapture.js";
import {
  createJavaScriptApplicationGraph,
  createJavaScriptApplicationNode,
} from "./javascriptApplicationGraph.js";
import {
  artifactEvidence,
  completeCoverage,
} from "./javascriptApplicationGraph.fixture.js";
import { compareStaticAndObservedEndpoints } from "./javascriptEndpointTrafficComparison.js";
import { analyzeJavaScriptStaticSource } from "./javascriptStaticAnalysis.js";
import {
  type ENDPOINT_TRAFFIC_COLLECTIONS,
  endpointTrafficComparisonResultSchema,
  type EndpointTrafficStaticItem,
} from "./javascriptEndpointTrafficComparisonSchemas.js";

type EndpointTrafficCollection = (typeof ENDPOINT_TRAFFIC_COLLECTIONS)[number];
const SHA = "a".repeat(64);
const STATIC_ID = `ev_${"1".repeat(64)}`;
const OBSERVED_ID = `ev_${"2".repeat(64)}`;
const APP = "https://app.example.test";

interface StaticFinding {
  readonly value: string;
  readonly mechanisms: readonly string[];
  readonly kind?: "network" | "route";
  readonly candidate?: boolean;
}

const endpointNode = ({
  value,
  mechanisms,
  kind = "network",
  candidate = false,
}: StaticFinding) =>
  createJavaScriptApplicationNode({
    kind: "endpoint",
    identity: {
      strategy: "artifact-local-key",
      stability: "artifact-version",
      artifact_sha256: SHA,
      namespace: kind,
      key: JSON.stringify([candidate ? "candidate" : "literal", value]),
    },
    observations: mechanisms.map((mechanism) => ({
      label: value,
      properties: {
        endpoint_kind: kind,
        value,
        mechanism,
        ...(candidate ? { interpretation: "candidate" } : {}),
      },
      evidence: artifactEvidence(SHA, "main.js", "ast-static-analysis"),
    })),
  });

const graphOf = (
  findings: readonly StaticFinding[],
  coverage: "complete" | "partial" = "complete",
) => {
  const asset = createJavaScriptApplicationNode({
    kind: "javascript-asset",
    identity: {
      strategy: "canonical-path",
      stability: "artifact-version",
      artifact_sha256: SHA,
      path: "main.js",
    },
    observations: [
      {
        label: "main.js",
        properties: {},
        evidence: artifactEvidence(SHA, "main.js"),
      },
    ],
  });
  return createJavaScriptApplicationGraph({
    schema: "JavaScriptApplicationGraph",
    root_node_ids: [asset.node_id],
    nodes: [asset, ...findings.map(endpointNode)],
    edges: [],
    coverage:
      coverage === "complete"
        ? completeCoverage
        : { status: "partial", truncated: false, omitted_count: 2, limits: [] },
    limitations: coverage === "complete" ? [] : ["Two files were omitted."],
  });
};

const request = (
  ordinal: number,
  method: string,
  url: string | null,
): WebNetworkCaptureRecord => ({
  ordinal,
  location: { kind: "json-pointer", pointer: `/log/entries/${ordinal}` },
  reported: {
    request: { method, url },
    response: { status: 200, content: { mimeType: "application/json" } },
  },
  binary_fields: [],
  numeric_literals: [],
  redactions: [],
  limitations: [],
});

const observedOf = (
  requests: readonly (readonly [string, string | null])[],
  total = requests.length,
) => {
  const accumulator = new WebNetworkApiSurfaceAccumulator();
  requests.forEach(([method, url], ordinal) => {
    const added = accumulator.add(request(ordinal, method, url));
    if (!added.ok) throw added.error;
  });
  const grouped = accumulator.all();
  return {
    evidenceId: OBSERVED_ID,
    artifact: { path: "/captures/session.har", sha256: "c".repeat(64) },
    groups: grouped.groups,
    records: {
      examined: requests.length,
      total,
      excluded: grouped.excluded_records.length,
    },
    limitations: grouped.limitations,
  };
};

const resolvePairings = (
  paired: readonly { readonly record_ordinals: readonly number[] }[],
  item: EndpointTrafficStaticItem,
) =>
  "observed" in item
    ? {
        ...item,
        observed: item.observed.map(({ group, basis }) => {
          const resolved = paired[group];
          if (resolved === undefined)
            throw new Error(`Pairing references missing group ${group}`);
          return { ...resolved, basis };
        }),
      }
    : item;

const compare = (
  findings: readonly StaticFinding[],
  requests: readonly (readonly [string, string | null])[],
  options: {
    readonly origins?: readonly string[];
    readonly total?: number;
    readonly offset?: number;
    readonly limit?: number;
    readonly coverage?: "complete" | "partial";
  } = {},
) => {
  const graph = graphOf(findings, options.coverage);
  const observed = observedOf(requests, options.total);
  const select = (collection: EndpointTrafficCollection) => {
    const comparison = compareStaticAndObservedEndpoints({
      static: { evidenceId: STATIC_ID, rootArtifactSha256: SHA, graph },
      observed,
      origins: options.origins ?? [],
      collection,
      offset: options.offset ?? 0,
      limit: options.limit ?? 50,
    });
    // The contract owns the complete result shape and its summary invariants.
    endpointTrafficComparisonResultSchema.parse(comparison.result);
    return comparison;
  };
  const comparison = select("static-endpoints");
  const { result } = comparison;
  if (result.collection !== "static-endpoints")
    throw new Error("Expected static endpoints");
  const unmatched = select("observed-without-static-match").result;
  const unresolved = select("observed-unresolved").result;
  if (
    unmatched.collection !== "observed-without-static-match" ||
    unresolved.collection !== "observed-unresolved"
  )
    throw new Error("Expected observed collections");
  /** One item, with each pairing resolved through the page's group table. */
  const itemFor = (value: string) => {
    const node = endpointNode(
      findings.find((finding) => finding.value === value)!,
    );
    const item = result.items.find(
      ({ static_node_id }) => static_node_id === node.node_id,
    );
    if (item === undefined) throw new Error(`Missing item for ${value}`);
    return resolvePairings(result.paired_groups, item);
  };
  return {
    result,
    inferred: comparison.inferred,
    unmatched,
    unresolved,
    itemFor,
  };
};

it("classifies the static analyzer's own findings and leaves string-built URLs to the capture", () => {
  const findings = analyzeJavaScriptStaticSource(`
      fetch("/api/users");
      http.post("/rest/user/login");
      fetch("/api/admin/export");
      const base = "/api/";
      fetch(base + "orders");
      translate.get("KEY");
      new EventSource("/events");
      navigator.sendBeacon("/beacon");
      new WebSocket("/socket");
      axios.get("https://api.example.test/v1/items?page=2");
    `).endpoints.map(
    ({ kind, value, mechanism, interpretation }): StaticFinding => ({
      value,
      mechanisms: [mechanism],
      kind,
      candidate: interpretation === "candidate",
    }),
  );
  const { itemFor, unmatched } = compare(
    findings,
    [
      ["GET", `${APP}/api/users`],
      ["POST", `${APP}/rest/user/login`],
      ["GET", `${APP}/api/orders`],
      ["GET", `${APP}/events`],
      ["GET", `${APP}/beacon`],
      ["GET", "wss://app.example.test/socket"],
      ["GET", "https://api.example.test/v1/items?page=3"],
    ],
    { origins: [APP] },
  );
  expect(
    Object.fromEntries(
      findings.map(({ value }) => [value, itemFor(value).status]),
    ),
  ).toEqual({
    "/api/users": "matched",
    "/rest/user/login": "matched",
    "/api/admin/export": "not-observed-in-capture",
    KEY: "unknown",
    "/events": "matched",
    "/beacon": "ambiguous",
    "/socket": "matched",
    "https://api.example.test/v1/items?page=2": "matched",
  });
  expect(unmatched.items).toEqual([
    expect.objectContaining({ path_template: "/api/orders" }),
  ]);
});

it("reports exact, not-observed, candidate and unmatched observed groups", () => {
  const { result, inferred, itemFor, unmatched } = compare(
    [
      { value: "/rest/user/login", mechanisms: ["call:http.post"] },
      { value: "/api/admin/export", mechanisms: ["call:fetch"] },
      {
        value: "KEY",
        mechanisms: ["call:translate.get"],
        candidate: true,
      },
    ],
    [
      ["POST", `${APP}/rest/user/login?next=/home`],
      ["POST", `${APP}/rest/user/login`],
      ["GET", `${APP}/v2/feed/550e8400-e29b-41d4-a716-446655440000`],
    ],
    { origins: [APP] },
  );
  expect(inferred).toBe(true);
  expect(result.summary).toEqual({
    static_network_endpoints: 3,
    matched: 1,
    matched_exact: 1,
    ambiguous: 0,
    not_observed_in_capture: 1,
    unknown: 1,
    unknown_reasons: [{ reason: "candidate-endpoint", count: 1 }],
    observed_groups: 2,
    observed_matched: 1,
    observed_ambiguous: 0,
    observed_unresolved: 0,
    observed_without_static_match: 1,
  });
  expect(itemFor("/rest/user/login")).toMatchObject({
    status: "matched",
    match_basis: "exact",
    method: { values: ["POST"], basis: "callee-name" },
    target: {
      origin: null,
      path: "/rest/user/login",
      origin_basis: "declared",
    },
    observed: [
      {
        method: "POST",
        origin: APP,
        path_template: "/rest/user/login",
        basis: "exact",
        record_ordinals: [0, 1],
      },
    ],
  });
  expect(itemFor("/api/admin/export")).toMatchObject({
    status: "not-observed-in-capture",
    method: { values: [], basis: "unknown" },
  });
  expect(itemFor("KEY")).toEqual({
    static_node_id: itemFor("KEY").static_node_id,
    mechanisms: ["call:translate.get"],
    status: "unknown",
    reason: "candidate-endpoint",
    method: null,
    target: null,
  });
  expect(unmatched.items).toEqual([
    {
      method: "GET",
      origin: APP,
      path_template: "/v2/feed/{uuid}",
      record_ordinals: [2],
    },
  ]);
  expect(JSON.stringify(result)).not.toContain("next=");
});

it("joins absolute URLs literally and keeps origin-relative paths unknown without declarations", () => {
  const { result, inferred, itemFor } = compare(
    [
      {
        value: "https://api.example.test/v1/items?token=secret#frag",
        mechanisms: ["call:fetch"],
      },
      { value: "/api/users", mechanisms: ["call:fetch"] },
      { value: "api/users", mechanisms: ["call:fetch"] },
      { value: "//cdn.example.test/x", mechanisms: ["call:fetch"] },
      { value: "file:///etc/hosts", mechanisms: ["call:win.loadURL"] },
      { value: "https://other.example.test/x", mechanisms: ["call:fetch"] },
    ],
    [["GET", "https://api.example.test/v1/items"]],
  );
  expect(inferred).toBe(false);
  expect(
    itemFor("https://api.example.test/v1/items?token=secret#frag"),
  ).toMatchObject({
    status: "matched",
    match_basis: "exact",
    target: {
      origin: "https://api.example.test",
      path: "/v1/items",
      origin_basis: "literal",
    },
  });
  expect(itemFor("/api/users")).toMatchObject({
    status: "unknown",
    reason: "origin-undeclared",
    target: { origin: null, path: "/api/users", origin_basis: "undeclared" },
  });
  expect(itemFor("api/users")).toMatchObject({
    reason: "relative-reference-base-unknown",
    target: null,
  });
  expect(itemFor("//cdn.example.test/x")).toMatchObject({
    reason: "relative-reference-base-unknown",
  });
  expect(itemFor("file:///etc/hosts")).toMatchObject({
    reason: "unsupported-url-scheme",
  });
  expect(itemFor("https://other.example.test/x")).toMatchObject({
    status: "unknown",
    reason: "origin-not-exercised",
  });
  const serialized = JSON.stringify(result);
  for (const value of ["secret", "frag", "hosts", "cdn.example.test"])
    expect(serialized).not.toContain(value);
});

it("separates exact literals from template-compatible route shapes", () => {
  const { result, inferred, itemFor } = compare(
    [
      { value: `${APP}/users/8812`, mechanisms: ["call:fetch"] },
      { value: `${APP}/users/0`, mechanisms: ["call:fetch"] },
      { value: `${APP}/a/1/b/4`, mechanisms: ["call:fetch"] },
      { value: `${APP}/c/5/d/6`, mechanisms: ["call:fetch"] },
      { value: `${APP}/users/me`, mechanisms: ["call:fetch"] },
    ],
    [
      ["GET", `${APP}/users/8812`],
      ["GET", `${APP}/users/9031`],
      ["GET", `${APP}/a/1/b/2`],
      ["GET", `${APP}/a/3/b/4`],
      ["GET", `${APP}/c/5/d/6`],
    ],
  );
  expect(inferred).toBe(true);
  expect(itemFor(`${APP}/users/8812`)).toMatchObject({
    match_basis: "exact",
    observed: [{ path_template: "/users/{numeric}", basis: "exact" }],
  });
  expect(itemFor(`${APP}/users/0`)).toMatchObject({
    match_basis: "template-compatible",
    observed: [{ basis: "template-compatible" }],
  });
  // Two varying positions cannot prove one recorded request had this pair.
  expect(itemFor(`${APP}/a/1/b/4`)).toMatchObject({
    match_basis: "template-compatible",
  });
  expect(itemFor(`${APP}/c/5/d/6`)).toMatchObject({ match_basis: "exact" });
  expect(itemFor(`${APP}/users/me`)).toMatchObject({
    status: "not-observed-in-capture",
  });
  expect(result.summary).toMatchObject({ matched: 4, matched_exact: 2 });
});

it("compares recorded still-encoded paths without normalization", () => {
  const { itemFor, unmatched } = compare(
    [
      { value: `${APP}/admin`, mechanisms: ["call:fetch"] },
      { value: `${APP}/a/%2e%2e/admin`, mechanisms: ["call:fetch"] },
      { value: "/files/my file", mechanisms: ["call:fetch"] },
      { value: `${APP}/api/users/`, mechanisms: ["call:fetch"] },
      { value: `${APP}/API/users`, mechanisms: ["call:fetch"] },
    ],
    [
      ["GET", `${APP}/a/%2e%2e/admin`],
      ["GET", `${APP}/api/users`],
    ],
    { origins: [APP] },
  );
  expect(itemFor(`${APP}/admin`)).toMatchObject({
    status: "not-observed-in-capture",
  });
  expect(itemFor(`${APP}/a/%2e%2e/admin`)).toMatchObject({
    status: "unknown",
    reason: "target-not-canonical",
    target: null,
  });
  expect(itemFor("/files/my file")).toMatchObject({
    reason: "target-not-canonical",
  });
  expect(itemFor(`${APP}/api/users/`)).toMatchObject({
    status: "not-observed-in-capture",
  });
  expect(itemFor(`${APP}/API/users`)).toMatchObject({
    status: "not-observed-in-capture",
  });
  expect(unmatched.items.map((group) => group.path_template)).toEqual([
    "/a/%2e%2e/admin",
    "/api/users",
  ]);
});

it("uses callee-name and API-defined methods without overriding observed methods", () => {
  const { result, itemFor, unmatched } = compare(
    [
      { value: "/x", mechanisms: ["call:api.post"] },
      // A second, literal-origin finding matches GET /x outright.
      { value: `${APP}/x`, mechanisms: ["call:fetch"] },
      { value: "/stream", mechanisms: ["call:EventSource"] },
      { value: "/beacon", mechanisms: ["call:navigator.sendBeacon"] },
      { value: "/both", mechanisms: ["call:fetch"] },
      { value: "/listed", mechanisms: ["call:api.get", "call:api.delete"] },
    ],
    [
      ["GET", `${APP}/x`],
      ["GET", `${APP}/stream`],
      ["GET", `${APP}/beacon`],
      ["GET", `${APP}/both`],
      ["POST", `${APP}/both`],
      ["GET", `${APP}/listed`],
      ["PUT", `${APP}/listed`],
    ],
    { origins: [APP] },
  );
  expect(itemFor("/x")).toMatchObject({
    status: "ambiguous",
    reason: "method-inference-disagrees",
    method: { values: ["POST"], basis: "callee-name" },
    observed: [{ method: "GET", basis: "exact" }],
  });
  expect(itemFor("/stream")).toMatchObject({
    status: "matched",
    method: { values: ["GET"], basis: "api-definition" },
  });
  // GET /x is listed by both a matched and an ambiguous item and counts as
  // matched; GET /beacon is listed only by an ambiguous item.
  expect(result.summary).toMatchObject({
    observed_groups: 7,
    observed_matched: 5,
    observed_ambiguous: 1,
    observed_unresolved: 0,
    observed_without_static_match: 1,
  });
  expect(itemFor("/beacon")).toMatchObject({
    status: "ambiguous",
    method: { values: ["POST"], basis: "api-definition" },
  });
  expect(itemFor("/both")).toMatchObject({
    status: "matched",
    observed: [{ method: "GET" }, { method: "POST" }],
  });
  expect(itemFor("/listed")).toMatchObject({
    status: "matched",
    method: { values: ["DELETE", "GET"], basis: "callee-name" },
    observed: [{ method: "GET" }],
  });
  // Static discovery found /listed only through get and delete callees.
  expect(unmatched.items).toEqual([
    expect.objectContaining({ method: "PUT", path_template: "/listed" }),
  ]);
});

it("requires complete exercised observed coverage before reporting not observed", () => {
  const findings = [{ value: "/missing", mechanisms: ["call:fetch"] }];
  expect(
    compare(findings, [["GET", `${APP}/present`]], {
      origins: [APP],
      total: 5,
    }).itemFor("/missing"),
  ).toMatchObject({
    status: "unknown",
    reason: "observed-coverage-incomplete",
    target: { path: "/missing" },
  });
  expect(
    compare(
      findings,
      [
        ["GET", `${APP}/present`],
        ["GET", null],
      ],
      { origins: [APP] },
    ).itemFor("/missing"),
  ).toMatchObject({ reason: "observed-coverage-incomplete" });
  const multiple = compare(findings, [["GET", `${APP}/present`]], {
    origins: [APP, "https://staging.example.test"],
  });
  expect(multiple.itemFor("/missing")).toMatchObject({
    reason: "origin-not-exercised",
  });
});

it("joins declared origins, including WebSocket schemes, as inferences", () => {
  const staging = "https://staging.example.test";
  const { itemFor } = compare(
    [
      { value: "/api/users", mechanisms: ["call:fetch"] },
      { value: "/socket", mechanisms: ["call:WebSocket"] },
    ],
    [
      ["GET", `${APP}/api/users`],
      ["GET", `${staging}/api/users`],
      ["GET", "wss://app.example.test/socket"],
    ],
    { origins: [APP, staging] },
  );
  expect(itemFor("/api/users")).toMatchObject({
    status: "matched",
    observed: [{ origin: APP }, { origin: staging }],
  });
  expect(itemFor("/socket")).toMatchObject({
    status: "matched",
    observed: [{ origin: "wss://app.example.test" }],
  });
});

it("never compares RPC operation names or client routes with request paths", () => {
  const { result, itemFor } = compare(
    [
      { value: "GetUser", mechanisms: ["graphql:query"] },
      { value: "user.byId", mechanisms: ["trpc:procedure:query"] },
      { value: "/trpc", mechanisms: ["trpc:link:httpBatchLink"] },
      { value: "/settings", mechanisms: ["property:path"], kind: "route" },
    ],
    [
      ["POST", `${APP}/graphql`],
      ["GET", `${APP}/trpc`],
      ["GET", `${APP}/settings`],
    ],
    { origins: [APP] },
  );
  expect(result.summary.static_network_endpoints).toBe(3);
  expect(itemFor("GetUser")).toMatchObject({
    reason: "rpc-operation-not-path",
  });
  expect(itemFor("user.byId")).toMatchObject({
    reason: "rpc-operation-not-path",
  });
  expect(itemFor("/trpc")).toMatchObject({
    reason: "rpc-transport-base-url",
  });
  expect(result.summary.observed_without_static_match).toBe(3);
});

it("pages each collection independently and reports static graph coverage", () => {
  const findings = ["/a", "/b", "/c"].map((value) => ({
    value,
    mechanisms: ["call:fetch"],
  }));
  const requests = ["/x", "/y", "/z", "/w"].map(
    (path) => ["GET", `${APP}${path}`] as const,
  );
  const first = compare(findings, requests, {
    origins: [APP],
    limit: 2,
    coverage: "partial",
  });
  expect(first.result.page).toEqual({
    offset: 0,
    limit: 2,
    total: 3,
    next_offset: 2,
  });
  expect(first.result.items.map(({ target }) => target?.path)).toEqual([
    "/a",
    "/b",
  ]);
  expect(first.unmatched.page).toEqual({
    offset: 0,
    limit: 2,
    total: 4,
    next_offset: 2,
  });
  expect(first.unresolved.page).toEqual({
    offset: 0,
    limit: 2,
    total: 0,
    next_offset: null,
  });
  expect(first.result.coverage.static_graph).toBe("partial");
  expect(first.result.limitations).toEqual(
    expect.arrayContaining([
      expect.stringContaining("Static graph coverage is partial"),
    ]),
  );
  const second = compare(findings, requests, {
    origins: [APP],
    offset: 2,
    limit: 2,
  });
  expect(second.result.page.next_offset).toBeNull();
  expect(second.result.items.map(({ target }) => target?.path)).toEqual(["/c"]);
  // The observed collection keeps its own continuation past the static list.
  expect(second.unmatched.page.next_offset).toBeNull();
  expect(second.unmatched.items.map((group) => group.path_template)).toEqual([
    "/y",
    "/z",
  ]);
  expect(second.result.summary.static_network_endpoints).toBe(3);
});

it("keeps a literal request when the same value also has a candidate reading", () => {
  const value = "/api/settings";
  const node = createJavaScriptApplicationNode({
    kind: "endpoint",
    identity: {
      strategy: "artifact-local-key",
      stability: "artifact-version",
      artifact_sha256: SHA,
      namespace: "network",
      key: JSON.stringify(["literal", value]),
    },
    observations: [
      ["call:fetch", false],
      ["call:cache.get", true],
    ].map(([mechanism, candidate]) => ({
      label: value,
      properties: {
        endpoint_kind: "network",
        value,
        mechanism: String(mechanism),
        ...(candidate === true ? { interpretation: "candidate" } : {}),
      },
      evidence: artifactEvidence(SHA, "main.js", "ast-static-analysis"),
    })),
  });
  const graph = graphOf([]);
  const comparison = compareStaticAndObservedEndpoints({
    static: {
      evidenceId: STATIC_ID,
      rootArtifactSha256: SHA,
      graph: createJavaScriptApplicationGraph({
        schema: "JavaScriptApplicationGraph",
        root_node_ids: graph.root_node_ids,
        nodes: [...graph.nodes, node],
        edges: [],
        coverage: completeCoverage,
        limitations: [],
      }),
    },
    observed: observedOf([["GET", `${APP}${value}`]]),
    origins: [APP],
    collection: "static-endpoints",
    offset: 0,
    limit: 50,
  });
  expect(comparison.result.items).toEqual([
    expect.objectContaining({
      static_node_id: node.node_id,
      mechanisms: ["call:fetch"],
      status: "matched",
      method: { values: [], basis: "unknown" },
    }),
  ]);
  // A node whose every observation is a candidate stays unknown.
  expect(
    compare(
      [{ value, mechanisms: ["call:cache.get"], candidate: true }],
      [["GET", `${APP}${value}`]],
    ).itemFor(value),
  ).toMatchObject({ status: "unknown", reason: "candidate-endpoint" });
});

it("keeps same-shaped groups of undeclared-origin paths out of the unmatched list", () => {
  const { result, unmatched, unresolved, itemFor } = compare(
    [
      { value: "/api/login", mechanisms: ["call:api.post"] },
      { value: "/users/0", mechanisms: ["call:fetch"] },
      {
        value: "https://api.example.test/v1/items",
        mechanisms: ["call:fetch"],
      },
    ],
    [
      ["POST", `${APP}/api/login`],
      ["GET", "https://staging.example.test/api/login"],
      ["GET", `${APP}/users/42`],
      ["GET", "https://api.example.test/v1/items"],
      ["GET", `${APP}/v2/feed`],
    ],
  );
  expect(itemFor("/api/login")).toMatchObject({
    status: "unknown",
    reason: "origin-undeclared",
  });
  expect(result.summary).toMatchObject({
    observed_groups: 5,
    observed_matched: 1,
    observed_ambiguous: 0,
    observed_unresolved: 3,
    observed_without_static_match: 1,
  });
  expect(unmatched.items.map((group) => group.path_template)).toEqual([
    "/v2/feed",
  ]);
  const login = endpointNode({
    value: "/api/login",
    mechanisms: ["call:api.post"],
  });
  const users = endpointNode({ value: "/users/0", mechanisms: ["call:fetch"] });
  expect(unresolved.items).toEqual([
    {
      method: "POST",
      origin: APP,
      path_template: "/api/login",
      record_ordinals: [0],
      reason: "origin-undeclared",
      static_node_ids: [login.node_id],
    },
    {
      method: "GET",
      origin: APP,
      path_template: "/users/{numeric}",
      record_ordinals: [2],
      reason: "origin-undeclared",
      static_node_ids: [users.node_id],
    },
    {
      method: "GET",
      origin: "https://staging.example.test",
      path_template: "/api/login",
      record_ordinals: [1],
      reason: "origin-undeclared",
      static_node_ids: [login.node_id],
    },
  ]);
});

it("lists each paired group once per page however many static items share it", () => {
  const value = "/api/users";
  const nodes = ["a", "b", "c"].map((digit) =>
    createJavaScriptApplicationNode({
      kind: "endpoint",
      identity: {
        strategy: "artifact-local-key",
        stability: "artifact-version",
        artifact_sha256: digit.repeat(64),
        namespace: "network",
        key: JSON.stringify(["literal", value]),
      },
      observations: [
        {
          label: value,
          properties: {
            endpoint_kind: "network",
            value,
            mechanism: "call:fetch",
          },
          evidence: artifactEvidence(
            digit.repeat(64),
            `${digit}.js`,
            "ast-static-analysis",
          ),
        },
      ],
    }),
  );
  const graph = graphOf([]);
  const requests = Array.from(
    { length: 100 },
    () => ["GET", `${APP}${value}`] as const,
  );
  const { result } = compareStaticAndObservedEndpoints({
    static: {
      evidenceId: STATIC_ID,
      rootArtifactSha256: SHA,
      graph: createJavaScriptApplicationGraph({
        schema: "JavaScriptApplicationGraph",
        root_node_ids: graph.root_node_ids,
        nodes: [...graph.nodes, ...nodes],
        edges: [],
        coverage: completeCoverage,
        limitations: [],
      }),
    },
    observed: observedOf([...requests, ["POST", `${APP}${value}`]]),
    origins: [APP],
    collection: "static-endpoints",
    offset: 0,
    limit: 50,
  });
  endpointTrafficComparisonResultSchema.parse(result);
  if (result.collection !== "static-endpoints")
    throw new Error("Expected static endpoints");
  expect(result.paired_groups.map(({ method }) => method)).toEqual([
    "GET",
    "POST",
  ]);
  expect(result.paired_groups[0]?.record_ordinals).toHaveLength(100);
  expect(
    result.items.map((item) => "observed" in item && item.observed),
  ).toEqual(
    nodes.map(() => [
      { group: 0, basis: "exact" },
      { group: 1, basis: "exact" },
    ]),
  );
});

it("pins the analyzer mechanism names that drive origin mapping and API-defined methods", () => {
  const endpoints = analyzeJavaScriptStaticSource(`
    new WebSocket("/socket");
    new EventSource("/stream");
    navigator.sendBeacon("/b");
  `).endpoints;
  expect(endpoints.map(({ value, mechanism }) => [value, mechanism])).toEqual([
    ["/socket", "call:WebSocket"],
    ["/stream", "call:EventSource"],
    ["/b", "call:navigator.sendBeacon"],
  ]);
  const { itemFor } = compare(
    endpoints.map(({ value, mechanism }) => ({
      value,
      mechanisms: [mechanism],
    })),
    [
      ["GET", "wss://app.example.test/socket"],
      ["GET", `${APP}/stream`],
      ["POST", `${APP}/b`],
    ],
    { origins: [APP] },
  );
  expect(itemFor("/socket")).toMatchObject({
    status: "matched",
    method: { values: [], basis: "unknown" },
    observed: [{ origin: "wss://app.example.test", method: "GET" }],
  });
  expect(itemFor("/stream")).toMatchObject({
    status: "matched",
    method: { values: ["GET"], basis: "api-definition" },
  });
  expect(itemFor("/b")).toMatchObject({
    status: "matched",
    method: { values: ["POST"], basis: "api-definition" },
    observed: [{ method: "POST" }],
  });
});
