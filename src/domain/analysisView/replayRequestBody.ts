import { parseExactJson } from "../exactJsonNumber.js";
import type { JsonValue } from "../jsonValue.js";
import type { WebNetworkCaptureRecord } from "../webNetworkCapture.js";
import { readRecordedRequestBody } from "./recordedExchangeBody.js";
import { isJson, mediaTypeEssence } from "./recordedMediaType.js";

/** Bound request parsing before allocation, shared by HAR and scenario replay. */
export const REPLAY_REQUEST_BODY_LIMIT_BYTES = 256 * 1024;

/** A recorded request body as strict replay can match it: known empty, exact JSON, or unknown. */
export type ReplayRequestBody =
  | { readonly state: "unknown" }
  | { readonly state: "empty" }
  | { readonly state: "json"; readonly value: JsonValue };

const UNKNOWN = { state: "unknown" } as const;
const EMPTY = { state: "empty" } as const;

/**
 * Omission is not an empty request: only a declared size of zero establishes one. Redacted,
 * oversized, non-JSON or numerically inexact bodies cannot establish identity, so they stay unknown.
 * The HAR declarations are read by their owner; this only decides what strict replay may match.
 */
export const readReplayRequestBody = (
  record: WebNetworkCaptureRecord,
): ReplayRequestBody => {
  if (
    record.redactions.some(
      ({ pointer }) =>
        pointer === "" ||
        pointer === "/request" ||
        pointer.startsWith("/request/postData") ||
        pointer === "/request/bodySize",
    )
  )
    return UNKNOWN;
  const request = readRecordedRequestBody(record.reported);
  if (request.kind !== "request") return UNKNOWN;
  const declaredEmpty =
    request.bodySize.kind === "number" && request.bodySize.value === 0;
  if (request.postData.kind === "missing")
    return declaredEmpty ? EMPTY : UNKNOWN;
  if (request.postData.kind !== "object") return UNKNOWN;
  const { text, mimeType } = request.postData;
  if (text === undefined || mimeType === undefined) return UNKNOWN;
  if (text.length === 0) return declaredEmpty ? EMPTY : UNKNOWN;
  if (
    text.length > REPLAY_REQUEST_BODY_LIMIT_BYTES ||
    Buffer.byteLength(text, "utf8") > REPLAY_REQUEST_BODY_LIMIT_BYTES
  )
    return UNKNOWN;
  if (!isJson(mediaTypeEssence(mimeType))) return UNKNOWN;
  const value = parseExactJson(text);
  return value === undefined ? UNKNOWN : { state: "json", value };
};
