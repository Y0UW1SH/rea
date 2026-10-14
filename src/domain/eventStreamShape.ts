import { z } from "zod";

import {
  JsonShapeAccumulator,
  mergedJsonShapeSchema,
  type JsonShapePathBudget,
} from "./jsonShape.js";
import { isJsonText } from "./jsonTextSyntax.js";
import { mediaTypeEssence } from "./mediaTypeEssence.js";
import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";

/** Streamed HTTP response framings whose events can be summarized. */
const eventStreamFormatSchema = z.enum(["sse", "ndjson", "json-seq"]);
export type EventStreamFormat = z.infer<typeof eventStreamFormatSchema>;

/**
 * Per-source representation bounds. Server-chosen event names and JSON
 * property names (for example per-chunk names or ID-keyed objects) otherwise
 * grow the summary with the body or session instead of with its structure.
 * Events and shape nodes beyond these bounds are counted, not retained.
 */
export const EVENT_STREAM_SHAPE_LIMITS = {
  eventNames: 1_000,
  shapePaths: 10_000,
} as const;

const countSchema = z.number().int().min(0);

/** Value-free classification of one event name's `data` payloads. */
const eventStreamDataSchema = z.object({
  json: countSchema,
  text: countSchema,
  empty: countSchema,
  json_shape: mergedJsonShapeSchema.nullable(),
});

/** Dispatched events sharing one name; values, IDs, and examples are discarded. */
const sseBodyEventSchema = z.object({
  name: z.string(),
  count: z.number().int().min(1),
  last_event_id_present: countSchema.describe(
    "Dispatched events whose WHATWG last event ID buffer was non-empty",
  ),
  data: eventStreamDataSchema,
});

/** Delivered EventSource messages sharing one name, as CDP reported them. */
const eventSourceMessageEventSchema = z.object({
  name: z.string(),
  count: z.number().int().min(1),
  cdp_event_id_present: countSchema.describe(
    "Messages whose CDP eventId was non-empty; Chrome 155 reported the persisting last event ID, other versions are unverified",
  ),
  data: eventStreamDataSchema,
});

const omissionFields = {
  events_omitted: countSchema.describe(
    "Events not summarized because the per-source event-name bound was reached",
  ),
  shape_nodes_omitted: countSchema.describe(
    "JSON nodes not retained because the per-source shape-path bound was reached",
  ),
};

/** WHATWG event-stream interpretation of one completed response body. */
export const sseBodySummarySchema = z.object({
  events_dispatched: countSchema,
  comment_lines: countSchema,
  ignored_field_lines: countSchema.describe(
    "Unknown fields, ids containing NULL, and empty or non-digit retry values",
  ),
  retry_fields: countSchema,
  trailing_partial_event: z
    .boolean()
    .describe("The body ended inside an undispatched event block"),
  ...omissionFields,
  events: z.array(sseBodyEventSchema),
});
export type SseBodySummary = z.infer<typeof sseBodySummarySchema>;

/** Newline-delimited JSON or RFC 7464 JSON text sequence body summary. */
export const jsonRecordStreamSummarySchema = z.object({
  records: countSchema,
  invalid_records: countSchema,
  shape_nodes_omitted: omissionFields.shape_nodes_omitted,
  json_shape: mergedJsonShapeSchema.nullable(),
});
export type JsonRecordStreamSummary = z.infer<
  typeof jsonRecordStreamSummarySchema
>;

/** EventSource messages delivered by the browser while the request was open. */
export const eventSourceMessagesSummarySchema = z.object({
  messages: countSchema,
  ...omissionFields,
  events: z.array(eventSourceMessageEventSchema),
});
type EventSourceMessagesSummary = z.infer<
  typeof eventSourceMessagesSummarySchema
>;

/** Classify a response media type as a supported streaming framing. */
export const eventStreamFormatForMediaType = (
  value: string | null | undefined,
): EventStreamFormat | undefined => {
  const essence =
    value === null || value === undefined ? null : mediaTypeEssence(value);
  switch (essence) {
    case "text/event-stream":
      return "sse";
    case "application/x-ndjson":
    case "application/jsonl":
    case "application/jsonlines":
    case "application/x-jsonlines":
      return "ndjson";
    case "application/json-seq":
      return "json-seq";
    default:
      return essence?.endsWith("+json-seq") === true ? "json-seq" : undefined;
  }
};

interface EventNameState {
  count: number;
  idPresent: number;
  json: number;
  text: number;
  empty: number;
  readonly shape: JsonShapeAccumulator;
}

