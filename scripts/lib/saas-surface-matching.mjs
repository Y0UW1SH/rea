import { compareCodePoints as compare } from "./saas-ordering.mjs";
import { recordedPath, segmentRule } from "./saas-route-templates.mjs";

// Companion port of the static/observed endpoint pairing rules whose owner is the
// unmerged branch feat/3591-endpoint-traffic-comparison:
//   src/domain/javascript/javascriptEndpointTrafficTargets.ts (target parsing, method
//   inference, ws(s) origins, route shapes, pairing basis, observed index) and
//   src/domain/javascript/javascriptEndpointTrafficComparison.ts (classify).
// Owner helpers map onto the increment-1 mirrors: apiSurfaceSegmentRule -> segmentRule,
// parseRecordedTransportUrl -> recordedPath, compositeKey -> JSON.stringify of the tuple,
// compareUnicodeCodePoints -> compareCodePoints. scripts/saas-surface-matching.test.mjs
// pins the status and reason vocabulary so this port can be deleted once 3591 merges.

/** URL schemes whose requests an api-surface grouping can contain. */
export const ENDPOINT_TRAFFIC_PROTOCOLS = new Set([
  "http:",
  "https:",
  "ws:",
  "wss:",
]);

/** Why a static network endpoint has no matched or not-observed status. */
export const ENDPOINT_TRAFFIC_UNKNOWN_REASONS = Object.freeze([
  "candidate-endpoint",
  "rpc-operation-not-path",
  "rpc-transport-base-url",
  "relative-reference-base-unknown",
  "unsupported-url-scheme",
  "value-not-url-or-path",
  "target-not-canonical",
  "origin-undeclared",
  "origin-not-exercised",
  "observed-coverage-incomplete",
]);
export const STATIC_ITEM_STATUSES = Object.freeze([
  "matched",
  "ambiguous",
  "not-observed-in-capture",
  "unknown",
]);
export const PAIRING_BASES = Object.freeze(["exact", "template-compatible"]);
export const METHOD_BASES = Object.freeze([
  "callee-name",
  "api-definition",
  "unknown",
]);
export const ORIGIN_BASES = Object.freeze([
  "literal",
  "declared",
  "undeclared",
]);
export const AMBIGUOUS_REASON = "method-inference-disagrees";

/** The owner's fixed limitations, quoted so the companion states the same bounds. */
export const FIXED_LIMITATIONS = Object.freeze([
  "Static endpoints are exact literal request targets; string-built, wrapper-passed and server-supplied URLs are absent, so an observed group without a static match does not establish missing or hidden code.",
  "not-observed-in-capture means only that this capture has no compatible request group; it does not establish that an endpoint is unused, hidden or unreachable.",
  "Paths compare as recorded, still-encoded text without dot-segment, case or trailing-slash normalization. A template-compatible pairing shares an api-surface route shape; the static literal path itself was not recorded.",
  "Methods inferred from callee names and origins joined from caller declarations are inferences; fetch, XMLHttpRequest, WebSocket and request-style calls keep an unknown method.",
  "Client route nodes, candidate values and GraphQL or tRPC operation names are never compared with request paths.",
]);

// Paths are resolved only to prove that the URL parser leaves them unchanged.
const CANONICAL_PROBE_BASE = "https://rea.invalid";
const CALLEE_METHODS = new Map([
  ["get", "GET"],
  ["post", "POST"],
  ["put", "PUT"],
  ["patch", "PATCH"],
  ["delete", "DELETE"],
]);
const compositeKey = (parts) => JSON.stringify(parts);

/** Classify one static literal without echoing values outside origin and path. */
export function parseStaticTarget(value) {
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
  // The same recorded-URL mirror projects captured request paths.
  const recorded = recordedPath(value);
  return recorded !== null &&
    recorded.origin === parsed.origin &&
    recorded.path === parsed.pathname
    ? { kind: "absolute", origin: parsed.origin, path: parsed.pathname }
    : { kind: "ineligible", reason: "target-not-canonical" };
}

const calleeName = (mechanism) =>
  mechanism.startsWith("call:") ? mechanism.slice(5) : undefined;
const lastMember = (name) => name.slice(name.lastIndexOf(".") + 1);

