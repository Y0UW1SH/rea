import { describe, expect, it } from "vitest";

import {
  EVENT_STREAM_SHAPE_LIMITS,
  EventStreamEventAccumulator,
  eventSourceMessagesSummarySchema,
  summarizeEventSourceMessages,
  eventStreamFormatForMediaType,
  jsonRecordStreamSummarySchema,
  sseBodySummarySchema,
  summarizeJsonRecordStream,
  summarizeServerSentEvents,
} from "./eventStreamShape.js";

const property = (name: string) => ({ kind: "property" as const, name });

const sse = (body: string) =>
  sseBodySummarySchema.parse(summarizeServerSentEvents(body));

const records = (format: "ndjson" | "json-seq", body: string) =>
  jsonRecordStreamSummarySchema.parse(summarizeJsonRecordStream(format, body));

describe("eventStreamFormatForMediaType", () => {
  it("classifies event-stream and JSON record media types with parameters and case", () => {
    expect(eventStreamFormatForMediaType("text/event-stream")).toBe("sse");
    expect(
      eventStreamFormatForMediaType(" Text/Event-Stream ; charset=utf-8"),
    ).toBe("sse");
    expect(eventStreamFormatForMediaType("application/x-ndjson")).toBe(
      "ndjson",
    );
    for (const value of [
      "application/jsonl",
      "application/jsonlines",
      "Application/X-JSONLines; charset=utf-8",
    ])
      expect(eventStreamFormatForMediaType(value), value).toBe("ndjson");
    expect(eventStreamFormatForMediaType("application/json-seq")).toBe(
      "json-seq",
    );
    expect(eventStreamFormatForMediaType("application/geo+json-seq")).toBe(
      "json-seq",
    );
    for (const value of [
      null,
      undefined,
      "",
      "application/json",
      "application/ld+json",
      "text/plain",
      "text/event-streams",
      "text/event stream",
      "text/event-stream extra",
      " text/event-stream",
    ])
      expect(eventStreamFormatForMediaType(value), String(value)).toBe(
        undefined,
      );
  });
});

describe("summarizeServerSentEvents", () => {
  it("dispatches WHATWG events by name without retaining data, id, retry, or comment values", () => {
    const summary = sse(
      [
        ": comment-secret",
        "retry: 3000",
        "id: id-secret",
        'data: {"choices":[{"delta":"data-secret"}],',
        'data: "index":0}',
        "",
        "event: done",
        "data: [DONE-secret]",
        "",
        "event: message",
        "id",
        'data: {"choices":[],"usage":{"tokens":3}}',
        "",
        "unknown-field-secret: value-secret",
        "event: ping",
        "",
        "data:",
        "",
        "",
      ].join("\n"),
    );

    expect(summary).toEqual({
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
          count: 3,
          last_event_id_present: 1,
          data: {
            json: 2,
            text: 0,
            empty: 1,
            json_shape: {
              root_types: ["object"],
              node_count: 9,
              max_depth_observed: 3,
              properties: [
                {
                  path: [property("choices")],
                  types: ["array"],
                  observations: 2,
                },
                {
                  path: [property("choices"), { kind: "array-element" }],
                  types: ["object"],
                  observations: 1,
                },
                {
                  path: [
                    property("choices"),
                    { kind: "array-element" },
                    property("delta"),
                  ],
                  types: ["string"],
                  observations: 1,
                },
                {
                  path: [property("index")],
                  types: ["number"],
                  observations: 1,
                },
                {
                  path: [property("usage")],
                  types: ["object"],
                  observations: 1,
                },
                {
                  path: [property("usage"), property("tokens")],
                  types: ["number"],
                  observations: 1,
                },
              ],
            },
          },
        },
      ],
    });
    expect(JSON.stringify(summary)).not.toMatch(/secret|3000/u);
  });
});

