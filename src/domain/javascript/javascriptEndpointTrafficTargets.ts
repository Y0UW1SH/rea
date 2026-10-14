import {
  apiSurfaceSegmentRule,
  type WebNetworkApiSurfaceGroup,
} from "../analysisView/WebNetworkApiSurfaceAccumulator.js";
import type { JsonValue } from "../jsonValue.js";
import { parseRecordedTransportUrl } from "../recordedTransportUrl.js";
import {
  compareUnicodeCodePoints as compare,
  compositeKey,
} from "../unicodeCodePointOrder.js";
import {
  ENDPOINT_TRAFFIC_PROTOCOLS,
  type EndpointTrafficStaticItem,
  type EndpointTrafficUnknownReason,
} from "./javascriptEndpointTrafficComparisonSchemas.js";
import type { ApplicationNode } from "./javascriptApplicationGraphSchemas.js";

/** Static endpoint facts, request-target, method and route-shape rules. */

type Method = Extract<
  EndpointTrafficStaticItem,
  { status: "matched" }
>["method"];
/** Exact or template-compatible basis of one static/observed pairing. */
export type PairingBasis = Extract<
  EndpointTrafficStaticItem,
  { status: "matched" }
>["observed"][number]["basis"];

// Paths are resolved only to prove that the URL parser leaves them unchanged.
const CANONICAL_PROBE_BASE = "https://rea.invalid";
const CALLEE_METHODS = new Map([
  ["get", "GET"],
  ["post", "POST"],
  ["put", "PUT"],
  ["patch", "PATCH"],
  ["delete", "DELETE"],
]);
type ParsedTarget =
  | {
      readonly kind: "absolute";
      readonly origin: string;
      readonly path: string;
    }
  | { readonly kind: "relative"; readonly path: string }
  | {
      readonly kind: "ineligible";
      readonly reason: EndpointTrafficUnknownReason;
    };

/** Classify one static literal without echoing values outside origin and path. */
export const parseStaticTarget = (value: string): ParsedTarget => {
  if (value.startsWith("/") && value[1] !== "/" && value[1] !== "\\") {
    let end = 0;
    while (end < value.length && value[end] !== "?" && value[end] !== "#")
      end += 1;
    const path = value.slice(0, end);
    return URL.parse(value, CANONICAL_PROBE_BASE)?.pathname === path
      ? { kind: "relative", path }
      : { kind: "ineligible", reason: "target-not-canonical" };
  }
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value))
    return { kind: "ineligible", reason: "relative-reference-base-unknown" };
  const parsed = URL.parse(value);
  if (parsed === null)
    return { kind: "ineligible", reason: "value-not-url-or-path" };
  if (!ENDPOINT_TRAFFIC_PROTOCOLS.has(parsed.protocol))
    return { kind: "ineligible", reason: "unsupported-url-scheme" };
  // The same recorded-URL owner projects HAR request paths.
  const recorded = parseRecordedTransportUrl(value);
  return recorded.origin === parsed.origin && recorded.path === parsed.pathname
    ? { kind: "absolute", origin: parsed.origin, path: parsed.pathname }
    : { kind: "ineligible", reason: "target-not-canonical" };
};

const calleeName = (mechanism: string): string | undefined =>
  mechanism.startsWith("call:") ? mechanism.slice(5) : undefined;

const lastMember = (name: string): string =>
  name.slice(name.lastIndexOf(".") + 1);

/** Method fixed by the API definition or suggested by an HTTP-verb callee. */
const mechanismMethod = (
  mechanism: string,
):
  | { readonly value: string; readonly basis: "api-definition" | "callee-name" }
  | undefined => {
  const name = calleeName(mechanism);
  if (name === undefined) return undefined;
  const member = lastMember(name);
  if (member === "EventSource")
    return { value: "GET", basis: "api-definition" };
  if (member === "sendBeacon")
    return { value: "POST", basis: "api-definition" };
  const method = CALLEE_METHODS.get(member);
  return method === undefined
    ? undefined
    : { value: method, basis: "callee-name" };
};

export const nodeMethod = (mechanisms: readonly string[]): Method => {
  const methods = mechanisms.map(mechanismMethod);
  if (methods.some((method) => method === undefined))
    return { values: [], basis: "unknown" };
  const known = methods.filter((method) => method !== undefined);
  return {
    values: [...new Set(known.map(({ value }) => value))].sort(compare),
    basis: known.some(({ basis }) => basis === "callee-name")
      ? "callee-name"
      : "api-definition",
  };
};

/** The WebSocket constructor requests HTTP(S) URLs through WS(S). */
export const requestOrigin = (mechanism: string, origin: string): string => {
  const name = calleeName(mechanism);
  if (name === undefined || lastMember(name) !== "WebSocket") return origin;
  if (origin.startsWith("https:")) return `wss:${origin.slice(6)}`;
  if (origin.startsWith("http:")) return `ws:${origin.slice(5)}`;
  return origin;
};

