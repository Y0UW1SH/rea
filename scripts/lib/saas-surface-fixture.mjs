import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { serializeFixture } from "./saas-api-contract-fixture.mjs";

// Deterministic synthetic inputs for the surface-coverage companion: an api-surface
// view, a scenario capture and the origins file, all describing the traffic that the
// committed bundle scripts/fixtures/saas-surface/bundle/main.js declares (plus gaps and
// undeclared traffic on purpose). The capture shapes mirror the increment-1 fixture
// builder and must parse with browserScenarioCaptureSchema; the groups must parse with
// the api-surface group schema (tests/boundary/filesystem/saasSurfaceFixtures.test.ts).
// static-analysis.json is not built here: the real CLI generates it from the bundle.
// Nothing here is vendor data.

export { serializeFixture };

export const SURFACE_ORIGIN = "https://app.example.test";
export const SURFACE_REPLACEMENT_ORIGIN = "http://localhost:4300";
const CDN_ORIGIN = "https://cdn.example.test";

const LIMITS = {
  max_events: 10_000,
  max_event_allocation_bytes: 4 * 1024 * 1024,
  max_total_event_allocation_bytes: 16 * 1024 * 1024,
  max_network_transactions: 1024,
  max_network_body_bytes: 64 * 1024,
  max_network_body_allocation_bytes: 1024 * 1024,
  max_network_header_allocation_bytes: 1024 * 1024,
  max_network_metadata_allocation_bytes: 1024 * 1024,
};
const COMPLETE = {
  status: "complete",
  equality_eligible: true,
  missing_sections: [],
  truncated_sections: [],
};
const NOT_REQUESTED = { state: "not_requested" };
const GRAPHQL_QUERY =
  "query ListCustomers($first: Int) { customers(first: $first) { id name } }";

const captured = (text, representation, mediaType) => {
  const bytes = Buffer.from(text, "utf8");
  return {
    state: "captured",
    representation,
    encoding: "base64",
    content: bytes.toString("base64"),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    media_type: mediaType,
    redacted: false,
  };
};
const jsonRequest = (value) =>
  captured(
    JSON.stringify(value),
    "browser-exposed-request-bytes",
    "application/json",
  );
const jsonResponse = (text) =>
  captured(text, "playwright-response-body-bytes", "application/json");
const url = (origin, path, names = []) => ({
  url: `${origin}${path}`,
  origin,
  query_parameter_names: names,
  redacted: false,
});
const requestHeaders = {
  state: "captured",
  items: [
    { name: "accept", value: "application/json", redacted: false },
    { name: "authorization", value: null, redacted: true },
  ],
};
const responseHeaders = {
  state: "captured",
  items: [{ name: "content-type", value: "application/json", redacted: false }],
};

/** One transaction's events: request, optional request body, response, optional body, finished. */
function transaction(sequence, entry) {
  const base = {
    step_index: entry.step,
    transaction_id: entry.id,
    redirected_from_transaction_id: null,
    redirected_from_transaction_state: "root",
    method: entry.method,
    url: entry.url,
    resource_type: entry.resource_type ?? "fetch",
    header_names: ["accept", "authorization"],
    failure: null,
  };
  const events = [];
  let next = sequence;
  const content = (phase, source, body) => ({
    sequence: next++,
    step_index: entry.step,
    kind: "network-content",
    transaction_id: entry.id,
    phase,
    source_event_sequence: source,
    headers: phase === "request" ? requestHeaders : responseHeaders,
    body,
  });
  const requestSequence = next;
  events.push({ ...base, sequence: next++, kind: "request", status: null });
  if (entry.request !== undefined)
    events.push(content("request", requestSequence, entry.request));
  const responseSequence = next;
  events.push({
    ...base,
    sequence: next++,
    kind: "response",
    status: entry.status,
  });
  if (entry.response !== undefined)
    events.push(content("response", responseSequence, entry.response));
  events.push({
    ...base,
    sequence: next++,
    kind: "request-finished",
    status: null,
  });
  return { events, next };
}

