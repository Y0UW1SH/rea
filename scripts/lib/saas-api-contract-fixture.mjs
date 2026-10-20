import { createHash } from "node:crypto";

// Deterministic synthetic capture_browser_scenario results for the API contract
// companion. The shapes mirror the vitest fixture builders in
// src/domain/browserScenarioDiff.test.ts and must parse with browserScenarioCaptureSchema;
// tests/boundary/cli/saasApiContract.test.ts checks that. Nothing here is vendor data.

export const CONTRACT_FIXTURE_VARIANTS = [
  "reference-a",
  "reference-b",
  "replacement",
  "replacement-drifted",
];

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

const variantProfile = (variant) => {
  const replacement = variant.startsWith("replacement");
  const second = variant === "reference-b";
  return {
    origin: replacement ? "http://localhost:4300" : "https://app.example.test",
    drifted: variant === "replacement-drifted",
    invoice: second ? 9820 : replacement ? 4100 : 9810,
    customer: second ? 6733 : replacement ? 7001 : 6732,
    other: second ? 6740 : replacement ? 7002 : 6735,
    status: second ? "paid" : "open",
    issued: second ? "2026-10-05" : "2026-10-01",
    total: second ? "250.00" : "100.00",
  };
};

const bytesOf = (text) => Buffer.from(text, "utf8");
const captured = (text, representation, mediaType) => {
  const bytes = bytesOf(text);
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
    { name: "x-trace-id", value: "trace-SENTINEL-VALUE-1", redacted: false },
    { name: "authorization", value: null, redacted: true },
  ],
};
const responseHeaders = {
  state: "captured",
  items: [{ name: "content-type", value: "application/json", redacted: false }],
};

/** Build one transaction's events; `body` entries are prepared content artifacts. */
function transaction(sequence, step, id, method, target, options) {
  const base = {
    step_index: step,
    transaction_id: id,
    redirected_from_transaction_id: null,
    method,
    url: target,
    resource_type: options.resource_type ?? "fetch",
    header_names: ["accept", "x-trace-id", "authorization"],
    failure: null,
  };
  const events = [];
  let next = sequence;
  const requestSequence = next;
  events.push({
    ...base,
    sequence: next++,
    kind: "request",
    redirected_from_transaction_state: "root",
    status: null,
  });
  if (options.request !== undefined)
    events.push({
      sequence: next++,
      step_index: step,
      kind: "network-content",
      transaction_id: id,
      phase: "request",
      source_event_sequence: requestSequence,
      headers: requestHeaders,
      body: options.request,
    });
  const responseSequence = next;
  events.push({
    ...base,
    sequence: next++,
    kind: "response",
    redirected_from_transaction_state: "root",
    status: options.status,
  });
  events.push({
    sequence: next++,
    step_index: step,
    kind: "network-content",
    transaction_id: id,
    phase: "response",
    source_event_sequence: responseSequence,
    headers: responseHeaders,
    body: options.response,
  });
  events.push({
    ...base,
    sequence: next++,
    kind: "request-finished",
    redirected_from_transaction_state: "root",
    status: null,
  });
  return { events, next };
}

const invoice = (profile, id, number) => ({
  id,
  number: `INV-${number}`,
  customer: { id: profile.customer, name: "Customer A" },
  total: profile.drifted ? 25 : profile.total,
  status: profile.status,
  issued_on: profile.issued,
});
const customer = (profile, id, name) => {
  const value = {
    id,
    name,
    created_at: "2026-01-02T03:04:05.000Z",
    tags: ["vip"],
    balance: "60.00",
  };
  if (!profile.drifted)
    value.email = `${name.toLowerCase().replace(" ", ".")}@example.test`;
  return value;
};

