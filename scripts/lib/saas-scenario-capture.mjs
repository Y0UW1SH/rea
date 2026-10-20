import { createHash } from "node:crypto";
import {
  decodeExportText,
  parseExportJson,
  readBoundedExport,
} from "./saas-export-comparison.mjs";

// Shared reader for capture_browser_scenario normalized_result files. It validates only
// the fields the SaaS companions consume (src/domain/browserScenarioCaptureValues.ts owns
// the full contract), re-verifies retained body digests, and never reads header values.

const NETWORK_KINDS = new Set([
  "request",
  "response",
  "request-failed",
  "request-finished",
  "request-unfinished",
]);

function object(value, at) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error(`${at}: expected object`);
}
function text(value, at) {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${at}: expected nonempty string`);
}
function count(value, at) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${at}: expected nonnegative integer`);
}
function url(value, at) {
  object(value, at);
  text(value.url, `${at}.url`);
  if (value.origin !== null && typeof value.origin !== "string")
    throw new Error(`${at}.origin: expected string or null`);
  if (typeof value.redacted !== "boolean")
    throw new Error(`${at}.redacted: expected boolean`);
  if (
    Object.hasOwn(value, "query_parameter_names") &&
    (!Array.isArray(value.query_parameter_names) ||
      value.query_parameter_names.some((name) => typeof name !== "string"))
  )
    throw new Error(`${at}.query_parameter_names: expected string array`);
}
function body(value, at) {
  object(value, at);
  text(value.state, `${at}.state`);
  if (value.state === "captured") {
    if (typeof value.content !== "string")
      throw new Error(`${at}.content: expected string`);
    count(value.bytes, `${at}.bytes`);
    if (
      typeof value.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.sha256)
    )
      throw new Error(`${at}.sha256: expected hex digest`);
    if (value.media_type !== null && typeof value.media_type !== "string")
      throw new Error(`${at}.media_type: expected string or null`);
    if (typeof value.redacted !== "boolean")
      throw new Error(`${at}.redacted: expected boolean`);
  } else if (value.state === "unavailable") text(value.reason, `${at}.reason`);
}
function headers(value, at) {
  object(value, at);
  text(value.state, `${at}.state`);
  if (value.state !== "captured") return;
  if (!Array.isArray(value.items))
    throw new Error(`${at}.items: expected array`);
  for (const [index, item] of value.items.entries()) {
    object(item, `${at}.items[${index}]`);
    text(item.name, `${at}.items[${index}].name`);
    if (typeof item.redacted !== "boolean")
      throw new Error(`${at}.items[${index}].redacted: expected boolean`);
  }
}

/** Check the consumed subset of a scenario capture; everything else passes through. */
export function validateScenarioCapture(capture) {
  object(capture, "capture");
  object(capture.scenario, "scenario");
  object(capture.scenario.network_content, "scenario.network_content");
  for (const key of ["request_body", "response_body", "header_values"])
    if (typeof capture.scenario.network_content[key] !== "boolean")
      throw new Error(`scenario.network_content.${key}: expected boolean`);
  if (!Array.isArray(capture.steps) || capture.steps.length === 0)
    throw new Error("steps: expected nonempty array");
  for (const [index, step] of capture.steps.entries()) {
    object(step, `steps[${index}]`);
    if (step.step_index !== index)
      throw new Error(`steps[${index}].step_index: expected ${index}`);
    text(step.step_id, `steps[${index}].step_id`);
  }
  object(capture.events, "events");
  if (!Array.isArray(capture.events.items))
    throw new Error("events.items: expected array");
  object(capture.completeness, "completeness");
  text(capture.completeness.status, "completeness.status");
  const sequences = new Set();
  for (const [index, event] of capture.events.items.entries()) {
    const at = `events.items[${index}]`;
    object(event, at);
    text(event.kind, `${at}.kind`);
    count(event.sequence, `${at}.sequence`);
    if (sequences.has(event.sequence))
      throw new Error(`${at}.sequence: duplicate event sequence`);
    sequences.add(event.sequence);
    count(event.step_index, `${at}.step_index`);
    if (event.step_index >= capture.steps.length)
      throw new Error(`${at}.step_index: unknown step`);
    if (NETWORK_KINDS.has(event.kind)) {
      text(event.transaction_id, `${at}.transaction_id`);
      text(event.method, `${at}.method`);
      url(event.url, `${at}.url`);
      text(event.resource_type, `${at}.resource_type`);
      if (
        !Array.isArray(event.header_names) ||
        event.header_names.some((name) => typeof name !== "string")
      )
        throw new Error(`${at}.header_names: expected string array`);
      if (event.status !== null && !Number.isSafeInteger(event.status))
        throw new Error(`${at}.status: expected integer or null`);
    } else if (event.kind === "network-content") {
      text(event.transaction_id, `${at}.transaction_id`);
      if (event.phase !== "request" && event.phase !== "response")
        throw new Error(`${at}.phase: expected request or response`);
      count(event.source_event_sequence, `${at}.source_event_sequence`);
      headers(event.headers, `${at}.headers`);
      body(event.body, `${at}.body`);
    }
  }
}

