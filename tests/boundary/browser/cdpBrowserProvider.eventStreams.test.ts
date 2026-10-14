import { expect, it } from "vitest";

import { CdpBrowserProvider } from "../../../src/browser/CdpBrowserProvider.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import { EVENT_STREAM_SHAPE_LIMITS } from "../../../src/domain/eventStreamShape.js";
import { webPageInspectionSchema } from "../../../src/domain/browserObservationSchemas.js";
import {
  startFakeCdpBrowser,
  type FakeCdpBrowser,
  type FakeOptions,
} from "../../fixtures/fakeCdpBrowser.js";
import type { FakeCdpCommand } from "../../fixtures/fakeCdpBrowserTypes.js";
import {
  eventSourceMessage as message,
  streamRequestEvents as requestEvents,
  type FakeStreamRequest,
} from "../../fixtures/fakeCdpEventStreams.js";
import { trackBrowser } from "./cdpBrowserProvider.support.js";

const inspect = async (
  browser: FakeCdpBrowser,
  options: Readonly<Record<string, unknown>> = {},
) => {
  const result = await new CdpBrowserProvider().inspectPage(
    inspectWebPageInputSchema.parse({
      cdp_endpoint: browser.endpoint,
      allowed_origins: [browser.allowedOrigin],
      target_id: "allowed-page",
      observation_ms: 20,
      include_event_stream_shapes: true,
      ...options,
    }),
  );
  if (!result.ok) throw result.error;
  return webPageInspectionSchema.parse(result.value);
};

const bodyReads = (browser: FakeCdpBrowser): unknown[] =>
  browser.commands
    .filter(({ method }) => method === "Network.getResponseBody")
    .map(({ params }) => params.requestId);

const requestById = (
  inspection: Awaited<ReturnType<typeof inspect>>,
  requestId: string,
) =>
  inspection.network.requests.find(
    (request) => request.request_id === requestId,
  );

const SSE_BODY = [
  ": stream-comment-secret",
  "retry: 987654321",
  "id: event-id-secret",
  'data: {"choices":[{"delta":{"content":"data-secret"}}],',
  'data: "model":"model-secret"}',
  "",
  "event: done",
  "data: [DONE-secret]",
  "",
  'data: {"partial":"tail-secret"',
].join("\r");

const BODIES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  sse: { body: SSE_BODY, base64Encoded: false },
  ndjson: {
    body: Buffer.from(
      '{"token":"ndjson-secret","n":1}\n{"token":"x","n":2}\nnot-json-secret\n',
    ).toString("base64"),
    base64Encoded: true,
  },
  seq: {
    body: '\u001e{"seq":"seq-secret"}\n\u001e{"seq":1}\n',
    base64Encoded: false,
  },
  "closed-source": {
    body: "data: one\n\ndata: two\n\n",
    base64Encoded: false,
  },
  malformed: { body: 42, base64Encoded: false },
};

const responseBody = (command: FakeCdpCommand) =>
  command.method === "Network.getResponseBody"
    ? BODIES[String(command.params.requestId)]
    : undefined;

