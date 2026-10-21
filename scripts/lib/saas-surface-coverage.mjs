import { admitReport } from "./saas-export-budget.mjs";
import { compareCodePoints, sortCodePoints } from "./saas-ordering.mjs";
import {
  SURFACE_FAMILIES,
  graphqlItem,
  groupEvidence,
  item,
  nodeKey,
  routeItem,
  trpcBases,
  trpcItem,
  undeclaredEntries,
} from "./saas-surface-families.mjs";
import { readStaticAnalysis, validateOrigins } from "./saas-surface-inputs.mjs";
import {
  ENDPOINT_TRAFFIC_UNKNOWN_REASONS,
  classifyStaticEndpoint,
  indexObservedGroups,
  networkEndpointFacts,
} from "./saas-surface-matching.mjs";
import { readObservedInput } from "./saas-surface-observed.mjs";
import {
  buildExperiments,
  mergeProfile,
  surfaceLimitations,
} from "./saas-surface-report.mjs";

// Reconcile the frontend bundle's declared API and route surface with observed traffic.
// Network endpoints use the 3591 port verbatim; the other families live in
// saas-surface-families.mjs. Observed traffic no static item explains is reported as
// undeclared, never as missing code; any incompleteness turns absence into unknown.

export { SURFACE_FAMILIES };
export const SURFACE_STATUSES = Object.freeze([
  "exact",
  "templated",
  "ambiguous",
  "unmatched",
  "unknown",
]);
export const SURFACE_UNKNOWN_REASONS = Object.freeze([
  ...ENDPOINT_TRAFFIC_UNKNOWN_REASONS,
  "target-unresolved",
  "rpc-bodies-not-retained",
  "rpc-link-base-undeclared",
  "route-pattern-unsupported",
  "graphql-transport-unresolved",
]);
const STATUS_RANK = {
  exact: 0,
  templated: 1,
  ambiguous: 2,
  unmatched: 3,
  unknown: 4,
};
const EXERCISED = new Set(["exact", "templated"]);

/** Which family a declared endpoint node belongs to, with the facts the port reads. */
function familyOf(endpoint) {
  const facts = networkEndpointFacts(endpoint.node);
  if (facts === undefined) {
    const routes = endpoint.node.observations.filter(
      ({ properties }) => properties.endpoint_kind === "route",
    );
    if (routes.length === 0) return null;
    return {
      family: "route",
      value: routes[0].properties.value,
      mechanisms: sortCodePoints(
        new Set(routes.map(({ properties }) => properties.mechanism)),
      ),
    };
  }
  const partial = endpoint.node.observations
    .filter(({ properties }) => properties.endpoint_kind === "network")
    .every(({ properties }) => properties.resolution === "partial");
  const has = (prefix) =>
    facts.mechanisms.some((mechanism) => mechanism.startsWith(prefix));
  const family = partial
    ? "network"
    : has("graphql:")
      ? "graphql"
      : has("trpc:procedure:")
        ? "trpc"
        : has("trpc:link:")
          ? "link"
          : "network";
  return {
    family,
    value: facts.value,
    mechanisms: facts.mechanisms,
    facts,
    partial,
  };
}

const ownerStatus = (owner) =>
  owner.status === "matched"
    ? owner.match_basis === "exact"
      ? "exact"
      : "templated"
    : owner.status === "ambiguous"
      ? "ambiguous"
      : owner.status === "not-observed-in-capture"
        ? "unmatched"
        : "unknown";

function networkItem(endpoint, detected, context) {
  if (detected.partial)
    return item(endpoint, "unknown", {
      family: "network",
      key: nodeKey(endpoint.node.node_id),
      reason: "target-unresolved",
      method: null,
      target: null,
      inferences: [],
      mechanisms: detected.mechanisms,
    });
  const classification = classifyStaticEndpoint(
    detected.facts,
    context.index,
    context.origins.declared_origins,
  );
  const owner = classification.item;
  for (const group of classification.referenced) context.referenced.add(group);
  for (const group of classification.unresolved) {
    const nodes = context.unresolved.get(group) ?? [];
    nodes.push(endpoint.node.node_id);
    context.unresolved.set(group, nodes);
  }
  const inferences = [];
  if (owner.target?.origin_basis === "declared")
    inferences.push("origin-declared");
  if (owner.method?.basis === "callee-name")
    inferences.push("method-callee-name");
  if (classification.pairs.some(({ basis }) => basis === "template-compatible"))
    inferences.push("template-compatible");
  return item(endpoint, ownerStatus(owner), {
    family: "network",
    key:
      owner.target === null
        ? nodeKey(endpoint.node.node_id)
        : `${owner.method.values.join("|") || "*"} ${owner.target.origin ?? ""}${owner.target.path}`,
    ...(owner.reason === undefined ? {} : { reason: owner.reason }),
    method: owner.method,
    target: owner.target,
    inferences,
    mechanisms: detected.mechanisms,
    observed: classification.pairs.map(({ group, basis }) =>
      groupEvidence(group, basis),
    ),
  });
}