/** Read a capture file beneath root, bounded, and validate its consumed fields. */
export async function readScenarioCapture(root, file, maxBytes) {
  const source = await readBoundedExport(root, file, maxBytes);
  const capture = parseExportJson(
    decodeExportText(source),
    1024,
    1_000_000,
    10_000_000,
  );
  validateScenarioCapture(capture);
  return { capture, bytes: source.bytes, sha256: source.sha256 };
}

function decodeBody(value, at) {
  if (value.state !== "captured")
    return {
      state: value.state,
      reason: value.reason ?? null,
      media_type: null,
      bytes: value.observed_bytes ?? null,
      redacted: false,
    };
  const buffer = Buffer.from(value.content, "base64");
  if (
    buffer.toString("base64") !== value.content ||
    buffer.length !== value.bytes ||
    createHash("sha256").update(buffer).digest("hex") !== value.sha256
  )
    throw new Error(`${at}: retained body digest disagrees with its bytes`);
  return {
    state: "captured",
    media_type: value.media_type,
    bytes: value.bytes,
    sha256: value.sha256,
    redacted: value.redacted,
    buffer,
  };
}

/**
 * One record per transaction, in first-appearance order, owned by the step that sent
 * the request (or the receipt step when no request event survived), as the scenario
 * diff attributes them. Header items keep names and redaction flags only.
 */
export function assembleTransactions(capture, { maxTransactions }) {
  const stepIds = capture.steps.map((step) => step.step_id);
  const items = capture.events.items;
  const bySequence = new Map(items.map((event) => [event.sequence, event]));
  const requests = new Map(
    items
      .filter((event) => event.kind === "request")
      .map((event) => [event.transaction_id, event]),
  );
  const transactions = new Map();
  for (const event of items) {
    if (!NETWORK_KINDS.has(event.kind) && event.kind !== "network-content")
      continue;
    const id = event.transaction_id;
    let record = transactions.get(id);
    if (record === undefined) {
      if (transactions.size >= maxTransactions)
        throw new Error(
          `capture: exceeds maxTransactions (${maxTransactions})`,
        );
      const request = requests.get(id);
      const stepIndex =
        request?.step_index ??
        (event.kind === "network-content"
          ? (bySequence.get(event.source_event_sequence)?.step_index ??
            event.step_index)
          : event.step_index);
      record = {
        transaction_id: id,
        step_index: stepIndex,
        step_id: stepIds[stepIndex],
        method: request?.method ?? null,
        url: request?.url ?? null,
        resource_type: request?.resource_type ?? null,
        header_names: request?.header_names ?? [],
        status: null,
        failure: null,
        request: { headers: null, body: { state: "absent" } },
        response: { headers: null, body: { state: "absent" } },
      };
      transactions.set(id, record);
    }
    if (event.kind === "network-content") {
      const side = record[event.phase];
      side.headers =
        event.headers.state === "captured"
          ? event.headers.items.map(({ name, redacted }) => ({
              name,
              redacted,
            }))
          : null;
      side.body = decodeBody(
        event.body,
        `events[sequence ${event.sequence}].body`,
      );
      continue;
    }
    if (record.method === null) {
      record.method = event.method;
      record.url = event.url;
      record.resource_type = event.resource_type;
      record.header_names = event.header_names;
    }
    if (event.kind === "response") record.status = event.status;
    if (event.kind === "request-failed")
      record.failure = event.failure ?? "failed";
  }
  return [...transactions.values()];
}