/** The transactions of the synthetic capture, by step. */
const transactions = (origin) => [
  {
    step: 1,
    id: "t1",
    method: "GET",
    url: url(origin, "/api/invoices?page=1", ["page"]),
    status: 200,
    response: jsonResponse('[{"id":17,"number":"INV-17"}]'),
  },
  {
    step: 1,
    id: "t2",
    method: "GET",
    url: url(origin, "/api/customers/42"),
    status: 200,
    response: jsonResponse('{"id":42,"name":"Customer A"}'),
  },
  {
    step: 1,
    id: "t3",
    method: "GET",
    url: url(origin, "/api/customers/43"),
    status: 200,
    response: jsonResponse('{"id":43,"name":"Customer B"}'),
  },
  {
    step: 1,
    id: "t4",
    method: "GET",
    url: url(origin, "/assets/logo.png"),
    status: 200,
    resource_type: "image",
    response: captured("PNG", "playwright-response-body-bytes", "image/png"),
  },
  {
    step: 1,
    id: "t5",
    method: "GET",
    url: url(origin, "/api/reports/stream"),
    status: 200,
    resource_type: "eventsource",
    response: captured(
      "data: ok\n\n",
      "playwright-response-body-bytes",
      "text/event-stream",
    ),
  },
  {
    step: 1,
    id: "t6",
    method: "GET",
    url: url(origin, "/trpc/user.byId,user.list?batch=1", ["batch"]),
    status: 200,
    response: jsonResponse(
      '[{"result":{"data":{"id":42}}},{"result":{"data":[]}}]',
    ),
  },
  {
    step: 2,
    id: "t7",
    method: "POST",
    url: url(origin, "/api/invoices"),
    status: 201,
    resource_type: "xhr",
    request: jsonRequest({ customer_id: 42, lines: [] }),
    response: jsonResponse('{"id":18,"number":"INV-18"}'),
  },
  {
    step: 2,
    id: "t8",
    method: "POST",
    url: url(origin, "/graphql"),
    status: 200,
    request: jsonRequest({
      query: GRAPHQL_QUERY,
      operationName: "ListCustomers",
      variables: { first: 10 },
    }),
    response: jsonResponse(
      '{"data":{"customers":[{"id":"42","name":"Customer A"}]}}',
    ),
  },
  {
    step: 2,
    id: "t9",
    method: "POST",
    url: url(origin, "/api/invoices/archive"),
    status: 204,
  },
  {
    step: 2,
    id: "t10",
    method: "GET",
    url: url(CDN_ORIGIN, "/lib.json"),
    status: 200,
    response: jsonResponse('{"cdn":true}'),
  },
];

const history = (origin, paths) => ({
  state: "captured",
  value: {
    length: paths.length,
    current_url: url(origin, paths[paths.length - 1]),
    navigation_entries: paths.map((path) => ({
      type: "navigate",
      name: url(origin, path),
    })),
  },
});

/** One completed step whose event range covers the transactions recorded for it. */
const stepRecord = (origin, ranges, next) => (entry) => {
  const range = ranges.get(entry.index) ?? { start: next, end: next - 1 };
  return {
    step_index: entry.index,
    step_id: entry.id,
    action: entry.action,
    status: "completed",
    error: null,
    elapsed_ms: entry.index * 40,
    before_url: url(origin, entry.before),
    after_url: url(origin, entry.after),
    event_sequence_start: range.start,
    event_sequence_end: range.end,
    artifacts: {
      screenshot: NOT_REQUESTED,
      dom: NOT_REQUESTED,
      accessibility: NOT_REQUESTED,
      url: { state: "captured", value: url(origin, entry.after) },
      history:
        entry.history === undefined
          ? NOT_REQUESTED
          : history(origin, entry.history),
      storage: NOT_REQUESTED,
    },
    completeness: COMPLETE,
  };
};