describe("summarizeServerSentEvents framing and field rules", () => {
  it("treats CR, LF, and CRLF as equivalent line ends", () => {
    const lines = [
      "event: update",
      'data: {"a":1}',
      "data: second-line",
      "",
      "id: 7",
      "data: x",
      "",
    ];
    const expected = sse(lines.join("\n") + "\n");
    expect(expected.events_dispatched).toBe(2);
    expect(sse(lines.join("\r") + "\r")).toEqual(expected);
    expect(sse(lines.join("\r\n") + "\r\n")).toEqual(expected);
    expect(
      sse(
        'event: update\r\ndata: {"a":1}\rdata: second-line\n\r\nid: 7\rdata: x\n\n',
      ),
    ).toEqual(expected);
  });

  it("strips exactly one leading byte order mark", () => {
    expect(sse("﻿data: x\n\n").events).toEqual([
      expect.objectContaining({ name: "message", count: 1 }),
    ]);
    expect(sse("﻿﻿data: x\n\n")).toMatchObject({
      events_dispatched: 0,
      ignored_field_lines: 1,
      events: [],
    });
  });

  it("parses fields without a colon and removes only one leading space", () => {
    expect(sse("data\n\n").events).toEqual([
      expect.objectContaining({
        name: "message",
        data: { json: 0, text: 0, empty: 1, json_shape: null },
      }),
    ]);
    expect(sse("event\ndata: 1\n\n").events[0]?.name).toBe("message");
    expect(sse("data: \n\n").events[0]?.data).toMatchObject({
      empty: 1,
      text: 0,
    });
    expect(sse("data:  \n\n").events[0]?.data).toMatchObject({
      empty: 0,
      text: 1,
    });
    expect(sse("data:{}\n\n").events[0]?.data).toMatchObject({ json: 1 });
  });

  it("ignores ids containing NULL, invalid retry values, and unknown fields", () => {
    expect(
      sse(
        [
          "id: before\0after",
          "retry: 10s",
          "retry:",
          "retry: 1500",
          "Data: wrong-case",
          "data: x",
          "",
          "",
        ].join("\n"),
      ),
    ).toEqual({
      events_dispatched: 1,
      comment_lines: 0,
      ignored_field_lines: 4,
      retry_fields: 1,
      trailing_partial_event: false,
      events_omitted: 0,
      shape_nodes_omitted: 0,
      events: [
        {
          name: "message",
          count: 1,
          last_event_id_present: 0,
          data: { json: 0, text: 1, empty: 0, json_shape: null },
        },
      ],
    });
  });

  it("keeps the last event ID across events until an empty id resets it", () => {
    expect(
      sse("id: 1\ndata: a\n\ndata: b\n\nid\ndata: c\n\nid: \ndata: d\n\n")
        .events,
    ).toEqual([
      expect.objectContaining({
        name: "message",
        count: 4,
        last_event_id_present: 2,
      }),
    ]);
  });

  it("does not dispatch blocks without data", () => {
    expect(
      sse("event: ping\n\nid: 3\n\nretry: 10\n\n: keepalive\n\n"),
    ).toMatchObject({
      events_dispatched: 0,
      comment_lines: 1,
      retry_fields: 1,
      trailing_partial_event: false,
      events_omitted: 0,
      shape_nodes_omitted: 0,
      events: [],
    });
  });

  it("reports an undispatched trailing event instead of counting it", () => {
    for (const body of [
      "data: a\n\ndata: b",
      "data: a\n\ndata: b\n",
      "data: a\n\nevent: next\n",
      'data: a\n\ndata: {"truncated":',
    ])
      expect(sse(body), JSON.stringify(body)).toMatchObject({
        events_dispatched: 1,
        trailing_partial_event: true,
        events: [expect.objectContaining({ count: 1 })],
      });
    for (const body of ["", "data: a\n\n", "data: a\n\n: keepalive"])
      expect(sse(body).trailing_partial_event, JSON.stringify(body)).toBe(
        false,
      );
  });

  it("orders event names by code point and keeps them verbatim", () => {
    expect(
      sse(
        "event: é\ndata: 1\n\nevent: Z\ndata: 1\n\nevent: a b\ndata: 1\n\n",
      ).events.map(({ name }) => name),
    ).toEqual(["Z", "a b", "é"]);
  });

  it("parses large bodies with distant line ends in linear passes", () => {
    const body = `data: ${"x".repeat(2_000_000)}\n\n`.repeat(4);
    expect(sse(body)).toMatchObject({
      events_dispatched: 4,
      events: [expect.objectContaining({ count: 4 })],
    });
  });
});

describe("summarizeServerSentEvents data buffer", () => {
  it("joins data lines across internal chunk boundaries exactly", () => {
    for (const lines of [1_023, 1_024, 1_025, 2_049]) {
      const body = `data: [\n${"data: 1,\n".repeat(lines)}data: 1]\n\n`;
      expect(sse(body).events, String(lines)).toEqual([
        expect.objectContaining({
          data: expect.objectContaining({
            json: 1,
            json_shape: expect.objectContaining({ node_count: lines + 2 }),
          }),
        }),
      ]);
    }
    expect(sse(`${"data:\n".repeat(2_048)}\n`).events[0]?.data).toMatchObject({
      text: 1,
      empty: 0,
    });
  });
});