interface EventSummary {
  readonly name: string;
  readonly count: number;
  readonly idPresent: number;
  readonly data: z.infer<typeof eventStreamDataSchema>;
}

/**
 * Merge dispatched events by name, keeping counts and value-free data shapes
 * within EVENT_STREAM_SHAPE_LIMITS; all names share one shape-path budget.
 */
export class EventStreamEventAccumulator {
  readonly #events = new Map<string, EventNameState>();
  readonly #budget: JsonShapePathBudget = {
    remainingPaths: EVENT_STREAM_SHAPE_LIMITS.shapePaths,
    omittedNodes: 0,
  };
  #total = 0;
  #eventsOmitted = 0;

  get total(): number {
    return this.#total;
  }

  get eventsOmitted(): number {
    return this.#eventsOmitted;
  }

  get shapeNodesOmitted(): number {
    return this.#budget.omittedNodes;
  }

  add(name: string, idPresent: boolean, data: string): void {
    this.#total += 1;
    let state = this.#events.get(name);
    if (state === undefined) {
      if (this.#events.size >= EVENT_STREAM_SHAPE_LIMITS.eventNames) {
        this.#eventsOmitted += 1;
        return;
      }
      state = {
        count: 0,
        idPresent: 0,
        json: 0,
        text: 0,
        empty: 0,
        shape: new JsonShapeAccumulator(this.#budget),
      };
      this.#events.set(name, state);
    }
    state.count += 1;
    if (idPresent) state.idPresent += 1;
    if (data === "") state.empty += 1;
    // Validating first avoids a thrown SyntaxError per non-JSON payload.
    else if (isJsonText(data) && state.shape.add(data)) state.json += 1;
    else state.text += 1;
  }

  snapshot(): EventSummary[] {
    return [...this.#events]
      .sort(([left], [right]) => compareUnicodeCodePoints(left, right))
      .map(([name, state]) => ({
        name,
        count: state.count,
        idPresent: state.idPresent,
        data: {
          json: state.json,
          text: state.text,
          empty: state.empty,
          json_shape: state.shape.snapshot(),
        },
      }));
  }
}

/** Project delivered EventSource messages with their CDP-specific ID field. */
export const summarizeEventSourceMessages = (
  messages: EventStreamEventAccumulator,
): EventSourceMessagesSummary => ({
  messages: messages.total,
  events_omitted: messages.eventsOmitted,
  shape_nodes_omitted: messages.shapeNodesOmitted,
  events: messages.snapshot().map(({ name, count, idPresent, data }) => ({
    name,
    count,
    cdp_event_id_present: idPresent,
    data,
  })),
});

const BYTE_ORDER_MARK = 0xfe_ff;
const LINE_FEED = 0x0a;
const COLON = 0x3a;
const SPACE = 0x20;
const ASCII_DIGITS = /^[0-9]+$/u;
/** Data lines joined per chunk, so one event never holds a string per line. */
const DATA_LINES_PER_CHUNK = 1_024;

/**
 * Interpret a completed `text/event-stream` body with the WHATWG HTML event
 * stream rules. Field values are inspected only to classify them and are never
 * retained; only the last event ID's presence survives between events.
 */
export const summarizeServerSentEvents = (body: string): SseBodySummary => {
  const events = new EventStreamEventAccumulator();
  let commentLines = 0;
  let ignoredFieldLines = 0;
  let retryFields = 0;
  let eventType = "";
  // One event's data buffer: joined chunks plus the lines not yet joined.
  let dataChunks: string[] = [];
  let dataLines: string[] = [];
  let lastEventIdPresent = false;
  let blockPending = false;

  const dispatch = (): void => {
    blockPending = false;
    if (dataLines.length > 0) dataChunks.push(dataLines.join("\n"));
    if (dataChunks.length > 0)
      events.add(
        eventType === "" ? "message" : eventType,
        lastEventIdPresent,
        dataChunks.join("\n"),
      );
    dataChunks = [];
    dataLines = [];
    eventType = "";
  };

  const processLine = (line: string): void => {
    if (line === "") {
      dispatch();
      return;
    }
    if (line.charCodeAt(0) === COLON) {
      commentLines += 1;
      return;
    }
    blockPending = true;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.charCodeAt(0) === SPACE) value = value.slice(1);
    switch (field) {
      case "event":
        eventType = value;
        return;
      case "data":
        dataLines.push(value);
        if (dataLines.length === DATA_LINES_PER_CHUNK) {
          dataChunks.push(dataLines.join("\n"));
          dataLines = [];
        }
        return;
      case "id":
        if (value.includes("\0")) ignoredFieldLines += 1;
        else lastEventIdPresent = value !== "";
        return;
      case "retry":
        if (ASCII_DIGITS.test(value)) retryFields += 1;
        else ignoredFieldLines += 1;
        return;
      default:
        ignoredFieldLines += 1;
    }
  };

  let position = body.charCodeAt(0) === BYTE_ORDER_MARK ? 1 : 0;
  // Cache both terminator positions so bodies with one kind of line end
  // remain a single linear scan.
  let carriageReturn = body.indexOf("\r", position);
  let lineFeed = body.indexOf("\n", position);
  while (position < body.length) {
    if (carriageReturn >= 0 && carriageReturn < position)
      carriageReturn = body.indexOf("\r", position);
    if (lineFeed >= 0 && lineFeed < position)
      lineFeed = body.indexOf("\n", position);
    if (carriageReturn < 0 && lineFeed < 0) {
      // A final line without a terminator was never delivered as a line.
      const partial = body.slice(position);
      if (partial.charCodeAt(0) !== COLON) blockPending = true;
      break;
    }
    const carriageReturnFirst =
      carriageReturn >= 0 && (lineFeed < 0 || carriageReturn < lineFeed);
    const end = carriageReturnFirst ? carriageReturn : lineFeed;
    processLine(body.slice(position, end));
    position =
      carriageReturnFirst && body.charCodeAt(end + 1) === LINE_FEED
        ? end + 2
        : end + 1;
  }
  return {
    events_dispatched: events.total,
    comment_lines: commentLines,
    ignored_field_lines: ignoredFieldLines,
    retry_fields: retryFields,
    trailing_partial_event: blockPending,
    events_omitted: events.eventsOmitted,
    shape_nodes_omitted: events.shapeNodesOmitted,
    events: events.snapshot().map(({ name, count, idPresent, data }) => ({
      name,
      count,
      last_event_id_present: idPresent,
      data,
    })),
  };
};

