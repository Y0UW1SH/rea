import { isCanonicalOrigin } from "./saas-origin-pairs.mjs";
import { recordedPath, routeTemplate } from "./saas-route-templates.mjs";

// Manifest validation and transaction admission shared by contract inference and
// verification, so both sides admit exactly the same request lines and bodies.

export const DEFAULT_OPTIONS = {
  required_min_samples: 3,
  enum_max_cardinality: 8,
  enum_min_samples: 5,
  format_min_samples: 2,
};
export const DEFAULT_RESOURCE_TYPES = ["fetch", "xhr"];
export const LIMIT_CEILINGS = {
  maxBytes: 16 * 1024 * 1024,
  maxTransactions: 100_000,
  maxBodyBytes: 1024 * 1024,
  maxSchemaNodes: 1_000_000,
  maxEvidencePerOperation: 10_000,
};

/** Unicode code point order, as the TypeScript views sort templates and methods. */
export function compareCodePoints(left, right) {
  const a = [...left];
  const b = [...right];
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = a[index].codePointAt(0) - b[index].codePointAt(0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}
export const sortCodePoints = (values) => [...values].sort(compareCodePoints);
export const serializeContract = (value) =>
  `${JSON.stringify(value, null, 2)}\n`;

function object(value, keys, at) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error(`${at}: expected object`);
  if (keys && Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error(`${at}: unsupported field`);
}
function text(value, at) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${at}: expected nonempty string`);
}
function positive(value, at, ceiling = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling)
    throw new Error(`${at}: expected positive integer at most ${ceiling}`);
}
function relativeFile(value, at) {
  text(value, at);
  if (
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    value.split("/").includes("..")
  )
    throw new Error(`${at}: expected relative path without traversal`);
}

function manifestOrigins(origins) {
  if (origins === undefined) return null;
  if (!Array.isArray(origins) || origins.length !== 1)
    throw new Error("origins: expected exactly one declared primary origin");
  if (!isCanonicalOrigin(origins[0]))
    throw new Error("origins[0]: expected a canonical HTTP(S) or WS(S) origin");
  return [origins[0]];
}
function manifestResourceTypes(types) {
  if (types === undefined) return DEFAULT_RESOURCE_TYPES;
  if (!Array.isArray(types) || types.length === 0)
    throw new Error("resource_types: expected nonempty array");
  types.forEach((type, index) => text(type, `resource_types[${index}]`));
  return sortCodePoints(new Set(types));
}
function manifestOptions(options) {
  const resolved = { ...DEFAULT_OPTIONS };
  if (options === undefined) return resolved;
  object(options, Object.keys(DEFAULT_OPTIONS), "options");
  for (const [key, value] of Object.entries(options)) {
    positive(value, `options.${key}`);
    resolved[key] = value;
  }
  return resolved;
}

/** Strict manifest validation with defaults applied; unknown fields fail. */
export function validateContractManifest(manifest) {
  object(
    manifest,
    [
      "version",
      "name",
      "captures",
      "origins",
      "resource_types",
      "options",
      "limits",
    ],
    "manifest",
  );
  if (manifest.version !== 1) throw new Error("version: expected 1");
  text(manifest.name, "name");
  if (!Array.isArray(manifest.captures) || manifest.captures.length === 0)
    throw new Error("captures: expected nonempty array");
  const captures = manifest.captures.map((capture, index) => {
    object(capture, ["file"], `captures[${index}]`);
    relativeFile(capture.file, `captures[${index}].file`);
    return { file: capture.file };
  });
  const origins = manifestOrigins(manifest.origins);
  object(manifest.limits, Object.keys(LIMIT_CEILINGS), "limits");
  for (const [key, ceiling] of Object.entries(LIMIT_CEILINGS))
    positive(manifest.limits[key], `limits.${key}`, ceiling);
  return {
    version: 1,
    name: manifest.name,
    captures,
    ...(origins === null ? {} : { origins }),
    resource_types: manifestResourceTypes(manifest.resource_types),
    options: manifestOptions(manifest.options),
    limits: { ...manifest.limits },
  };
}

/** Lowercase type/subtype without parameters; malformed essences are unknown. */
export function mediaTypeEssence(reported) {
  if (typeof reported !== "string") return null;
  const essence = reported.split(";")[0].trim();
  return /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u.test(
    essence,
  )
    ? essence.toLowerCase()
    : null;
}
const isJsonEssence = (essence) =>
  essence === "application/json" ||
  (essence !== null && essence.endsWith("+json"));

/** A retained body is JSON evidence, non-JSON evidence, truncated, or absent. */
export function classifyBody(body, maxBodyBytes) {
  if (body.state === "captured") {
    if (body.bytes > maxBodyBytes) return { kind: "truncated" };
    const essence = mediaTypeEssence(body.media_type);
    if (!isJsonEssence(essence)) return { kind: "non-json", essence };
    return { kind: "json", essence, body };
  }
  if (
    body.state === "unavailable" &&
    (body.reason === "body-size-limit" ||
      body.reason === "body-allocation-limit")
  )
    return { kind: "truncated" };
  return { kind: "absent" };
}

/** Admission shared by infer and verify: request line, resource type and body kinds. */
export function admitTransaction(transaction, { resourceTypes, maxBodyBytes }) {
  if (transaction.method === null || transaction.url === null)
    return { excluded: "request-unavailable" };
  if (transaction.url.redacted) return { excluded: "url-redacted" };
  const line = recordedPath(transaction.url.url);
  if (line === null) return { excluded: "url-unparseable" };
  if (!resourceTypes.includes(transaction.resource_type))
    return { excluded: "resource-type" };
  const request = classifyBody(transaction.request.body, maxBodyBytes);
  const response = classifyBody(transaction.response.body, maxBodyBytes);
  if (request.kind === "non-json" || response.kind === "non-json")
    return { excluded: "non-json-body" };
  const route = routeTemplate(line.path);
  return {
    origin: line.origin,
    path: line.path,
    route,
    request,
    response,
    json: request.kind === "json" || response.kind === "json",
  };
}

/** OpenAPI path with positional parameter names; the api-surface template stays alongside. */
export function openapiPath(route, path) {
  const parts = path.split("/");
  for (const segment of route.segments)
    parts[segment.segment_index + 1] =
      `{${segment.rule}_${segment.segment_index}}`;
  return parts.join("/");
}