/** Fold a 3591 comparison verdict into a network item; a better verdict replaces, an equal one adds evidence. */
function applyComparison(items, observed, context) {
  const { comparison } = observed;
  const byNode = new Map(
    items.map((entry) => [entry.evidence.static.node_id, entry]),
  );
  for (const verdict of comparison.items) {
    const target = byNode.get(verdict.static_node_id);
    if (target === undefined || target.family !== "network") continue;
    let status = ownerStatus(verdict);
    let reason = verdict.reason;
    // A complete comparison cannot prove absence when another input is incomplete.
    if (status === "unmatched" && context.coverageIncomplete) {
      status = "unknown";
      reason = "observed-coverage-incomplete";
    }
    const evidence = verdict.observed.map(({ group, basis }) => ({
      input: observed.input,
      kind: "endpoint-traffic-comparison",
      ...comparison.paired_groups[group],
      basis,
    }));
    // Items classified against no group input hold a placeholder until the first
    // verdict; after that only a better-ranked verdict replaces, an equal one adds
    // evidence, a worse one changes nothing, whatever the input order.
    const provisional = !context.hasGroupInputs && !context.adopted.has(target);
    if (provisional || STATUS_RANK[status] < STATUS_RANK[target.status]) {
      target.status = status;
      if (reason === undefined) delete target.reason;
      else target.reason = reason;
      if (verdict.method !== null) target.method = verdict.method;
      if (verdict.target !== null) target.target = verdict.target;
      if (
        status === "templated" &&
        !target.inferences.includes("template-compatible")
      )
        target.inferences.push("template-compatible");
      target.evidence.observed = evidence;
      context.adopted.add(target);
    } else if (STATUS_RANK[status] === STATUS_RANK[target.status])
      target.evidence.observed.push(...evidence);
  }
}

function buildContext(analysis, inputs) {
  const origins = validateOrigins(inputs.origins);
  const observed = inputs.observed.map((entry, input) => ({
    ...readObservedInput(entry.value, `observed[${input}]`),
    input,
    file: entry.file,
    sha256: entry.sha256,
  }));
  if (observed.length === 0)
    throw new Error("observed: expected at least one input");
  const folded = (entries, extra) =>
    entries.map((entry) => ({
      ...entry,
      origin: origins.fold(entry.origin),
      ...extra,
    }));
  const groups = observed.flatMap((entry) =>
    folded(
      entry.groups.map((group) => ({
        ...group,
        recorded_origin: group.origin,
      })),
      { input: entry.input, kind: entry.kind },
    ),
  );
  const records = observed.reduce(
    (sum, entry) => ({
      examined: sum.examined + entry.records.examined,
      total: sum.total + entry.records.total,
      excluded: sum.excluded + entry.records.excluded,
    }),
    { examined: 0, total: 0, excluded: 0 },
  );
  const index = indexObservedGroups({ groups, records });
  const incomplete = (entry) => entry.incompleteness.length > 0;
  const coverageIncomplete =
    index.coverageIncomplete || observed.some(incomplete);
  for (const entry of observed)
    if (
      entry.comparison !== null &&
      entry.comparison.static.root_artifact_sha256 !==
        analysis.root_artifact_sha256
    )
      throw new Error(
        `observed[${entry.input}]: comparison static.root_artifact_sha256 differs from the static input`,
      );
  return {
    static: analysis,
    origins,
    observed,
    groups,
    index: { ...index, coverageIncomplete },
    coverageIncomplete,
    navigationCoverageIncomplete: observed.some(
      (entry) => entry.kind === "scenario-capture" && incomplete(entry),
    ),
    hasGroupInputs: observed.some((entry) => entry.comparison === null),
    // GraphQL absence needs every input to have carried request bodies, untruncated.
    bodiesRetained: observed.every((entry) => entry.bodiesRetained),
    bodiesTruncated: observed.some(
      (entry) => entry.body_incompleteness.length > 0,
    ),
    adopted: new Set(),
    operations: observed.flatMap((entry) =>
      folded(entry.operations, { input: entry.input }),
    ),
    navigations: observed.flatMap((entry) =>
      folded(entry.navigations, { input: entry.input }),
    ),
    referenced: new Set(),
    unresolved: new Map(),
    matchedNavigations: new Set(),
  };
}