/** Route shape shared by static paths and api-surface groups, before origin. */
const shapeKey = (
  segments: readonly string[],
  ruleAt: (index: number, segment: string) => string | null,
): string =>
  compositeKey(
    segments.map((segment, index) => {
      const rule = ruleAt(index, segment);
      return rule === null ? [0, segment] : [1, rule];
    }),
  );

export const routeKey = (origin: string, shape: string): string =>
  compositeKey([origin, shape]);

const pathSegments = (path: string): readonly string[] =>
  path.slice(1).split("/");

export const staticShapeKey = (path: string): string =>
  shapeKey(pathSegments(path), (_index, segment) =>
    apiSurfaceSegmentRule(segment),
  );

export const groupShapeKey = (group: WebNetworkApiSurfaceGroup): string => {
  const rules = new Map(
    group.templated_segments.map(({ segment_index, rule }) => [
      segment_index,
      rule,
    ]),
  );
  return shapeKey(
    pathSegments(group.path_template),
    (index) => rules.get(index) ?? null,
  );
};

/**
 * A templated group proves one recorded request with the static path only when
 * every templated value occurred and at most one templated position varied.
 */
export const pairingBasis = (
  group: WebNetworkApiSurfaceGroup,
  path: string,
): PairingBasis => {
  const segments = pathSegments(path);
  let varying = 0;
  for (const templated of group.templated_segments) {
    if (templated.observed_values.length > 1) varying += 1;
    if (!templated.observed_values.includes(segments[templated.segment_index]!))
      return "template-compatible";
  }
  return varying <= 1 ? "exact" : "template-compatible";
};

const stringProperty = (
  properties: Readonly<Record<string, JsonValue>>,
  name: string,
): string | undefined => {
  const value = properties[name];
  return typeof value === "string" ? value : undefined;
};

export interface NodeFacts {
  readonly node: ApplicationNode;
  readonly value: string;
  readonly mechanisms: string[];
  readonly candidate: boolean;
}

/** Network endpoint observations; route nodes describe client routing. */
export const networkEndpointFacts = (
  node: ApplicationNode,
): NodeFacts | undefined => {
  if (node.kind !== "endpoint") return undefined;
  const network = node.observations.filter(
    ({ properties }) => properties.endpoint_kind === "network",
  );
  // A literal request observation outweighs a candidate reading of the same
  // value; the node is a candidate only when every observation is one.
  const literal = network.filter(
    ({ properties }) => properties.interpretation !== "candidate",
  );
  const observations = literal.length > 0 ? literal : network;
  const value = observations
    .map(({ properties }) => stringProperty(properties, "value"))
    .find((candidate) => candidate !== undefined);
  if (value === undefined) return undefined;
  const mechanisms = [
    ...new Set(
      observations.map(
        ({ properties }) =>
          stringProperty(properties, "mechanism") ?? "unknown",
      ),
    ),
  ].sort(compare);
  return {
    node,
    value,
    mechanisms,
    candidate: literal.length === 0,
  };
};

export interface ObservedIndex {
  readonly byRoute: ReadonlyMap<string, readonly WebNetworkApiSurfaceGroup[]>;
  readonly byShape: ReadonlyMap<string, readonly WebNetworkApiSurfaceGroup[]>;
  readonly exercisedOrigins: ReadonlySet<string>;
  readonly coverageIncomplete: boolean;
}

/**
 * Index every api-surface group by origin and route shape. Two keys per group
 * are smaller than the per-group allowance the accumulator already charged for
 * that group's retained text, so the index stays within the same order of
 * memory as the admitted grouping.
 */
export const indexObservedGroups = (observed: {
  readonly groups: readonly WebNetworkApiSurfaceGroup[];
  readonly records: {
    readonly examined: number;
    readonly total: number;
    readonly excluded: number;
  };
}): ObservedIndex => {
  const byRoute = new Map<string, WebNetworkApiSurfaceGroup[]>();
  const byShape = new Map<string, WebNetworkApiSurfaceGroup[]>();
  const add = (
    index: Map<string, WebNetworkApiSurfaceGroup[]>,
    key: string,
    group: WebNetworkApiSurfaceGroup,
  ) => {
    const bucket = index.get(key);
    if (bucket === undefined) index.set(key, [group]);
    else bucket.push(group);
  };
  for (const group of observed.groups) {
    const shape = groupShapeKey(group);
    add(byShape, shape, group);
    add(byRoute, routeKey(group.origin, shape), group);
  }
  const { records } = observed;
  return {
    byRoute,
    byShape,
    exercisedOrigins: new Set(observed.groups.map(({ origin }) => origin)),
    coverageIncomplete:
      records.excluded > 0 || records.examined < records.total,
  };
};
