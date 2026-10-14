import type { BrowserEventStream } from "../domain/browserObservationSchemas.js";
import {
  EventStreamEventAccumulator,
  eventStreamFormatForMediaType,
  summarizeEventSourceMessages,
  summarizeJsonRecordStream,
  summarizeServerSentEvents,
  type EventStreamFormat,
} from "../domain/eventStreamShape.js";
import type { NetworkState } from "./CdpCaptureEventTypes.js";

type SseCompletedBody = Extract<
  BrowserEventStream,
  { readonly format: "sse" }
>["completed_body"];
type JsonRecordCompletedBody = Extract<
  BrowserEventStream,
  { readonly format: "ndjson" }
>["completed_body"];
export type EventStreamBodyUnavailableReason = Extract<
  SseCompletedBody,
  { readonly status: "unavailable" }
>["reason"];

type CompletedBody =
  | { readonly format: "sse"; readonly body: SseCompletedBody }
  | {
      readonly format: Exclude<EventStreamFormat, "sse">;
      readonly body: JsonRecordCompletedBody;
    };

interface RequestStreams {
  readonly occurrence: number;
  completed: CompletedBody | undefined;
  readonly messages: EventStreamEventAccumulator;
}

/**
 * Owns event-stream facts for one capture. Completed bodies and delivered
 * EventSource messages are separate sources keyed by request occurrence, so a
 * reused request ID never inherits facts from an earlier redirect hop.
 */
export class CdpEventStreamCapture {
  readonly #requests = new Map<string, RequestStreams>();

  clear(): void {
    this.#requests.clear();
  }

  /**
   * Parse a completed body in memory and retain only its value-free summary.
   * Returns whether the per-source representation bounds omitted anything.
   */
  ingestBody(
    requestId: string,
    occurrence: number,
    format: EventStreamFormat,
    text: string,
  ): boolean {
    if (format === "sse") {
      const summary = summarizeServerSentEvents(text);
      this.#current(requestId, occurrence).completed = {
        format,
        body: { status: "included", ...summary },
      };
      return summary.events_omitted > 0 || summary.shape_nodes_omitted > 0;
    }
    const summary = summarizeJsonRecordStream(format, text);
    this.#current(requestId, occurrence).completed = {
      format,
      body: { status: "included", ...summary },
    };
    return summary.shape_nodes_omitted > 0;
  }

  bodyUnavailable(
    requestId: string,
    occurrence: number,
    format: EventStreamFormat,
    reason: EventStreamBodyUnavailableReason,
  ): void {
    const body = { status: "unavailable", reason } as const;
    // Each branch narrows `format` to one member of the discriminated union.
    this.#current(requestId, occurrence).completed =
      format === "sse" ? { format, body } : { format, body };
  }

  /**
   * Record one browser-delivered EventSource message without its values.
   * Returns whether this message was partly or wholly omitted by the bounds.
   */
  recordMessage(
    requestId: string,
    occurrence: number,
    name: string,
    cdpEventIdPresent: boolean,
    data: string,
  ): boolean {
    const { messages } = this.#current(requestId, occurrence);
    const omittedBefore = messages.eventsOmitted + messages.shapeNodesOmitted;
    messages.add(name, cdpEventIdPresent, data);
    return messages.eventsOmitted + messages.shapeNodesOmitted > omittedBefore;
  }

  /** Project selected stream facts for one retained request, if it is a stream. */
  project(
    request: NetworkState,
    occurrence: number | undefined,
  ): BrowserEventStream | undefined {
    const format = eventStreamFormatForMediaType(request.mime_type);
    if (format === undefined) return undefined;
    const entry = this.#requests.get(request.request_id);
    const current = entry?.occurrence === occurrence ? entry : undefined;
    // Every eligible body is settled before projection; an unsettled one was
    // still unread when capture ended.
    const unread = { status: "unavailable", reason: "capture-ended" } as const;
    const completed = current?.completed;
    if (format === "sse") {
      const messages = current?.messages ?? new EventStreamEventAccumulator();
      return {
        format,
        completed_body: completed?.format === "sse" ? completed.body : unread,
        event_source_messages:
          request.resource_type === "EventSource" || messages.total > 0
            ? summarizeEventSourceMessages(messages)
            : null,
      };
    }
    return {
      format,
      completed_body:
        completed !== undefined && completed.format !== "sse"
          ? completed.body
          : unread,
    };
  }

  #current(requestId: string, occurrence: number): RequestStreams {
    const existing = this.#requests.get(requestId);
    if (existing?.occurrence === occurrence) return existing;
    const created: RequestStreams = {
      occurrence,
      completed: undefined,
      messages: new EventStreamEventAccumulator(),
    };
    this.#requests.set(requestId, created);
    return created;
  }
}
