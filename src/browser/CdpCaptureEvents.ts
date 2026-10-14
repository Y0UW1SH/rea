import type { InspectWebPageInput } from "../domain/browserObservation.js";
import type { WebPageInspection } from "../domain/browserObservationSchemas.js";
import {
  eventStreamFormatForMediaType,
  type EventStreamFormat,
} from "../domain/eventStreamShape.js";
import type { CdpEvent } from "./CdpConnection.js";
import { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";
import * as bodyShapes from "./CdpCaptureEventBodyShapes.js";
import {
  CdpEventStreamCapture,
  type EventStreamBodyUnavailableReason,
} from "./CdpCaptureEventStreams.js";
import type { CdpCaptureEventsState } from "./CdpCaptureEventState.js";
import type { CapturedScript, NetworkState } from "./CdpCaptureEventTypes.js";
import * as handlers from "./CdpCaptureEventHandlers.js";
import { isJsonMediaType, responseBodyText } from "./CdpCaptureEventHelpers.js";
import {
  cdpStringValue,
  recordValue,
  type UnknownRecord,
} from "./CdpCaptureValues.js";

export interface ResponseBodyCandidate {
  readonly requestId: string;
  readonly occurrence: number;
}

/** Event accumulator that validates and normalizes payloads at ingestion. */
export class CdpCaptureEvents implements CdpCaptureEventsState {
  #scriptMetadataBudgetExclusionsRecorded = false;
  readonly #networkRequestOccurrences = new Map<string, number>();
  readonly #responseBodyExaminedOccurrences = new Map<string, number>();
  readonly #eventStreams = new CdpEventStreamCapture();
  readonly scripts = new Map<string, CapturedScript>();
  readonly scriptMetadataBudgetOmissionsById = new Map<string, true>();
  rejectedScriptMetadataBudgetCount = 0;
  rejectedSourceMapMetadataBudgetCount = 0;
  readonly scriptMetadataBytesById = new Map<string, number>();
  retainedScriptMetadataBytes = 0;
  readonly executionContextFrames = new Map<string, string>();
  readonly network = new Map<string, NetworkState>();
  readonly networkRequestTimestamps = new Map<string, number>();
  readonly malformedRedirectRequestIds = new Set<string>();
  readonly webSocketConnectionsById = new Map<
    string,
    WebPageInspection["network"]["websocket_connections"][number]
  >();
  console: WebPageInspection["console"]["events"] = [];
  responseMetadata: WebPageInspection["metadata"]["responses"] = [];
  agentHints: WebPageInspection["metadata"]["agent_hints"] = [];
  readonly completeness = new CdpCaptureCompleteness([
    "network_requests",
    "console_events",
    "websocket_connections",
    "websocket_frames",
    "metadata",
  ]);
  originViolation = false;
  navigationDuringCapture = false;
  mainFrameId: string | undefined = undefined;
  committedDocument: string | undefined = undefined;

  readonly input: InspectWebPageInput;
  readonly allowedOrigins: ReadonlySet<string>;

  constructor(input: InspectWebPageInput, allowedOrigins: ReadonlySet<string>) {
    this.input = input;
    this.allowedOrigins = allowedOrigins;
  }

  beginAuthorizedFrame(frameId: string): void {
    this.mainFrameId = frameId;
    this.originViolation = false;
    this.navigationDuringCapture = false;
    this.committedDocument = undefined;
    this.scripts.clear();
    this.scriptMetadataBudgetOmissionsById.clear();
    this.rejectedScriptMetadataBudgetCount = 0;
    this.rejectedSourceMapMetadataBudgetCount = 0;
    this.scriptMetadataBytesById.clear();
    this.retainedScriptMetadataBytes = 0;
    this.#scriptMetadataBudgetExclusionsRecorded = false;
    this.executionContextFrames.clear();
    this.network.clear();
    this.networkRequestTimestamps.clear();
    this.#networkRequestOccurrences.clear();
    this.#responseBodyExaminedOccurrences.clear();
    this.#eventStreams.clear();
    this.malformedRedirectRequestIds.clear();
    this.webSocketConnectionsById.clear();
    this.console.length = 0;
    this.responseMetadata.length = 0;
    this.agentHints.length = 0;
    this.completeness.reset();
    if (!this.input.include_console_text)
      this.completeness.exclude("console_text", "not_approved", null);
    if (!this.input.include_json_body_shapes)
      this.completeness.exclude("json_body_shapes", "not_approved", null);
    if (!this.input.include_websocket_shapes)
      this.completeness.exclude("websocket_shapes", "not_approved", null);
  }

  beginFinalCapture(frameId: string): void {
    this.mainFrameId = frameId;
    // Deliberately does not clear `navigationDuringCapture`. A main-frame
    // navigation observed during the observation window means the page never
    // settled, and clearing the flag here reported the capture as clean while
    // carrying pre-navigation scripts, network and console into the inventory
    // of the new document. The caller now reports `target_changed` instead.
    // `committedDocument` is dropped so the new document's frame events are
    // compared against itself rather than the document we just left.
    this.committedDocument = undefined;
  }

  /** Record final script metadata omissions after all scriptParsed replacements. */
  recordScriptMetadataBudgetExclusions(): void {
    if (this.#scriptMetadataBudgetExclusionsRecorded) return;
    this.#scriptMetadataBudgetExclusionsRecorded = true;
    const omittedScripts = this.rejectedScriptMetadataBudgetCount;
    const omittedSourceMaps =
      this.rejectedSourceMapMetadataBudgetCount +
      this.scriptMetadataBudgetOmissionsById.size;
    if (omittedScripts > 0)
      this.completeness.exclude(
        "scripts",
        "resource_budget_exhausted",
        omittedScripts,
      );
    if (omittedSourceMaps > 0)
      this.completeness.exclude(
        "source_maps",
        "resource_budget_exhausted",
        omittedSourceMaps,
      );
  }

  ingest(event: CdpEvent): void {
    const params = recordValue(event.params);
    if (params === undefined) return;
    switch (event.method) {
      case "Runtime.executionContextCreated":
        handlers.handleExecutionContextCreated(this, params);
        break;
      case "Runtime.executionContextDestroyed":
        handlers.handleExecutionContextDestroyed(this, params);
        break;
      case "Runtime.executionContextsCleared":
        this.executionContextFrames.clear();
        break;
      case "Debugger.scriptParsed":
        handlers.handleScriptParsed(this, params);
        break;
      case "Network.requestWillBeSent": {
        const requestId = cdpStringValue(params.requestId);
        const previous =
          requestId === undefined ? undefined : this.network.get(requestId);
        handlers.handleRequestWillBeSent(this, params);
        if (requestId !== undefined && this.network.get(requestId) !== previous)
          this.#networkRequestOccurrences.set(
            requestId,
            (this.#networkRequestOccurrences.get(requestId) ?? 0) + 1,
          );
        break;
      }
      case "Network.responseReceived":
        handlers.handleResponseReceived(this, params);
        break;
      case "Network.loadingFinished":
        handlers.handleLoadingFinished(this, params);
        break;
      case "Runtime.consoleAPICalled":
        handlers.handleConsoleAPICalled(this, params);
        break;
      case "Page.frameNavigated":
        handlers.handleFrameNavigated(this, params);
        break;
      case "Network.webSocketCreated":
        handlers.handleWebSocketCreated(this, params);
        break;
      case "Network.webSocketFrameSent":
        handlers.handleWebSocketFrame(this, params, "sent");
        break;
      case "Network.webSocketFrameReceived":
        handlers.handleWebSocketFrame(this, params, "received");
        break;
      case "Network.eventSourceMessageReceived":
        this.#ingestEventSourceMessage(params);
        break;
    }
  }

  /** Retained requests, with selected event-stream facts projected per source. */
  networkRequests(): NetworkState[] {
    const requests = [...this.network.values()];
    if (!this.input.include_event_stream_shapes) return requests;
    return requests.map((request) => {
      if (this.malformedRedirectRequestIds.has(request.request_id))
        return request;
      const eventStream = this.#eventStreams.project(
        request,
        this.#networkRequestOccurrences.get(request.request_id),
      );
      return eventStream === undefined
        ? request
        : { ...request, event_stream: eventStream };
    });
  }

  /** Summarize one browser-delivered EventSource message for an admitted request. */
  #ingestEventSourceMessage(params: UnknownRecord): void {
    if (!this.input.include_event_stream_shapes) return;
    const requestId = cdpStringValue(params.requestId);
    const eventName = cdpStringValue(params.eventName);
    const eventId = cdpStringValue(params.eventId);
    const data = cdpStringValue(params.data);
    if (
      requestId === undefined ||
      eventName === undefined ||
      eventId === undefined ||
      data === undefined
    ) {
      this.completeness.exclude(
        "event_stream_shapes",
        "invalid_protocol_value",
      );
      return;
    }
    if (this.malformedRedirectRequestIds.has(requestId)) return;
    const request = this.network.get(requestId);
    const occurrence = this.#networkRequestOccurrences.get(requestId);
    // Requests outside the selected origins were already excluded and counted.
    if (request === undefined || occurrence === undefined) return;
    if (eventStreamFormatForMediaType(request.mime_type) !== "sse") {
      this.completeness.exclude(
        "event_stream_shapes",
        "invalid_protocol_value",
      );
      return;
    }
    // CDP eventId is reported per message; Chrome 155 sends the persisting
    // last event ID, but this source keeps its own field name and meaning.
    const truncated = this.#eventStreams.recordMessage(
      requestId,
      occurrence,
      eventName === "" ? "message" : eventName,
      eventId !== "",
      data,
    );
    if (truncated)
      this.completeness.exclude(
        "event_stream_shapes",
        "resource_budget_exhausted",
        null,
      );
  }

  /** Resolve a transient execution context to one already authorized frame. */
  frameForScript(
    script: CapturedScript,
    allowedFrameIds: ReadonlySet<string>,
  ): string | null {
    return script.frameId !== null && allowedFrameIds.has(script.frameId)
      ? script.frameId
      : null;
  }

  /** Selected response-body interpretation for one request's media type. */
  #selectedBodyFormat(
    request: NetworkState,
  ): "json" | EventStreamFormat | undefined {
    if (
      this.input.include_json_body_shapes &&
      isJsonMediaType(request.mime_type)
    )
      return "json";
    return this.input.include_event_stream_shapes
      ? eventStreamFormatForMediaType(request.mime_type)
      : undefined;
  }

  responseBodyRequests(): readonly ResponseBodyCandidate[] {
    if (
      !this.input.include_json_body_shapes &&
      !this.input.include_event_stream_shapes
    )
      return [];
    return [...this.network.values()]
      .filter(
        (request) => !this.malformedRedirectRequestIds.has(request.request_id),
      )
      .filter((request) => this.#selectedBodyFormat(request) !== undefined)
      .flatMap((request) => {
        const occurrence = this.#networkRequestOccurrences.get(
          request.request_id,
        );
        return occurrence === undefined
          ? []
          : [{ requestId: request.request_id, occurrence }];
      });
  }

  currentResponseBodyRequest(
    candidate: ResponseBodyCandidate,
  ): NetworkState | undefined {
    if (
      candidate.occurrence !==
      this.#networkRequestOccurrences.get(candidate.requestId)
    )
      return undefined;
    return this.network.get(candidate.requestId);
  }

  responseBodyUnavailable(
    candidate: ResponseBodyCandidate,
    reason: EventStreamBodyUnavailableReason,
  ): void {
    const request = this.currentResponseBodyRequest(candidate);
    if (request === undefined) return;
    this.#responseBodyExaminedOccurrences.set(
      candidate.requestId,
      candidate.occurrence,
    );
    if (this.malformedRedirectRequestIds.has(candidate.requestId)) return;
    const format = this.#selectedBodyFormat(request);
    if (format === "json" || format === undefined) {
      bodyShapes.updateResponseBodyShape(this, candidate.requestId, null);
      this.completeness.unavailable("json_body_shapes");
      return;
    }
    this.#eventStreams.bodyUnavailable(
      candidate.requestId,
      candidate.occurrence,
      format,
      reason,
    );
    this.completeness.unavailable("event_stream_shapes");
  }

  /**
   * Mark eligible response bodies that arrived after the fetch pass was
   * enumerated.
   */
  settleUnexaminedResponseBodies(): void {
    for (const candidate of this.responseBodyRequests()) {
      const request = this.currentResponseBodyRequest(candidate);
      if (
        request !== undefined &&
        (this.#selectedBodyFormat(request) !== "json" ||
          request.body_shapes.response === null) &&
        this.#responseBodyExaminedOccurrences.get(candidate.requestId) !==
          candidate.occurrence
      )
        this.responseBodyUnavailable(
          candidate,
          request.encoded_data_length === null
            ? "response-unfinished"
            : "capture-ended",
        );
    }
  }

  ingestResponseBody(candidate: ResponseBodyCandidate, value: unknown): void {
    const request = this.currentResponseBodyRequest(candidate);
    if (request === undefined) return;
    this.#responseBodyExaminedOccurrences.set(
      candidate.requestId,
      candidate.occurrence,
    );
    if (this.malformedRedirectRequestIds.has(candidate.requestId)) return;
    const format = this.#selectedBodyFormat(request);
    if (format === "json" || format === undefined) {
      bodyShapes.ingestResponseBodyShape(this, candidate.requestId, value);
      return;
    }
    const text = responseBodyText(value);
    if (text === undefined) {
      this.#eventStreams.bodyUnavailable(
        candidate.requestId,
        candidate.occurrence,
        format,
        "body-read-failed",
      );
      this.completeness.exclude(
        "event_stream_shapes",
        "invalid_protocol_value",
      );
      return;
    }
    // The reply was admitted under the CDP protocol message budget. Base64
    // decoding makes transient copies proportional to that reply; bodies are
    // read one at a time and only the value-free summary outlives this call.
    if (
      this.#eventStreams.ingestBody(
        candidate.requestId,
        candidate.occurrence,
        format,
        text,
      )
    )
      this.completeness.exclude(
        "event_stream_shapes",
        "resource_budget_exhausted",
        null,
      );
  }
}
