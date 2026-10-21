import { DEFAULT_MAX_REQUEST_BODY_SIZE } from "@modelcontextprotocol/server";
import { parseExactJson } from "../../domain/exactJsonNumber.js";
import type { JsonValue } from "../../domain/jsonValue.js";

type StrictJsonBody =
  | { readonly kind: "too-large" }
  | { readonly kind: "invalid" }
  | { readonly kind: "json"; readonly value: JsonValue };

/** Preserve UTF-8 and numeric identity within the SDK byte bound and caller-owned stream lifetime. */
export const readStrictJsonBody = async (
  request: Request,
): Promise<StrictJsonBody> => {
  if (
    Number(request.headers.get("content-length")) >
    DEFAULT_MAX_REQUEST_BODY_SIZE
  )
    return { kind: "too-large" };
  if (request.body === null) return { kind: "invalid" };
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let received = 0;
  let text = "";
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      received += next.value.byteLength;
      if (received > DEFAULT_MAX_REQUEST_BODY_SIZE)
        return { kind: "too-large" };
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    const value = parseExactJson(text);
    return value === undefined ? { kind: "invalid" } : { kind: "json", value };
  } catch {
    return { kind: "invalid" };
  } finally {
    reader.releaseLock();
  }
};
