import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { artifactCliEvidence, artifactMcpResult } from "./artifact-e2e.mjs";

// CR-only line ends, a comment, multi-line JSON data, a persisting id, retry,
// an ignored field, empty data, and named events.
const SSE_BODY = `${[
  ": sse-comment-secret",
  "retry: 4242424242",
  "id: sse-id-secret",
  'data: {"choices":[{"delta":{"content":"sse-content-secret"}}],',
  'data: "created":1}',
  "",
  "event: status",
  "data: sse-status-secret",
  "",
  "x-unknown: sse-unknown-secret",
  "data:",
  "",
  "event: done",
  "data: sse-done-secret",
  "",
].join("\r")}\r`;
const NDJSON_BODY =
  '{"id":1,"token":"ndjson-secret"}\n{"id":2}\nnot-json-ndjson-secret\n';
const SECRETS = [
  "sse-comment-secret",
  "4242424242",
  "sse-id-secret",
  "sse-content-secret",
  "sse-status-secret",
  "sse-unknown-secret",
  "sse-done-secret",
  "ndjson-secret",
  "es-id-secret",
  "es-data-secret",
  "es-keepalive-secret",
  "closed-secret",
  "open-stream-secret",
];
const property = (name) => ({ kind: "property", name });
const element = { kind: "array-element" };
const EXPECTED_SSE = {
  status: "included",
  events_dispatched: 4,
  comment_lines: 1,
  ignored_field_lines: 1,
  retry_fields: 1,
  trailing_partial_event: false,
  events_omitted: 0,
  shape_nodes_omitted: 0,
  events: [
    {
      name: "done",
      count: 1,
      last_event_id_present: 1,
      data: { json: 0, text: 1, empty: 0, json_shape: null },
    },
    {
      name: "message",
      count: 2,
      last_event_id_present: 2,
      data: {
        json: 1,
        text: 0,
        empty: 1,
        json_shape: {
          root_types: ["object"],
          node_count: 6,
          max_depth_observed: 4,
          properties: [
            { path: [property("choices")], types: ["array"], observations: 1 },
            {
              path: [property("choices"), element],
              types: ["object"],
              observations: 1,
            },
            {
              path: [property("choices"), element, property("delta")],
              types: ["object"],
              observations: 1,
            },
            {
              path: [
                property("choices"),
                element,
                property("delta"),
                property("content"),
              ],
              types: ["string"],
              observations: 1,
            },
            {
              path: [property("created")],
              types: ["number"],
              observations: 1,
            },
          ],
        },
      },
    },
    {
      name: "status",
      count: 1,
      last_event_id_present: 1,
      data: { json: 0, text: 1, empty: 0, json_shape: null },
    },
  ],
};
const EXPECTED_NDJSON = {
  status: "included",
  records: 2,
  invalid_records: 1,
  shape_nodes_omitted: 0,
  json_shape: {
    root_types: ["object"],
    node_count: 5,
    max_depth_observed: 1,
    properties: [
      { path: [property("id")], types: ["number"], observations: 2 },
      { path: [property("token")], types: ["string"], observations: 1 },
    ],
  },
};

// The page restarts its streams during the window because passive inspection
// observes only requests sent after attach. Earlier streams are aborted so
// HTTP/1.1 connection limits never stall the next cycle.
const PAGE = `<!doctype html><meta charset="utf-8"><script>
let open, source, closedSource;
const cycle = () => {
  open?.abort(); source?.close(); closedSource?.close();
  open = new AbortController();
  fetch("/sse").then((response) => response.text());
  fetch("/ndjson").then((response) => response.text());
  fetch("/open", { signal: open.signal })
    .then((response) => response.body.getReader().read())
    .catch(() => {});
  source = new EventSource("/events");
  closedSource = new EventSource("/events-closed");
};
cycle();
setInterval(cycle, 250);
fetch("/event-stream-ready");
</script>`;