it("summarizes completed SSE, NDJSON, and JSON-sequence bodies without values", async () => {
  const browser = await startFakeCdpBrowser({
    eventsBeforeReply: ["Network.enable"],
    commandEvents: (command, origin) =>
      command.method === "Network.enable"
        ? [
            {
              requestId: "sse",
              path: "/chat",
              mimeType: "text/event-stream; charset=utf-8",
            },
            {
              requestId: "ndjson",
              path: "/rows",
              mimeType: "application/x-ndjson",
            },
            {
              requestId: "seq",
              path: "/seq",
              mimeType: "application/json-seq",
            },
            {
              requestId: "json",
              path: "/data",
              mimeType: "application/json",
            },
            { requestId: "plain", path: "/text", mimeType: "text/plain" },
          ].flatMap((request) => requestEvents(command, origin, request))
        : undefined,
    commandResult: responseBody,
  });
  trackBrowser(browser);
  const inspection = await inspect(browser);

  expect(requestById(inspection, "sse")?.event_stream).toEqual({
    format: "sse",
    completed_body: {
      status: "included",
      events_dispatched: 2,
      comment_lines: 1,
      ignored_field_lines: 0,
      retry_fields: 1,
      trailing_partial_event: true,
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
          count: 1,
          last_event_id_present: 1,
          data: {
            json: 1,
            text: 0,
            empty: 0,
            json_shape: expect.objectContaining({
              root_types: ["object"],
              properties: expect.arrayContaining([
                expect.objectContaining({
                  path: [
                    { kind: "property", name: "choices" },
                    { kind: "array-element" },
                    { kind: "property", name: "delta" },
                    { kind: "property", name: "content" },
                  ],
                  types: ["string"],
                }),
              ]),
            }),
          },
        },
      ],
    },
    event_source_messages: null,
  });
  expect(requestById(inspection, "ndjson")?.event_stream).toEqual({
    format: "ndjson",
    completed_body: {
      status: "included",
      records: 2,
      invalid_records: 1,
      shape_nodes_omitted: 0,
      json_shape: expect.objectContaining({
        properties: [
          expect.objectContaining({ types: ["number"], observations: 2 }),
          expect.objectContaining({ types: ["string"], observations: 2 }),
        ],
      }),
    },
  });
  expect(requestById(inspection, "seq")?.event_stream).toMatchObject({
    format: "json-seq",
    completed_body: { status: "included", records: 2, invalid_records: 0 },
  });
  expect(requestById(inspection, "json")).not.toHaveProperty("event_stream");
  expect(requestById(inspection, "plain")).not.toHaveProperty("event_stream");
  expect(bodyReads(browser)).toEqual(["sse", "ndjson", "seq"]);
  expect(inspection.completeness.unavailable_sections).not.toContain(
    "event_stream_shapes",
  );
  const serialized = JSON.stringify(inspection);
  for (const secret of [
    "stream-comment-secret",
    "987654321",
    "event-id-secret",
    "data-secret",
    "model-secret",
    "DONE-secret",
    "tail-secret",
    "ndjson-secret",
    "not-json-secret",
    "seq-secret",
  ])
    expect(serialized).not.toContain(secret);
});

const LIVE_REQUESTS: readonly FakeStreamRequest[] = [
  {
    requestId: "fetch-open",
    path: "/stream",
    mimeType: "text/event-stream",
    finished: false,
  },
  {
    requestId: "open-source",
    path: "/events",
    mimeType: "text/event-stream",
    type: "EventSource",
    finished: false,
  },
  {
    requestId: "closed-source",
    path: "/closed",
    mimeType: "text/event-stream",
    type: "EventSource",
  },
  {
    requestId: "json",
    path: "/data",
    mimeType: "application/json",
  },
  {
    requestId: "foreign",
    path: "/events",
    mimeType: "text/event-stream",
    type: "EventSource",
    finished: false,
    origin: "https://foreign.example.test",
  },
];

const LIVE_MESSAGES: readonly Readonly<Record<string, unknown>>[] = [
  {
    requestId: "open-source",
    eventName: "message",
    eventId: "",
    data: '{"text":"message-secret"}',
  },
  {
    requestId: "open-source",
    eventName: "message",
    eventId: "",
    data: '{"text":"second-secret","done":true}',
  },
  {
    requestId: "open-source",
    eventName: "status",
    eventId: "last-id-secret",
    data: "status-secret",
  },
  {
    requestId: "closed-source",
    eventName: "message",
    eventId: "",
    data: "one",
  },
  {
    requestId: "closed-source",
    eventName: "message",
    eventId: "",
    data: "two",
  },
  // Excluded-origin request: ignored without a protocol exclusion.
  {
    requestId: "foreign",
    eventName: "foreign-name-secret",
    eventId: "",
    data: "foreign-secret",
  },
  // Malformed (no data) and non-SSE messages are protocol exclusions.
  {
    requestId: "open-source",
    eventName: "message",
    eventId: "",
  },
  {
    requestId: "json",
    eventName: "message",
    eventId: "",
    data: "json-secret",
  },
];

const liveStreamEvents: FakeOptions["commandEvents"] = (command, origin) =>
  command.method === "Network.enable"
    ? [
        ...LIVE_REQUESTS.flatMap((request) =>
          requestEvents(command, origin, request),
        ),
        ...LIVE_MESSAGES.map((params) => message(command, params)),
      ]
    : undefined;