describe("summarizeJsonRecordStream", () => {
  it("merges newline-delimited JSON records and counts invalid lines", () => {
    const summary = records(
      "ndjson",
      '﻿{"id":1,"token":"value-secret"}\r\n\n  \n{"id":"two"}\nnot-json-secret\n[1]',
    );
    expect(summary).toEqual({
      records: 3,
      invalid_records: 1,
      shape_nodes_omitted: 0,
      json_shape: {
        root_types: ["array", "object"],
        node_count: 7,
        max_depth_observed: 1,
        properties: [
          {
            path: [{ kind: "array-element" }],
            types: ["number"],
            observations: 1,
          },
          {
            path: [property("id")],
            types: ["number", "string"],
            observations: 2,
          },
          {
            path: [property("token")],
            types: ["string"],
            observations: 1,
          },
        ],
      },
    });
    expect(JSON.stringify(summary)).not.toMatch(/secret/u);
  });

  it("frames RFC 7464 sequences by RS and rejects possibly truncated scalars", () => {
    expect(
      records(
        "json-seq",
        'prefix-secret\u001e{"a":1}\n\u001e\u001e\u001e[true]\n\u001e42\n\u001e{"broken":\n\u001e"text"\u001enull',
      ),
    ).toEqual({
      records: 4,
      invalid_records: 3,
      shape_nodes_omitted: 0,
      json_shape: expect.objectContaining({
        root_types: ["array", "number", "object", "string"],
      }),
    });
    expect(records("json-seq", "")).toEqual({
      records: 0,
      invalid_records: 0,
      shape_nodes_omitted: 0,
      json_shape: null,
    });
  });
});

describe("summarizeEventSourceMessages", () => {
  it("summarizes delivered messages with the same per-name facts but a CDP-specific ID field", () => {
    const accumulator = new EventStreamEventAccumulator();
    accumulator.add("message", false, '{"a":1}');
    accumulator.add("message", true, "");
    accumulator.add("status", true, "ready-secret");
    const summary = eventSourceMessagesSummarySchema.parse(
      summarizeEventSourceMessages(accumulator),
    );

    expect(summary).toEqual({
      messages: 3,
      events_omitted: 0,
      shape_nodes_omitted: 0,
      events: [
        {
          name: "message",
          count: 2,
          cdp_event_id_present: 1,
          data: {
            json: 1,
            text: 0,
            empty: 1,
            json_shape: expect.objectContaining({ root_types: ["object"] }),
          },
        },
        {
          name: "status",
          count: 1,
          cdp_event_id_present: 1,
          data: { json: 0, text: 1, empty: 0, json_shape: null },
        },
      ],
    });
    expect(
      sse(
        'data: {"a":1}\n\nid: 1\ndata:\n\nevent: status\ndata: ready\n\n',
      ).events.map(({ last_event_id_present: idPresent, ...event }) => ({
        ...event,
        cdp_event_id_present: idPresent,
      })),
    ).toEqual(summary.events);
  });
});

describe("event-stream representation bounds", () => {
  it("counts events beyond the distinct event-name bound instead of retaining them", () => {
    const names = EVENT_STREAM_SHAPE_LIMITS.eventNames + 5;
    const summary = sse(
      Array.from(
        { length: names },
        (_, index) =>
          `event: chunk-${String(index)}\ndata: {"n":${String(index)}}\n\n`,
      ).join("") + "event: chunk-0\ndata: {}\n\n",
    );

    expect(summary.events_dispatched).toBe(names + 1);
    expect(summary.events).toHaveLength(EVENT_STREAM_SHAPE_LIMITS.eventNames);
    expect(summary.events_omitted).toBe(5);
    expect(summary.events.find(({ name }) => name === "chunk-0")?.count).toBe(
      2,
    );
    expect(summary.shape_nodes_omitted).toBe(0);
  });

  it("shares one shape-path bound across names and counts unretained JSON nodes", () => {
    const keys = EVENT_STREAM_SHAPE_LIMITS.shapePaths + 2;
    const keyed = (prefix: string) =>
      JSON.stringify(
        Object.fromEntries(
          Array.from({ length: keys }, (_, index) => [
            `${prefix}-${String(index)}`,
            { nested: index },
          ]),
        ),
      );
    const summary = sse(
      `event: a\ndata: ${keyed("a")}\n\nevent: b\ndata: ${keyed("b")}\n\n`,
    );
    const retained = summary.events.reduce(
      (total, { data }) => total + (data.json_shape?.properties.length ?? 0),
      0,
    );

    expect(retained).toBe(EVENT_STREAM_SHAPE_LIMITS.shapePaths);
    // Every unretained property node and its nested child are counted.
    expect(summary.shape_nodes_omitted).toBe(4 * keys - retained);
    expect(summary.events.map(({ data }) => data.json)).toEqual([1, 1]);
    const records = summarizeJsonRecordStream("ndjson", `${keyed("r")}\n`);
    expect(records.json_shape?.properties).toHaveLength(
      EVENT_STREAM_SHAPE_LIMITS.shapePaths,
    );
    expect(records.shape_nodes_omitted).toBe(
      2 * keys - EVENT_STREAM_SHAPE_LIMITS.shapePaths,
    );
  });
});