/** One deterministic capture per variant. */
export function buildContractFixture(variant) {
  if (!CONTRACT_FIXTURE_VARIANTS.includes(variant))
    throw new Error(`unknown fixture variant ${variant}`);
  const profile = variantProfile(variant);
  const { origin } = profile;
  const events = [];
  let sequence = 1;
  const add = (step, id, method, target, options) => {
    const built = transaction(sequence, step, id, method, target, options);
    events.push(...built.events);
    sequence = built.next;
  };
  const stepOneStart = sequence;
  add(1, "t1", "GET", url(origin, "/api/invoices?page=1", ["page"]), {
    status: 200,
    response: jsonResponse(
      JSON.stringify([
        invoice(profile, profile.invoice, 1),
        invoice(profile, profile.invoice + 1, 2),
        invoice(profile, profile.invoice + 2, 3),
      ]),
    ),
  });
  add(1, "t2", "GET", url(origin, `/api/customers/${profile.customer}`), {
    status: 200,
    response: jsonResponse(
      JSON.stringify(customer(profile, profile.customer, "Customer A")),
    ),
  });
  add(1, "t3", "GET", url(origin, `/api/customers/${profile.other}`), {
    status: 200,
    response: jsonResponse(
      JSON.stringify(customer(profile, profile.other, "Customer B")),
    ),
  });
  add(1, "t4", "GET", url(origin, "/assets/logo.png"), {
    status: 200,
    response: captured("PNG", "playwright-response-body-bytes", "image/png"),
  });
  add(1, "t5", "GET", url("https://cdn.example.test", "/lib.json"), {
    status: 200,
    response: jsonResponse('{"cdn":true}'),
  });
  add(1, "t6", "GET", url(origin, `/api/reports/${profile.issued}`), {
    status: 200,
    response: {
      state: "unavailable",
      reason: "body-size-limit",
      message: "Response body exceeded the retained size limit",
      limit_bytes: 65_536,
      observed_bytes: 90_000,
    },
  });
  const stepOneEnd = sequence - 1;
  const stepTwoStart = sequence;
  add(2, "t7", "POST", url(origin, "/api/invoices"), {
    status: 201,
    request: jsonRequest({
      customer_id: profile.customer,
      lines: [{ sku: "W-1", quantity: 2, unit_price: "12.50" }],
      notes: null,
    }),
    response: jsonResponse(
      JSON.stringify({
        id: profile.invoice + 3,
        number: "INV-4",
        total: profile.drifted ? 25 : "25.00",
        status: "open",
      }),
    ),
  });
  add(2, "t8", "POST", url(origin, "/graphql"), {
    status: 200,
    request: jsonRequest({
      query:
        "query ListCustomers($first: Int) { customers(first: $first) { id name } }",
      operationName: "ListCustomers",
      variables: { first: 10 },
    }),
    response: jsonResponse(
      JSON.stringify({
        data: {
          customers: [{ id: String(profile.customer), name: "Customer A" }],
        },
      }),
    ),
  });
  add(2, "t9", "GET", url(origin, `/api/invoices/${profile.invoice + 3}`), {
    status: 200,
    response: jsonResponse(
      JSON.stringify(invoice(profile, profile.invoice + 3, 4)),
    ),
  });
  add(2, "t10", "GET", url(origin, "/api/invoices/999999"), {
    status: profile.drifted ? 500 : 404,
    response: jsonResponse(
      profile.drifted ? '{"error":"internal"}' : '{"error":"not_found"}',
    ),
  });
  if (profile.drifted)
    add(2, "t11", "GET", url(origin, "/api/unknown"), {
      status: 200,
      response: jsonResponse('{"ok":true}'),
    });
  const stepTwoEnd = sequence - 1;
  const page = (path) => url(origin, path);
  const step = (index, id, action, before, after, start, end) => ({
    step_index: index,
    step_id: id,
    action,
    status: "completed",
    error: null,
    elapsed_ms: index * 40,
    before_url: before,
    after_url: after,
    event_sequence_start: start,
    event_sequence_end: end,
    artifacts: {
      screenshot: NOT_REQUESTED,
      dom: NOT_REQUESTED,
      accessibility: NOT_REQUESTED,
      url: { state: "captured", value: after },
      history: NOT_REQUESTED,
      storage: NOT_REQUESTED,
    },
    completeness: COMPLETE,
  });
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
      action_count: 2,
      secret_references: [],
      network_content: {
        request_body: true,
        response_body: true,
        header_values: true,
      },
      event_families: ["network"],
      limits: LIMITS,
    },
    duration_ms: 120,
    steps: [
      step(0, "scenario_start", "scenario_start", page("/"), page("/"), 1, 0),
      step(
        1,
        "open-invoices",
        "click",
        page("/"),
        page("/invoices"),
        stepOneStart,
        stepOneEnd,
      ),
      step(
        2,
        "create-invoice",
        "click",
        page("/invoices"),
        page("/invoices/new"),
        stepTwoStart,
        stepTwoEnd,
      ),
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

/** The committed manifest that infers a contract from both reference captures. */
export function contractFixtureManifest() {
  return {
    version: 1,
    name: "synthetic-invoice-api",
    captures: [{ file: "reference-a.json" }, { file: "reference-b.json" }],
    resource_types: ["fetch", "xhr"],
    options: {
      required_min_samples: 3,
      enum_max_cardinality: 8,
      enum_min_samples: 5,
      format_min_samples: 2,
    },
    limits: {
      maxBytes: 4 * 1024 * 1024,
      maxTransactions: 1000,
      maxBodyBytes: 65_536,
      maxSchemaNodes: 20_000,
      maxEvidencePerOperation: 100,
    },
  };
}

// Committed fixtures must satisfy the repository formatter: objects stay expanded, and
// scalar arrays collapse onto one line when they fit the 80-column print width.
const PRINT_WIDTH = 80;
const isScalar = (value) => value === null || typeof value !== "object";
function formatJson(value, indent, prefixLength) {
  if (isScalar(value)) return JSON.stringify(value);
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every(isScalar)) {
      const inline = `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
      if (indent.length + prefixLength + inline.length <= PRINT_WIDTH)
        return inline;
    }
    const items = value.map((item) => `${inner}${formatJson(item, inner, 1)}`);
    return `[\n${items.join(",\n")}\n${indent}]`;
  }
  const keys = Object.keys(value);
  if (keys.length === 0) return "{}";
  const members = keys.map((key) => {
    const prefix = `${JSON.stringify(key)}: `;
    return `${inner}${prefix}${formatJson(value[key], inner, prefix.length + 1)}`;
  });
  return `{\n${members.join(",\n")}\n${indent}}`;
}

/** Serialized exactly as the committed fixture files are stored. */
export const serializeFixture = (value) => `${formatJson(value, "", 0)}\n`;