it("keeps open streams unavailable and reports EventSource messages as a separate source", async () => {
  const browser = await startFakeCdpBrowser({
    eventsBeforeReply: ["Network.enable"],
    commandEvents: liveStreamEvents,
    commandResult: responseBody,
  });
  trackBrowser(browser);
  const inspection = await inspect(browser);

  expect(requestById(inspection, "fetch-open")?.event_stream).toEqual({
    format: "sse",
    completed_body: { status: "unavailable", reason: "response-unfinished" },
    event_source_messages: null,
  });
  expect(requestById(inspection, "open-source")?.event_stream).toEqual({
    format: "sse",
    completed_body: { status: "unavailable", reason: "response-unfinished" },
    event_source_messages: {
      messages: 3,
      events_omitted: 0,
      shape_nodes_omitted: 0,
      events: [
        {
          name: "message",
          count: 2,
          cdp_event_id_present: 0,
          data: {
            json: 2,
            text: 0,
            empty: 0,
            json_shape: {
              root_types: ["object"],
              node_count: 5,
              max_depth_observed: 1,
              properties: [
                {
                  path: [{ kind: "property", name: "done" }],
                  types: ["boolean"],
                  observations: 1,
                },
                {
                  path: [{ kind: "property", name: "text" }],
                  types: ["string"],
                  observations: 2,
                },
              ],
            },
          },
        },
        {
          name: "status",
          count: 1,
          cdp_event_id_present: 1,
          data: { json: 0, text: 1, empty: 0, json_shape: null },
        },
      ],
    },
  });
  // Both sources observed the same two events; they are reported, not summed.
  expect(requestById(inspection, "closed-source")?.event_stream).toMatchObject({
    completed_body: { status: "included", events_dispatched: 2 },
    event_source_messages: { messages: 2 },
  });
  expect(requestById(inspection, "foreign")).toBeUndefined();
  expect(bodyReads(browser)).toEqual(["closed-source"]);
  expect(inspection.completeness.unavailable_sections).toContain(
    "event_stream_shapes",
  );
  expect(inspection.completeness.excluded).toContainEqual({
    section: "event_stream_shapes",
    reason: "invalid_protocol_value",
    count: 2,
  });
  const serialized = JSON.stringify(inspection);
  for (const secret of [
    "message-secret",
    "second-secret",
    "last-id-secret",
    "status-secret",
    "foreign-name-secret",
    "foreign-secret",
    "json-secret",
  ])
    expect(serialized).not.toContain(secret);
});

it("reports rejected, malformed, and late stream body reads per request", async () => {
  const browser = await startFakeCdpBrowser({
    eventsBeforeReply: ["Network.enable"],
    commandEvents: (command, origin) => {
      if (command.method === "Network.enable")
        return [
          {
            requestId: "rejected",
            path: "/rejected",
            mimeType: "text/event-stream",
          },
          {
            requestId: "malformed",
            path: "/malformed",
            mimeType: "application/jsonl",
          },
        ].flatMap((request) => requestEvents(command, origin, request));
      if (
        command.method === "Network.getResponseBody" &&
        command.params.requestId === "malformed"
      )
        return [
          { requestId: "late", path: "/late", mimeType: "text/event-stream" },
          {
            requestId: "late-open",
            path: "/late-open",
            mimeType: "application/x-ndjson",
            finished: false,
          },
        ].flatMap((request) => requestEvents(command, origin, request));
      return undefined;
    },
    commandError: (command) =>
      command.method === "Network.getResponseBody" &&
      command.params.requestId === "rejected"
        ? {
            code: -32_000,
            message: "No data found for resource with given identifier",
          }
        : undefined,
    commandResult: responseBody,
  });
  trackBrowser(browser);
  const inspection = await inspect(browser);

  expect(
    Object.fromEntries(
      inspection.network.requests.map((request) => [
        request.request_id,
        request.event_stream?.completed_body,
      ]),
    ),
  ).toEqual({
    rejected: { status: "unavailable", reason: "body-read-failed" },
    malformed: { status: "unavailable", reason: "body-read-failed" },
    late: { status: "unavailable", reason: "capture-ended" },
    "late-open": { status: "unavailable", reason: "response-unfinished" },
  });
  expect(inspection.limitations).toContainEqual(
    expect.stringContaining(
      "rejected: CDP Network.getResponseBody failed (-32000): No data found",
    ),
  );
  expect(inspection.completeness.excluded).toEqual(
    expect.arrayContaining([
      {
        section: "event_stream_shapes",
        reason: "invalid_protocol_value",
        count: 1,
      },
      {
        section: "event_stream_shapes",
        reason: "provider_unavailable",
        count: null,
      },
    ]),
  );
});

