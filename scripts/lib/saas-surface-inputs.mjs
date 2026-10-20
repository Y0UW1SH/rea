import {
  isCanonicalOrigin,
  parseOriginPairs,
  sortOriginPairs,
} from "./saas-origin-pairs.mjs";
import { sortCodePoints } from "./saas-ordering.mjs";

// Static-analysis, origins and api-surface readers of the surface-coverage companion.
// Only consumed fields are validated (the TypeScript schemas own the full contracts);
// envelope extras pass through. Captures and comparison results are read by
// saas-surface-observed.mjs with the same validators.

export const SURFACE_LIMITS = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxNodes: 200_000,
  maxGroups: 100_000,
  maxTransactions: 100_000,
  maxBodyBytes: 1024 * 1024,
});
const ROUTE_RULES = new Set(["numeric", "uuid", "hex", "iso-date"]);

export const plain = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
export function object(value, at, keys) {
  if (!plain(value)) throw new Error(`${at}: expected object`);
  if (keys && Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error(`${at}: unsupported field`);
}
export function text(value, at) {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`${at}: expected nonempty string`);
}
export function count(value, at) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${at}: expected nonnegative integer`);
}
export function list(value, at, ceiling = Number.MAX_SAFE_INTEGER) {
  if (!Array.isArray(value)) throw new Error(`${at}: expected array`);
  if (value.length > ceiling)
    throw new Error(`${at}: exceeds ${ceiling} entries`);
}
export function hex(value, at) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
    throw new Error(`${at}: expected hex digest`);
}
/** The nonempty strings of an optional array; anything else contributes nothing. */
export const strings = (value) =>
  Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.length > 0)
    : [];

/** A source-range location of one observation, when the analyzer recorded one. */
function observationLocation(observation) {
  const location = observation.evidence?.location;
  if (!plain(location) || location.available !== true) return null;
  const { value } = location;
  if (!plain(value) || value.kind !== "source-range" || !plain(value.start))
    return null;
  if (
    typeof value.source !== "string" ||
    !Number.isSafeInteger(value.start.line) ||
    !Number.isSafeInteger(value.start.column)
  )
    return null;
  return {
    source: value.source,
    line: value.start.line,
    column: value.start.column,
  };
}

function endpointObservation(observation, at) {
  object(observation, at);
  object(observation.properties, `${at}.properties`);
  const { properties } = observation;
  text(properties.endpoint_kind, `${at}.properties.endpoint_kind`);
  if (typeof properties.value !== "string")
    throw new Error(`${at}.properties.value: expected string`);
  if (typeof properties.mechanism !== "string")
    throw new Error(`${at}.properties.mechanism: expected string`);
  for (const key of ["interpretation", "resolution"])
    if (Object.hasOwn(properties, key) && typeof properties[key] !== "string")
      throw new Error(`${at}.properties.${key}: expected string`);
  return observationLocation(observation);
}

function endpointNode(node, where, rootSha256) {
  object(node.identity, `${where}.identity`);
  list(node.observations, `${where}.observations`);
  if (node.observations.length === 0)
    throw new Error(`${where}.observations: expected nonempty array`);
  const locations = [];
  for (const [position, observation] of node.observations.entries()) {
    const location = endpointObservation(
      observation,
      `${where}.observations[${position}]`,
    );
    if (
      location !== null &&
      !locations.some(
        (known) =>
          known.source === location.source &&
          known.line === location.line &&
          known.column === location.column,
      )
    )
      locations.push(location);
  }
  return {
    node,
    artifact_sha256:
      typeof node.identity.artifact_sha256 === "string"
        ? node.identity.artifact_sha256
        : rootSha256,
    locations,
  };
}

/** Validate the consumed subset of an analyze_javascript_application result or its Evidence. */
export function readStaticAnalysis(input, at = "static") {
  object(input, at);
  const value = plain(input.normalized_result)
    ? input.normalized_result
    : input;
  hex(value.root_artifact_sha256, `${at}.root_artifact_sha256`);
  object(value.graph, `${at}.graph`);
  text(value.graph.graph_id, `${at}.graph.graph_id`);
  list(value.graph.nodes, `${at}.graph.nodes`, SURFACE_LIMITS.maxNodes);
  object(value.graph.coverage, `${at}.graph.coverage`);
  text(value.graph.coverage.status, `${at}.graph.coverage.status`);
  const endpoints = [];
  for (const [index, node] of value.graph.nodes.entries()) {
    const where = `${at}.graph.nodes[${index}]`;
    object(node, where);
    text(node.node_id, `${where}.node_id`);
    text(node.kind, `${where}.kind`);
    if (node.kind === "endpoint")
      endpoints.push(endpointNode(node, where, value.root_artifact_sha256));
  }
  return {
    root_artifact_sha256: value.root_artifact_sha256,
    graph_id: value.graph.graph_id,
    coverage: { status: value.graph.coverage.status },
    nodes: value.graph.nodes.length,
    endpoints,
    limitations: strings(value.limitations),
  };
}

/** Declared reference origins plus directional pairs folding replacement origins onto them. */
export function validateOrigins(value) {
  if (value === undefined)
    return { declared_origins: [], origin_pairs: [], fold: (origin) => origin };
  object(value, "origins", ["declared_origins", "origin_pairs"]);
  const declared = value.declared_origins ?? [];
  list(declared, "origins.declared_origins");
  for (const [index, origin] of declared.entries())
    if (!isCanonicalOrigin(origin))
      throw new Error(
        `origins.declared_origins[${index}]: expected a canonical HTTP(S) or WS(S) origin`,
      );
  if (new Set(declared).size !== declared.length)
    throw new Error("origins.declared_origins: duplicate origin");
  const pairs =
    value.origin_pairs === undefined
      ? []
      : sortOriginPairs(
          parseOriginPairs(value.origin_pairs, "origins.origin_pairs"),
        );
  const after = new Map(
    pairs.map((pair) => [pair.after_origin, pair.before_origin]),
  );
  return {
    declared_origins: sortCodePoints(declared),
    origin_pairs: pairs,
    fold: (origin) => after.get(origin) ?? origin,
  };
}

function templatedSegment(segment, here) {
  object(segment, here);
  count(segment.segment_index, `${here}.segment_index`);
  if (!ROUTE_RULES.has(segment.rule))
    throw new Error(`${here}.rule: expected numeric, uuid, hex or iso-date`);
  list(segment.observed_values, `${here}.observed_values`);
  segment.observed_values.forEach((value, position) =>
    text(value, `${here}.observed_values[${position}]`),
  );
  return {
    segment_index: segment.segment_index,
    rule: segment.rule,
    observed_values: [...segment.observed_values],
  };
}

function apiSurfaceGroup(group, where) {
  object(group, where);
  text(group.method, `${where}.method`);
  text(group.origin, `${where}.origin`);
  text(group.path_template, `${where}.path_template`);
  if (!group.path_template.startsWith("/"))
    throw new Error(`${where}.path_template: expected a path starting with /`);
  list(group.templated_segments, `${where}.templated_segments`);
  list(group.record_ordinals, `${where}.record_ordinals`);
  group.record_ordinals.forEach((ordinal, index) =>
    count(ordinal, `${where}.record_ordinals[${index}]`),
  );
  list(group.statuses, `${where}.statuses`);
  group.statuses.forEach((status, index) => {
    if (typeof status !== "number")
      throw new Error(`${where}.statuses[${index}]: expected number`);
  });
  return {
    method: group.method,
    origin: group.origin,
    path_template: group.path_template,
    templated_segments: group.templated_segments.map((segment, index) =>
      templatedSegment(segment, `${where}.templated_segments[${index}]`),
    ),
    record_ordinals: [...group.record_ordinals],
    statuses: [...group.statuses],
  };
}

/** Record counts plus the incompleteness reasons they imply. */
export function records(value, at) {
  object(value, at);
  for (const key of ["examined", "total", "excluded"])
    count(value[key], `${at}.${key}`);
  const reasons = [];
  if (value.excluded > 0) reasons.push(`records.excluded = ${value.excluded}`);
  if (value.examined < value.total)
    reasons.push(`records examined ${value.examined} of ${value.total}`);
  return {
    records: {
      examined: value.examined,
      total: value.total,
      excluded: value.excluded,
    },
    reasons,
  };
}

/** An api-surface view result: groups as recorded, paging and exclusions as incompleteness. */
export function apiSurfaceObserved(value, at) {
  list(value.groups, `${at}.groups`, SURFACE_LIMITS.maxGroups);
  const { records: counts, reasons } = records(value.records, `${at}.records`);
  if (plain(value.coverage) && value.coverage.exhausted === false)
    reasons.push("groups page not exhausted (next_offset set)");
  return {
    kind: "api-surface",
    groups: value.groups.map((group, index) =>
      apiSurfaceGroup(group, `${at}.groups[${index}]`),
    ),
    records: counts,
    incompleteness: reasons,
    bodiesRetained: false,
    operations: [],
    navigations: [],
    comparison: null,
    limitations: strings(value.limitations),
  };
}
