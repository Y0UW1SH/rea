import type { WebNetworkApiSurfaceGroup } from "../analysisView/WebNetworkApiSurfaceAccumulator.js";
import { compareUnicodeCodePoints as compare } from "../unicodeCodePointOrder.js";
import type { JavaScriptApplicationGraph } from "./javascriptApplicationGraph.js";
import {
  type ENDPOINT_TRAFFIC_COLLECTIONS,
  ENDPOINT_TRAFFIC_UNKNOWN_REASONS,
  type EndpointTrafficComparisonResult,
  type EndpointTrafficStaticItem,
  type EndpointTrafficUnknownReason,
} from "./javascriptEndpointTrafficComparisonSchemas.js";
import {
  indexObservedGroups,
  networkEndpointFacts,
  nodeMethod,
  type NodeFacts,
  type ObservedIndex,
  pairingBasis,
  parseStaticTarget,
  requestOrigin,
  routeKey,
  staticShapeKey,
  type PairingBasis,
} from "./javascriptEndpointTrafficTargets.js";

/** Authenticated static graph and grouped HAR facts selected by the caller. */
export interface EndpointTrafficComparisonInput {
  readonly static: {
    readonly evidenceId: string;
    readonly rootArtifactSha256: string;
    readonly graph: JavaScriptApplicationGraph;
  };
  readonly observed: {
    readonly evidenceId: string;
    readonly artifact: {
      readonly path: string;
      readonly sha256: string | null;
    };
    /** Every api-surface group of the parent, in api-surface page order. */
    readonly groups: readonly WebNetworkApiSurfaceGroup[];
    readonly records: {
      readonly examined: number;
      readonly total: number;
      readonly excluded: number;
    };
    readonly limitations: readonly string[];
  };
  readonly origins: readonly string[];
  readonly collection: EndpointTrafficCollection;
  readonly offset: number;
  readonly limit: number;
}

/** Comparison result plus whether any reported decision rests on an inference. */
export interface EndpointTrafficComparison {
  readonly result: EndpointTrafficComparisonResult;
  readonly inferred: boolean;
}

type EndpointTrafficCollection = (typeof ENDPOINT_TRAFFIC_COLLECTIONS)[number];
type Method = Extract<
  EndpointTrafficStaticItem,
  { status: "matched" }
>["method"];
type Target = Extract<
  EndpointTrafficStaticItem,
  { status: "matched" }
>["target"];
/** A static item before its page assigns `observed` group indexes. */
type StaticItemDraft = EndpointTrafficStaticItem extends infer Item
  ? Item extends unknown
    ? Omit<Item, "observed">
    : never
  : never;
/** A pairing that still references its group; ordinals are copied per page. */
interface Pair {
  readonly group: WebNetworkApiSurfaceGroup;
  readonly basis: PairingBasis;
}

const FIXED_LIMITATIONS = [
  "Static endpoints are exact literal request targets; string-built, wrapper-passed and server-supplied URLs are absent, so an observed group without a static match does not establish missing or hidden code.",
  "not-observed-in-capture means only that this capture has no compatible request group; it does not establish that an endpoint is unused, hidden or unreachable.",
  "Paths compare as recorded, still-encoded text without dot-segment, case or trailing-slash normalization. A template-compatible pairing shares an api-surface route shape; the static literal path itself was not recorded.",
  "Methods inferred from callee names and origins joined from caller declarations are inferences; fetch, XMLHttpRequest, WebSocket and request-style calls keep an unknown method.",
  "Client route nodes, candidate values and GraphQL or tRPC operation names are never compared with request paths.",
] as const;

const pairsFor = (
  groups: readonly WebNetworkApiSurfaceGroup[],
  path: string,
): readonly Pair[] =>
  groups
    .map((group) => ({ group, basis: pairingBasis(group, path) }))
    .sort(
      (left, right) =>
        compare(left.group.origin, right.group.origin) ||
        compare(left.group.method, right.group.method),
    );

interface Classification {
  readonly item: StaticItemDraft;
  /** Matched or ambiguous pairings, materialized only for the selected page. */
  readonly pairs: readonly Pair[];
  /** Groups listed by a matched or ambiguous item. */
  readonly referenced: readonly WebNetworkApiSurfaceGroup[];
  /** Groups sharing the route shape of a path whose origin could not be joined. */
  readonly unresolved: readonly WebNetworkApiSurfaceGroup[];
  readonly inferred: boolean;
}