/** Method fixed by the API definition or suggested by an HTTP-verb callee. */
const mechanismMethod = (mechanism) => {
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

export function nodeMethod(mechanisms) {
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
}

/** The WebSocket constructor requests HTTP(S) URLs through WS(S). */
export function requestOrigin(mechanism, origin) {
  const name = calleeName(mechanism);
  if (name === undefined || lastMember(name) !== "WebSocket") return origin;
  if (origin.startsWith("https:")) return `wss:${origin.slice(6)}`;
  if (origin.startsWith("http:")) return `ws:${origin.slice(5)}`;
  return origin;
}

/** Route shape shared by static paths and api-surface groups, before origin. */
const shapeKey = (segments, ruleAt) =>
  compositeKey(
    segments.map((segment, index) => {
      const rule = ruleAt(index, segment);
      return rule === null ? [0, segment] : [1, rule];
    }),
  );

export const routeKey = (origin, shape) => compositeKey([origin, shape]);

const pathSegments = (path) => path.slice(1).split("/");

export const staticShapeKey = (path) =>
  shapeKey(pathSegments(path), (_index, segment) => segmentRule(segment));

export function groupShapeKey(group) {
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
}

/**
 * A templated group proves one recorded request with the static path only when
 * every templated value occurred and at most one templated position varied.
 */
export function pairingBasis(group, path) {
  const segments = pathSegments(path);
  let varying = 0;
  for (const templated of group.templated_segments) {
    if (templated.observed_values.length > 1) varying += 1;
    if (!templated.observed_values.includes(segments[templated.segment_index]))
      return "template-compatible";
  }
  return varying <= 1 ? "exact" : "template-compatible";
}

const stringProperty = (properties, name) => {
  const value = properties[name];
  return typeof value === "string" ? value : undefined;
};

/** Network endpoint observations; route nodes describe client routing. */
export function networkEndpointFacts(node) {
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
  return { node, value, mechanisms, candidate: literal.length === 0 };
}

/** Index every api-surface group by origin and route shape. */
export function indexObservedGroups(observed) {
  const byRoute = new Map();
  const byShape = new Map();
  const add = (index, key, group) => {
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
}

const pairsFor = (groups, path) =>
  groups
    .map((group) => ({ group, basis: pairingBasis(group, path) }))
    .sort(
      (left, right) =>
        compare(left.group.origin, right.group.origin) ||
        compare(left.group.method, right.group.method),
    );

const unknownItem = (facts, reason, method = null, target = null) => ({
  item: {
    static_node_id: facts.node.node_id,
    mechanisms: facts.mechanisms,
    status: "unknown",
    reason,
    method,
    target,
  },
  pairs: [],
  referenced: [],
  unresolved: [],
  inferred: false,
});

/** GraphQL/tRPC findings name operations or transport bases, not request paths. */
const rpcReason = (mechanisms) => {
  if (
    mechanisms.some(
      (mechanism) =>
        mechanism.startsWith("graphql:") ||
        mechanism.startsWith("trpc:procedure:"),
    )
  )
    return "rpc-operation-not-path";
  return mechanisms.some((mechanism) => mechanism.startsWith("trpc:link:"))
    ? "rpc-transport-base-url"
    : undefined;
};

/**
 * Pair one static network endpoint with observed groups exactly as the owner's
 * classify does: nothing is paired by similarity, prefix, case folding or
 * cross-origin guesses. Groups are returned by reference.
 */
export function classifyStaticEndpoint(facts, observed, declaredOrigins) {
  if (facts.candidate) return unknownItem(facts, "candidate-endpoint");
  const rpc = rpcReason(facts.mechanisms);
  if (rpc !== undefined) return unknownItem(facts, rpc);
  const parsed = parseStaticTarget(facts.value);
  if (parsed.kind === "ineligible") return unknownItem(facts, parsed.reason);
  const method = nodeMethod(facts.mechanisms);
  const target =
    parsed.kind === "absolute"
      ? { origin: parsed.origin, path: parsed.path, origin_basis: "literal" }
      : {
          origin: null,
          path: parsed.path,
          origin_basis: declaredOrigins.length > 0 ? "declared" : "undeclared",
        };
  if (target.origin_basis === "undeclared")
    // Same-shaped groups on any origin may be this path's requests; they are
    // unresolved rather than groups without a static counterpart.
    return {
      ...unknownItem(facts, "origin-undeclared", method, target),
      unresolved: observed.byShape.get(staticShapeKey(target.path)) ?? [],
    };
  const base = parsed.kind === "absolute" ? [parsed.origin] : declaredOrigins;
  const origins = [
    ...new Set(
      facts.mechanisms.flatMap((mechanism) =>
        base.map((origin) => requestOrigin(mechanism, origin)),
      ),
    ),
  ];
  const shape = staticShapeKey(target.path);
  // Without a group on its own origins, a target has no same-origin counterpart
  // to leave unresolved, whatever unknown reason follows.
  const candidates = origins.flatMap(
    (origin) => observed.byRoute.get(routeKey(origin, shape)) ?? [],
  );
  const inferredContext =
    target.origin_basis === "declared" || method.basis === "callee-name";
  const context = {
    static_node_id: facts.node.node_id,
    mechanisms: facts.mechanisms,
    method,
    target,
  };
  if (candidates.length === 0) {
    if (observed.coverageIncomplete)
      return unknownItem(facts, "observed-coverage-incomplete", method, target);
    if (origins.some((origin) => !observed.exercisedOrigins.has(origin)))
      return unknownItem(facts, "origin-not-exercised", method, target);
    return {
      item: { ...context, status: "not-observed-in-capture" },
      pairs: [],
      referenced: [],
      unresolved: [],
      inferred: inferredContext,
    };
  }
  const compatible =
    method.basis === "unknown"
      ? candidates
      : candidates.filter(({ method: value }) => method.values.includes(value));
  if (compatible.length === 0) {
    const pairs = pairsFor(candidates, target.path);
    return {
      item: { ...context, status: "ambiguous", reason: AMBIGUOUS_REASON },
      pairs,
      referenced: candidates,
      unresolved: [],
      inferred:
        inferredContext ||
        pairs.some(({ basis }) => basis === "template-compatible"),
    };
  }
  const pairs = pairsFor(compatible, target.path);
  const exact = pairs.some(({ basis }) => basis === "exact");
  return {
    item: {
      ...context,
      status: "matched",
      match_basis: exact ? "exact" : "template-compatible",
    },
    pairs,
    referenced: compatible,
    unresolved: [],
    inferred:
      inferredContext ||
      pairs.some(({ basis }) => basis === "template-compatible"),
  };
}