it("leaves output and protocol commands unchanged when the option is not selected", async () => {
  const options: FakeOptions = {
    eventsBeforeReply: ["Network.enable"],
    commandEvents: (command, origin) =>
      command.method === "Network.enable"
        ? [
            ...[
              {
                requestId: "sse",
                path: "/chat",
                mimeType: "text/event-stream",
              },
              {
                requestId: "source",
                path: "/events",
                mimeType: "text/event-stream",
                type: "EventSource",
                finished: false,
              },
              {
                requestId: "json",
                path: "/data",
                mimeType: "application/json",
              },
            ].flatMap((request) => requestEvents(command, origin, request)),
            message(command, {
              requestId: "source",
              eventName: "message",
              eventId: "1",
              data: "unselected-secret",
            }),
            message(command, { requestId: "source" }),
          ]
        : undefined,
    commandResult: (command) =>
      command.method === "Network.getResponseBody"
        ? { body: '{"ok":true}', base64Encoded: false }
        : undefined,
  };
  const unselected = await startFakeCdpBrowser(options);
  trackBrowser(unselected);
  const defaulted = await inspect(unselected, {
    include_event_stream_shapes: false,
    include_json_body_shapes: true,
  });

  const serialized = JSON.stringify(defaulted);
  expect(serialized).not.toContain("event_stream");
  expect(serialized).not.toContain("unselected-secret");
  expect(bodyReads(unselected)).toEqual(["json"]);
  expect(requestById(defaulted, "json")?.body_shapes.status).toBe("included");
});

it("bounds distinct event names per source and marks event-stream shapes truncated", async () => {
  const limit = EVENT_STREAM_SHAPE_LIMITS.eventNames;
  const chunks = Array.from(
    { length: limit + 3 },
    (_, index) => `event: chunk-${String(index)}\ndata: {"n":1}\n\n`,
  ).join("");
  const browser = await startFakeCdpBrowser({
    eventsBeforeReply: ["Network.enable"],
    commandEvents: (command, origin) =>
      command.method === "Network.enable"
        ? [
            ...requestEvents(command, origin, {
              requestId: "many-names",
              path: "/many",
              mimeType: "text/event-stream",
            }),
            ...requestEvents(command, origin, {
              requestId: "many-messages",
              path: "/feed",
              mimeType: "text/event-stream",
              type: "EventSource",
              finished: false,
            }),
            ...Array.from({ length: limit + 2 }, (_, index) =>
              message(command, {
                requestId: "many-messages",
                eventName: `update-${String(index)}`,
                eventId: "",
                data: "{}",
              }),
            ),
          ]
        : undefined,
    commandResult: (command) =>
      command.method === "Network.getResponseBody"
        ? { body: chunks, base64Encoded: false }
        : undefined,
  });
  trackBrowser(browser);
  const inspection = await inspect(browser);

  const body = requestById(inspection, "many-names")?.event_stream;
  expect(body?.completed_body).toMatchObject({
    status: "included",
    events_dispatched: limit + 3,
    events_omitted: 3,
    shape_nodes_omitted: 0,
  });
  expect(
    body?.completed_body.status === "included" &&
      "events" in body.completed_body
      ? body.completed_body.events.length
      : undefined,
  ).toBe(limit);
  const source = requestById(inspection, "many-messages")?.event_stream;
  expect(
    source !== undefined && "event_source_messages" in source
      ? source.event_source_messages
      : undefined,
  ).toMatchObject({ messages: limit + 2, events_omitted: 2 });
  expect(inspection.completeness.truncated_sections).toContain(
    "event_stream_shapes",
  );
  expect(inspection.completeness.excluded).toContainEqual({
    section: "event_stream_shapes",
    reason: "resource_budget_exhausted",
    count: null,
  });
});