const unknownItem = (
  facts: NodeFacts,
  reason: EndpointTrafficUnknownReason,
  method: Method | null = null,
  target: Target | null = null,
): Classification => ({
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
const rpcReason = (
  mechanisms: readonly string[],
): EndpointTrafficUnknownReason | undefined => {
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

const classify = (
  facts: NodeFacts,
  observed: ObservedIndex,
  declaredOrigins: readonly string[],
): Classification => {
  if (facts.candidate) return unknownItem(facts, "candidate-endpoint");
  const rpc = rpcReason(facts.mechanisms);
  if (rpc !== undefined) return unknownItem(facts, rpc);
  const parsed = parseStaticTarget(facts.value);
  if (parsed.kind === "ineligible") return unknownItem(facts, parsed.reason);
  const method = nodeMethod(facts.mechanisms);
  const target: Target =
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
      item: {
        ...context,
        status: "ambiguous",
        reason: "method-inference-disagrees",
      },
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
};

/** Status and unknown-reason counts across every static item, not one page. */
const summarizeStaticItems = (items: readonly StaticItemDraft[]) => {
  const count = (status: StaticItemDraft["status"]) =>
    items.filter((item) => item.status === status).length;
  const reasons = new Map<EndpointTrafficUnknownReason, number>();
  for (const item of items)
    if (item.status === "unknown")
      reasons.set(item.reason, (reasons.get(item.reason) ?? 0) + 1);
  return {
    static_network_endpoints: items.length,
    matched: count("matched"),
    matched_exact: items.filter(
      (item) => item.status === "matched" && item.match_basis === "exact",
    ).length,
    ambiguous: count("ambiguous"),
    not_observed_in_capture: count("not-observed-in-capture"),
    unknown: count("unknown"),
    unknown_reasons: ENDPOINT_TRAFFIC_UNKNOWN_REASONS.flatMap((reason) => {
      const total = reasons.get(reason);
      return total === undefined ? [] : [{ reason, count: total }];
    }),
  };
};

const groupIdentity = (group: WebNetworkApiSurfaceGroup) => ({
  method: group.method,
  origin: group.origin,
  path_template: group.path_template,
  record_ordinals: [...group.record_ordinals],
});

/** Page one caller-selected collection; each collection has its own offsets. */
const selectedPage = (
  input: Pick<
    EndpointTrafficComparisonInput,
    "collection" | "offset" | "limit"
  >,
  {
    classifications,
    groups,
    unmatched,
    unresolved,
  }: {
    readonly classifications: readonly Classification[];
    readonly groups: readonly WebNetworkApiSurfaceGroup[];
    readonly unmatched: readonly WebNetworkApiSurfaceGroup[];
    readonly unresolved: ReadonlyMap<
      WebNetworkApiSurfaceGroup,
      readonly string[]
    >;
  },
) => {
  const end = input.offset + input.limit;
  const page = (total: number) => ({
    offset: input.offset,
    limit: input.limit,
    total,
    next_offset: end < total ? end : null,
  });
  if (input.collection === "observed-without-static-match")
    return {
      collection: input.collection,
      page: page(unmatched.length),
      items: unmatched.slice(input.offset, end).map(groupIdentity),
    };
  if (input.collection === "observed-unresolved") {
    // Keep api-surface order rather than static discovery order.
    const listed = groups.filter((group) => unresolved.has(group));
    return {
      collection: input.collection,
      page: page(listed.length),
      items: listed.slice(input.offset, end).map((group) => ({
        ...groupIdentity(group),
        reason: "origin-undeclared" as const,
        static_node_ids: [...new Set(unresolved.get(group))].sort(compare),
      })),
    };
  }
  return {
    collection: input.collection,
    page: page(classifications.length),
    ...staticEndpointPage(classifications.slice(input.offset, end)),
  };
};

/**
 * Materialize one static page. Each paired group appears once per page with its
 * record ordinals, so a page copies at most every examined record once however
 * many static items share a group.
 */
const staticEndpointPage = (selected: readonly Classification[]) => {
  const indexes = new Map<WebNetworkApiSurfaceGroup, number>();
  const paired: WebNetworkApiSurfaceGroup[] = [];
  const indexOf = (group: WebNetworkApiSurfaceGroup): number => {
    const known = indexes.get(group);
    if (known !== undefined) return known;
    indexes.set(group, paired.length);
    paired.push(group);
    return paired.length - 1;
  };
  const items = selected.map(({ item, pairs }): EndpointTrafficStaticItem => {
    const observed = pairs.map(({ group, basis }) => ({
      group: indexOf(group),
      basis,
    }));
    if (item.status === "matched" || item.status === "ambiguous")
      return { ...item, observed };
    return item;
  });
  return { items, paired_groups: paired.map(groupIdentity) };
};

const itemOrder = (
  { item: left }: Classification,
  { item: right }: Classification,
): number =>
  Number(left.target === null) - Number(right.target === null) ||
  compare(left.target?.origin ?? "", right.target?.origin ?? "") ||
  compare(left.target?.path ?? "", right.target?.path ?? "") ||
  compare(left.static_node_id, right.static_node_id);

/**
 * Pair static network endpoint literals with api-surface groups of one HAR
 * capture. Pairings name exact or template-compatible bases; nothing is paired
 * by similarity, prefix, case folding or cross-origin guesses.
 */
export const compareStaticAndObservedEndpoints = (
  input: EndpointTrafficComparisonInput,
): EndpointTrafficComparison => {
  const { graph } = input.static;
  const { groups, records } = input.observed;
  const observed = indexObservedGroups(input.observed);
  const classifications = graph.nodes
    .map(networkEndpointFacts)
    .filter((facts) => facts !== undefined)
    .map((facts) => classify(facts, observed, input.origins));
  const referenced = new Set(
    classifications.flatMap((classification) => classification.referenced),
  );
  // A group listed by both a matched and an ambiguous item counts as matched.
  const matchedGroups = new Set(
    classifications.flatMap(({ item, referenced: groups }) =>
      item.status === "matched" ? groups : [],
    ),
  );
  const unresolvedBy = new Map<WebNetworkApiSurfaceGroup, string[]>();
  for (const { item, unresolved } of classifications)
    for (const group of unresolved) {
      if (referenced.has(group)) continue;
      const nodes = unresolvedBy.get(group);
      if (nodes === undefined) unresolvedBy.set(group, [item.static_node_id]);
      else nodes.push(item.static_node_id);
    }
  const unmatched = groups.filter(
    (group) => !referenced.has(group) && !unresolvedBy.has(group),
  );
  const ordered = [...classifications].sort(itemOrder);
  const staticCoverage = graph.coverage.status;
  const limitations = [
    ...new Set([
      ...FIXED_LIMITATIONS,
      ...(staticCoverage === "complete"
        ? []
        : [
            `Static graph coverage is ${staticCoverage}; endpoints in omitted or unavailable files are absent from this comparison.`,
          ]),
      ...input.observed.limitations,
    ]),
  ];
  return {
    result: {
      static: {
        evidence_id: input.static.evidenceId,
        graph_id: graph.graph_id,
        root_artifact_sha256: input.static.rootArtifactSha256,
      },
      observed: {
        evidence_id: input.observed.evidenceId,
        artifact: {
          path: input.observed.artifact.path,
          sha256: input.observed.artifact.sha256,
        },
      },
      declared_origins: [...input.origins],
      summary: {
        ...summarizeStaticItems(ordered.map(({ item }) => item)),
        observed_groups: groups.length,
        observed_matched: matchedGroups.size,
        observed_ambiguous: referenced.size - matchedGroups.size,
        observed_unresolved: unresolvedBy.size,
        observed_without_static_match: unmatched.length,
      },
      ...selectedPage(input, {
        classifications: ordered,
        groups,
        unmatched,
        unresolved: unresolvedBy,
      }),
      coverage: {
        static_graph: staticCoverage,
        observed_records: { ...records },
      },
      evidence_links: [input.static.evidenceId, input.observed.evidenceId],
      limitations,
    },
    // Every page carries the whole comparison's inference, as api-surface does.
    inferred:
      groups.some(({ templated_segments }) => templated_segments.length > 0) ||
      classifications.some((classification) => classification.inferred),
  };
};
