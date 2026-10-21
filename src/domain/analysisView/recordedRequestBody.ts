import { z } from "zod";
import { parseExactJson } from "../exactJsonNumber.js";
import type { JsonValue } from "../jsonValue.js";
import type { WebNetworkCaptureRecord } from "../webNetworkCapture.js";
import { mediaTypeEssence } from "./webNetworkRouteTemplates.js";

/** Bound request parsing before allocation, shared by HAR and scenario replay. */
export const RECORDED_REQUEST_BODY_LIMIT_BYTES = 256 * 1024;

export type RecordedRequestBody =
  | { readonly state: "unknown" }
  | { readonly state: "empty" }
  | { readonly state: "json"; readonly value: JsonValue };

const requestSchema = z.object({
  request: z.object({
    bodySize: z.unknown().optional(),
    postData: z.unknown().optional(),
  }),
});
const postDataSchema = z.object({ mimeType: z.string(), text: z.string() });

/** Omission is not an empty request; redacted or inexact JSON cannot establish identity. */
export const readRecordedRequestBody = (
  record: WebNetworkCaptureRecord,
): RecordedRequestBody => {
  const unknown = { state: "unknown" } as const;
  if (
    record.redactions.some(
      ({ pointer }) =>
        pointer === "" ||
        pointer === "/request" ||
        pointer.startsWith("/request/postData") ||
        pointer === "/request/bodySize",
    )
  )
    return unknown;
  const parsed = requestSchema.safeParse(record.reported);
  if (!parsed.success) return unknown;
  const { postData, bodySize } = parsed.data.request;
  if (postData === undefined)
    return bodySize === 0 ? { state: "empty" } : unknown;
  const data = postDataSchema.safeParse(postData);
  if (!data.success) return unknown;
  const { text, mimeType } = data.data;
  if (text.length === 0) return bodySize === 0 ? { state: "empty" } : unknown;
  if (
    text.length > RECORDED_REQUEST_BODY_LIMIT_BYTES ||
    Buffer.byteLength(text, "utf8") > RECORDED_REQUEST_BODY_LIMIT_BYTES
  )
    return unknown;
  const essence = mediaTypeEssence(mimeType);
  if (essence !== "application/json" && !essence?.endsWith("+json"))
    return unknown;
  const value = parseExactJson(text);
  return value === undefined ? unknown : { state: "json", value };
};