/** Verify value-free SSE, NDJSON, and EventSource shapes from real Chrome through the public CLI and stdio MCP. */
export async function verifyBrowserEventStreamShapes(endpoint) {
  let pageReady = false;
  const timers = new Set();
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture.test").pathname;
    if (path === "/event-stream-fixture") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(PAGE);
    } else if (path === "/event-stream-ready") {
      pageReady = true;
      response.writeHead(204).end();
    } else if (path === "/sse") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(SSE_BODY);
    } else if (path === "/ndjson") {
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      response.end(NDJSON_BODY);
    } else if (path === "/open") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: open-stream-secret\n\n");
    } else if (path === "/events") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("retry: 600000\n\n");
      let sequence = 0;
      const timer = setInterval(() => {
        sequence += 1;
        response.write(
          sequence % 3 === 0
            ? ": es-keepalive-secret\n\n"
            : `event: update\nid: es-id-secret-${String(sequence)}\ndata: {"price":${String(sequence)},"note":"es-data-secret"}\n\n`,
        );
      }, 40);
      timers.add(timer);
      response.once("close", () => {
        clearInterval(timer);
        timers.delete(timer);
      });
    } else if (path === "/events-closed") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        'retry: 600000\n\nevent: final\ndata: {"closed":"closed-secret"}\n\nevent: final\ndata: closed-secret\n\n',
      );
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  let targetId;
  try {
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Event-stream fixture did not bind a TCP port");
    const origin = `http://127.0.0.1:${String(address.port)}`;
    const created = await fetch(
      `${endpoint}/json/new?${encodeURIComponent(`${origin}/event-stream-fixture`)}`,
      { method: "PUT" },
    );
    if (!created.ok)
      throw new Error(`Chrome target creation failed: HTTP ${created.status}`);
    const target = await created.json();
    if (typeof target.id !== "string" || target.id.length === 0)
      throw new Error("Chrome target creation returned no target ID");
    targetId = target.id;
    const deadline = Date.now() + 15_000;
    while (!pageReady && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    if (!pageReady)
      throw new Error("Chrome did not load the event-stream fixture");

    const cliArguments = [
      targetId,
      "--allowed-origins",
      origin,
      "--observation-ms",
      "1000",
    ];
    const selected = await artifactCliEvidence("inspect-web-page", endpoint, [
      ...cliArguments,
      "--include-event-stream-shapes",
    ]);
    assert.equal(selected.parameters.include_event_stream_shapes, true);
    const cliFacts = assertEventStreams(selected);
    const unselected = await artifactCliEvidence(
      "inspect-web-page",
      endpoint,
      cliArguments,
    );
    assert.equal("include_event_stream_shapes" in unselected.parameters, false);
    assert.equal(
      JSON.stringify(unselected.normalized_result).includes("event_stream"),
      false,
      "Unselected inspection reported event-stream facts",
    );
    assertNoSecrets(unselected);

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../rea.mjs", import.meta.url)), "mcp"],
      env: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent" },
      stderr: "pipe",
    });
    const client = new Client({
      name: "browser-event-stream-e2e",
      version: "1",
    });
    let mcpFacts;
    try {
      await client.connect(transport);
      mcpFacts = assertEventStreams({
        normalized_result: await artifactMcpResult(client, "inspect_web_page", {
          cdp_endpoint: endpoint,
          allowed_origins: [origin],
          target_id: targetId,
          observation_ms: 1000,
          include_event_stream_shapes: true,
        }),
      });
    } finally {
      try {
        await client.close();
      } finally {
        await transport.close();
      }
    }
    return {
      cli: cliFacts,
      mcp: mcpFacts,
      public_cli: true,
      public_stdio_mcp: true,
    };
  } finally {
    try {
      if (targetId !== undefined) {
        const closed = await fetch(
          `${endpoint}/json/close/${encodeURIComponent(targetId)}`,
        );
        if (!closed.ok)
          throw new Error(
            `Chrome fixture target cleanup failed: HTTP ${closed.status}`,
          );
      }
    } finally {
      for (const timer of timers) clearInterval(timer);
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
    }
  }
}

function assertEventStreams(evidence) {
  assertNoSecrets(evidence);
  const requests = evidence.normalized_result.network.requests;
  const byPath = (path) =>
    requests.filter((request) => new URL(request.url).pathname === path);
  const included = (path) =>
    byPath(path).filter(
      (request) => request.event_stream?.completed_body.status === "included",
    );
  const sse = included("/sse");
  assert.ok(sse.length > 0, "Real Chrome returned no completed SSE body");
  for (const request of sse)
    assert.deepEqual(request.event_stream, {
      format: "sse",
      completed_body: EXPECTED_SSE,
      event_source_messages: null,
    });
  const ndjson = included("/ndjson");
  assert.ok(ndjson.length > 0, "Real Chrome returned no completed NDJSON body");
  for (const request of ndjson)
    assert.deepEqual(request.event_stream, {
      format: "ndjson",
      completed_body: EXPECTED_NDJSON,
    });
  // A request whose response was not yet reported has no media type and is
  // deliberately left unclassified.
  const open = byPath("/open").filter((request) => request.mime_type !== null);
  assert.ok(open.length > 0, "Real Chrome reported no open fetch stream");
  for (const request of open)
    assert.deepEqual(
      request.event_stream,
      {
        format: "sse",
        completed_body: {
          status: "unavailable",
          reason: "response-unfinished",
        },
        event_source_messages: null,
      },
      describeRequest(request),
    );
  const sources = byPath("/events").filter(
    (request) =>
      (request.event_stream?.event_source_messages?.messages ?? 0) > 0,
  );
  assert.ok(
    sources.length > 0,
    "Real Chrome delivered no EventSource messages",
  );
  for (const request of sources) {
    const messages = request.event_stream.event_source_messages;
    assert.deepEqual(
      messages.events.map(({ name }) => name),
      ["update"],
    );
    const [update] = messages.events;
    assert.equal(update.count, messages.messages);
    assert.equal(update.cdp_event_id_present, update.count);
    assert.equal(update.data.json, update.count);
    assert.deepEqual(
      update.data.json_shape.properties.map(({ path }) => path),
      [[property("note")], [property("price")]],
    );
  }
  const closedSources = byPath("/events-closed").filter(
    (request) => request.mime_type !== null,
  );
  return {
    completed_sse_bodies: sse.length,
    completed_ndjson_bodies: ndjson.length,
    open_fetch_streams: open.length,
    eventsource_requests_with_messages: sources.length,
    eventsource_messages: sources.reduce(
      (total, request) =>
        total + request.event_stream.event_source_messages.messages,
      0,
    ),
    // Records, without asserting, how this Chrome answers getResponseBody for
    // EventSource requests whose response completed.
    closed_eventsource_bodies: closedSources.map((request) => ({
      completed_body:
        request.event_stream?.completed_body.status === "included"
          ? `included:${String(request.event_stream.completed_body.events_dispatched)}`
          : `${String(request.event_stream?.completed_body.status)}:${String(request.event_stream?.completed_body.reason)}`,
      messages: request.event_stream?.event_source_messages?.messages ?? null,
    })),
  };
}

const describeRequest = (request) =>
  `${request.url}: status=${String(request.status)} mime=${String(request.mime_type)} encoded=${String(request.encoded_data_length)}`;

function assertNoSecrets(evidence) {
  const serialized = JSON.stringify(evidence);
  for (const secret of SECRETS)
    assert.equal(
      serialized.includes(secret),
      false,
      `Event-stream inspection retained a payload value: ${secret}`,
    );
}