const RECORD_SEPARATOR = "\u001e";
const LINE_FEED_TEXT = "\n";
const JSON_WHITESPACE_ONLY = /^[\t\n\r ]*$/u;
const SELF_DELIMITED_JSON_START = /^[\t\n\r ]*["[{]/u;
const JSON_WHITESPACE_END = /[\t\n\r ]$/u;

/**
 * Merge record shapes from a completed NDJSON/JSON Lines body or RFC 7464 JSON
 * text sequence within the per-source shape-path bound. Records are scanned in
 * place, one at a time; blank lines and empty sequence elements are skipped.
 */
export const summarizeJsonRecordStream = (
  format: Exclude<EventStreamFormat, "sse">,
  body: string,
): JsonRecordStreamSummary => {
  const budget: JsonShapePathBudget = {
    remainingPaths: EVENT_STREAM_SHAPE_LIMITS.shapePaths,
    omittedNodes: 0,
  };
  const shape = new JsonShapeAccumulator(budget);
  let records = 0;
  let invalidRecords = 0;
  const separator = format === "ndjson" ? LINE_FEED_TEXT : RECORD_SEPARATOR;
  let position = body.charCodeAt(0) === BYTE_ORDER_MARK ? 1 : 0;
  let leading = format === "json-seq";
  while (position <= body.length) {
    const found = body.indexOf(separator, position);
    const end = found < 0 ? body.length : found;
    const record = body.slice(position, end);
    position = end + 1;
    if (JSON_WHITESPACE_ONLY.test(record)) {
      leading = false;
      continue;
    }
    if (leading) {
      // Content before the first RS is not a sequence element.
      leading = false;
      invalidRecords += 1;
    } else if (
      format === "json-seq" &&
      !SELF_DELIMITED_JSON_START.test(record) &&
      !JSON_WHITESPACE_END.test(record)
    )
      // RFC 7464 section 2.4: a top-level number, true, false, or null without
      // trailing whitespace may be truncated and is not accepted.
      invalidRecords += 1;
    else if (isJsonText(record) && shape.add(record)) records += 1;
    else invalidRecords += 1;
  }
  return {
    records,
    invalid_records: invalidRecords,
    shape_nodes_omitted: budget.omittedNodes,
    json_shape: shape.snapshot(),
  };
};