function classifyAll(analysis, context) {
  const detected = analysis.endpoints
    .map((endpoint) => ({ endpoint, found: familyOf(endpoint) }))
    .filter(({ found }) => found !== null);
  const trpc = trpcBases(
    detected
      .filter(({ found }) => found.family === "link")
      .map(({ endpoint, found }) => ({
        node: endpoint.node,
        value: found.value,
      })),
    context,
  );
  const items = detected
    .filter(({ found }) => found.family !== "link")
    .map(({ endpoint, found }) =>
      found.family === "network"
        ? networkItem(endpoint, found, context)
        : found.family === "trpc"
          ? trpcItem(endpoint, found, context, trpc)
          : found.family === "graphql"
            ? graphqlItem(endpoint, found, context)
            : routeItem(endpoint, found, context),
    );
  for (const observed of context.observed)
    if (observed.comparison?.collection === "static-endpoints")
      applyComparison(items, observed, context);
  for (const entry of items)
    entry.confidence = EXERCISED.has(entry.status)
      ? entry.status === "exact" && entry.inferences.length === 0
        ? "high"
        : "medium"
      : "low";
  items.sort(
    (left, right) =>
      SURFACE_FAMILIES.indexOf(left.family) -
        SURFACE_FAMILIES.indexOf(right.family) ||
      compareCodePoints(left.key, right.key) ||
      compareCodePoints(
        left.evidence.static.node_id,
        right.evidence.static.node_id,
      ),
  );
  return { items, trpc };
}

function summarize(items) {
  const summary = {};
  for (const family of SURFACE_FAMILIES) {
    const own = items.filter((entry) => entry.family === family);
    summary[family] = {
      declared: own.length,
      ...Object.fromEntries(
        SURFACE_STATUSES.map((status) => [
          status,
          own.filter((entry) => entry.status === status).length,
        ]),
      ),
    };
  }
  const reasons = new Map();
  for (const entry of items)
    if (entry.status === "unknown")
      reasons.set(entry.reason, (reasons.get(entry.reason) ?? 0) + 1);
  summary.unknown_reasons = sortCodePoints(reasons.keys()).map((reason) => ({
    reason,
    count: reasons.get(reason),
  }));
  return summary;
}

const reportInputs = (inputs, analysis, context, workflowId) => ({
  static: {
    file: inputs.static.file,
    sha256: inputs.static.sha256,
    root_artifact_sha256: analysis.root_artifact_sha256,
    graph_id: analysis.graph_id,
    coverage: analysis.coverage,
    nodes: analysis.nodes,
    endpoint_nodes: analysis.endpoints.length,
  },
  observed: context.observed.map((entry) => ({
    file: entry.file,
    sha256: entry.sha256,
    kind: entry.kind,
    groups: entry.groups.length,
    records: entry.records,
    operations: entry.operations.length,
    navigations: entry.navigations.length,
    complete: entry.incompleteness.length === 0,
    incompleteness: entry.incompleteness,
    body_incompleteness: entry.body_incompleteness,
  })),
  origins: {
    declared_origins: context.origins.declared_origins,
    origin_pairs: context.origins.origin_pairs,
  },
  ...(inputs.profile === undefined
    ? {}
    : {
        profile: {
          file: inputs.profile.file,
          sha256: inputs.profile.sha256,
          workflowId,
        },
      }),
});

/** Reconcile parsed inputs into one report; `invalid` keeps the reason. */
export function reconcileSurface(inputs) {
  try {
    const analysis = readStaticAnalysis(inputs.static.value, "static");
    const context = buildContext(analysis, inputs);
    const { items, trpc } = classifyAll(analysis, context);
    const workflowId = inputs.workflowId ?? "surface-coverage";
    const { experiments, experimentPriorities } = buildExperiments(
      items,
      workflowId,
      context.origins.declared_origins,
    );
    const complete =
      analysis.coverage.status === "complete" &&
      context.observed.every((entry) => entry.incompleteness.length === 0);
    return admitReport({
      version: 1,
      status: complete ? "complete" : "partial",
      inputs: reportInputs(inputs, analysis, context, workflowId),
      declared: Object.fromEntries(
        SURFACE_FAMILIES.map((family) => [
          family,
          items.filter((entry) => entry.family === family).length,
        ]),
      ),
      surface: items,
      undeclared_observed: undeclaredEntries(context, items, trpc),
      summary: summarize(items),
      gaps: items.filter((entry) => !EXERCISED.has(entry.status)).length,
      experiments,
      experimentPriorities,
      ...(inputs.profile === undefined
        ? {}
        : {
            profileUpdate: mergeProfile(
              inputs.profile.value,
              workflowId,
              experiments,
            ),
          }),
      limitations: surfaceLimitations(analysis, context, items, trpc),
    });
  } catch (error) {
    return {
      version: 1,
      status: "invalid",
      reason:
        error instanceof Error ? error.message : "Surface coverage failed",
    };
  }
}