/** The synthetic capture: three navigations with the traffic the bundle declares, plus gaps. */
export function buildSurfaceCapture(origin = SURFACE_ORIGIN) {
  const events = [];
  const ranges = new Map();
  let sequence = 1;
  for (const entry of transactions(origin)) {
    const range = ranges.get(entry.step) ?? { start: sequence, end: sequence };
    const built = transaction(sequence, entry);
    events.push(...built.events);
    sequence = built.next;
    range.end = sequence - 1;
    ranges.set(entry.step, range);
  }
  const step = stepRecord(origin, ranges, sequence);
  return {
    browser: {
      mode: "launch",
      process_ownership: "provider-owned",
      cleanup: "terminated-owned-process",
      product: "Chromium",
      version: "149.0",
    },
    scenario: {
      start_origin: origin,
      action_count: 3,
      secret_references: [],
      network_content: {
        request_body: true,
        response_body: true,
        header_values: false,
      },
      event_families: ["network"],
      limits: LIMITS,
    },
    duration_ms: 160,
    steps: [
      step({
        index: 0,
        id: "scenario_start",
        action: "scenario_start",
        before: "/",
        after: "/",
      }),
      step({
        index: 1,
        id: "open-invoices",
        action: "click",
        before: "/",
        after: "/invoices",
      }),
      step({
        index: 2,
        id: "create-invoice",
        action: "click",
        before: "/invoices",
        after: "/invoices/17",
      }),
      step({
        index: 3,
        id: "open-help",
        action: "click",
        before: "/invoices/17",
        after: "/help",
        history: ["/", "/invoices", "/invoices/17", "/help"],
      }),
    ],
    events: {
      retained: events.length,
      dropped: 0,
      items: events,
      omissions: {
        by_kind: [],
        network_transactions: [],
        network_transaction_range: null,
      },
    },
    completeness: COMPLETE,
    limitations: [],
  };
}

/** The same traffic as an api-surface view of a HAR with one record per transaction. */
export function buildSurfaceApiSurface(origin = SURFACE_ORIGIN) {
  const group = (entry) => ({
    method: entry.method,
    origin: entry.origin ?? origin,
    path_template: entry.template,
    templated_segments: entry.segments ?? [],
    record_ordinals: entry.ordinals,
    statuses: [entry.status],
    content_types: [entry.type ?? "application/json"],
    flags: entry.ordinals.length === 1 ? ["single-sample"] : [],
  });
  const groups = [
    {
      method: "GET",
      template: "/api/customers/{numeric}",
      ordinals: [1, 2],
      status: 200,
      segments: [
        {
          segment_index: 2,
          rule: "numeric",
          basis: "inferred",
          observed_values: ["42", "43"],
        },
      ],
    },
    { method: "GET", template: "/api/invoices", ordinals: [0], status: 200 },
    { method: "POST", template: "/api/invoices", ordinals: [6], status: 201 },
    {
      method: "POST",
      template: "/api/invoices/archive",
      ordinals: [8],
      status: 204,
    },
    {
      method: "GET",
      template: "/api/reports/stream",
      ordinals: [4],
      status: 200,
      type: "text/event-stream",
    },
    {
      method: "GET",
      template: "/assets/logo.png",
      ordinals: [3],
      status: 200,
      type: "image/png",
    },
    { method: "POST", template: "/graphql", ordinals: [7], status: 200 },
    {
      method: "GET",
      template: "/trpc/user.byId,user.list",
      ordinals: [5],
      status: 200,
    },
    {
      method: "GET",
      origin: CDN_ORIGIN,
      template: "/lib.json",
      ordinals: [9],
      status: 200,
    },
  ].map(group);
  return {
    kind: "api-surface",
    view: { kind: "api-surface", offset: 0, limit: 50 },
    parent_evidence_id: `ev_${"5".repeat(64)}`,
    parent_operation: "inspect_web_network_capture",
    parent_digest: "5".repeat(64),
    artifact: { path: "captures/reference.har", sha256: "6".repeat(64) },
    records: { examined: 10, total: 10, excluded: 0 },
    coverage: {
      status: "page",
      examined: groups.length,
      total: groups.length,
      next_offset: null,
      exhausted: true,
    },
    groups,
    templated_groups: 1,
    excluded_records: [],
    limitations: [
      "Groups describe recorded request lines; HAR bodies were not decoded.",
    ],
    unknowns: [],
  };
}

/** Declared reference origin and the directional pair onto a local replacement. */
export function surfaceOrigins() {
  return {
    declared_origins: [SURFACE_ORIGIN],
    origin_pairs: [
      {
        before_origin: SURFACE_ORIGIN,
        after_origin: SURFACE_REPLACEMENT_ORIGIN,
      },
    ],
  };
}

/** Every generated fixture the generator writes and checks, as [relative path, text]. */
export function surfaceFixtureFiles() {
  return [
    ["api-surface.json", serializeFixture(buildSurfaceApiSurface())],
    ["scenario-capture.json", serializeFixture(buildSurfaceCapture())],
    ["origins.json", serializeFixture(surfaceOrigins())],
    [
      "profile.json",
      readFileSync(
        new URL("../fixtures/saas-profiles/generic.json", import.meta.url),
        "utf8",
      ),
    ],
  ];
}
