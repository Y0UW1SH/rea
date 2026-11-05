import { compareCodePoints, sortCodePoints } from "./saas-ordering.mjs";
import { parseStaticTarget } from "./saas-surface-matching.mjs";

// The non-network families of the surface-coverage companion and the undeclared
// aggregation. GraphQL operations match only retained request bodies, tRPC procedures
// only path segments after a declared link base, client routes only navigation
// pathnames on the declared origins. Nothing here is paired by similarity.

export const SURFACE_FAMILIES = Object.freeze([
  "network",
  "trpc",
  "graphql",
  "route",
]);
const groupIdentity = (group) =>
  `${group.method}\u0000${group.origin}\u0000${group.path_template}`;
/** Target-less items are keyed by the whole node id so two of them never share an experiment. */
export const nodeKey = (nodeId) => `node:${nodeId}`;

/** One surface item; `extra` carries family fields plus the static mechanisms and observed evidence. */
export function item(endpoint, status, extra) {
  const { family, key, mechanisms, observed = [], ...fields } = extra;
  return {
    family,
    key,
    status,
    ...fields,
    evidence: {
      static: {
        node_id: endpoint.node.node_id,
        artifact_sha256: endpoint.artifact_sha256,
        mechanisms,
        locations: endpoint.locations,
      },
      observed,
    },
  };
}

/** Evidence copied from one observed group: identity plus ordinals or transactions. */
export function groupEvidence(group, basis) {
  return {
    input: group.input,
    kind: group.kind,
    method: group.method,
    origin: group.origin,
    ...(group.recorded_origin === group.origin
      ? {}
      : { recorded_origin: group.recorded_origin }),
    path_template: group.path_template,
    ...(basis === undefined ? {} : { basis }),
    ...(group.kind === "api-surface"
      ? { record_ordinals: group.record_ordinals }
      : { transactions: group.transactions }),
  };
}

function operationEvidence(operations) {
  const entries = new Map();
  for (const operation of operations) {
    const key = `${operation.input}\u0000${graphqlIdentity(operation)}`;
    const entry = entries.get(key) ?? {
      input: operation.input,
      kind: "scenario-capture",
      method: operation.method,
      origin: operation.origin,
      path_template: operation.path_template,
      endpoint_path: operation.endpoint_path,
      document_sha256: operation.document_sha256,
      persisted_query_sha256: operation.persisted_query_sha256,
      transactions: [],
    };
    entry.transactions.push({
      transaction_id: operation.transaction_id,
      step_id: operation.step_id,
      status: operation.status,
    });
    entries.set(key, entry);
  }
  return [...entries.values()];
}

/** Link bases: absolute or declared-origin paths that tRPC procedures are served under. */
export function trpcBases(links, context) {
  const bases = [];
  for (const link of links) {
    const parsed = parseStaticTarget(link.value);
    if (parsed.kind === "ineligible") continue;
    bases.push({
      node_id: link.node.node_id,
      path: parsed.path,
      origins:
        parsed.kind === "absolute"
          ? [parsed.origin]
          : context.origins.declared_origins,
      declared: parsed.kind === "relative",
    });
  }
  const observed = [];
  for (const group of context.groups)
    for (const base of bases) {
      if (!base.origins.includes(group.origin)) continue;
      const nested = group.path_template.startsWith(`${base.path}/`);
      if (!nested && group.path_template !== base.path) continue;
      const remainder = nested
        ? group.path_template.slice(base.path.length + 1)
        : "";
      observed.push({
        group,
        base,
        procedures: remainder === "" ? [] : remainder.split(","),
      });
    }
  return { bases, observed };
}

export function trpcItem(endpoint, detected, context, trpc) {
  const mechanism = detected.mechanisms.find((value) =>
    value.startsWith("trpc:procedure:"),
  );
  const method = mechanism.slice("trpc:procedure:".length);
  const matches = trpc.observed.filter(({ procedures }) =>
    procedures.includes(detected.value),
  );
  const extra = {
    family: "trpc",
    key: `${method} ${detected.value}`,
    procedure: { path: detected.value, method },
    inferences: matches.some(({ base }) => base.declared)
      ? ["origin-declared"]
      : [],
    mechanisms: detected.mechanisms,
    observed: matches.map(({ group }) => groupEvidence(group)),
  };
  if (matches.length > 0) {
    for (const { group } of matches) context.referenced.add(group);
    return item(endpoint, "exact", extra);
  }
  const exercised = trpc.bases.some((base) =>
    base.origins.some((origin) => context.index.exercisedOrigins.has(origin)),
  );
  const reason =
    trpc.bases.length === 0
      ? "rpc-link-base-undeclared"
      : trpc.bases.every((base) => base.origins.length === 0)
        ? "origin-undeclared"
        : context.coverageIncomplete
          ? "observed-coverage-incomplete"
          : exercised
            ? null
            : "origin-not-exercised";
  return reason === null
    ? item(endpoint, "unmatched", extra)
    : item(endpoint, "unknown", { reason, ...extra });
}

export function graphqlItem(endpoint, detected, context) {
  const mechanism = detected.mechanisms.find((value) =>
    value.startsWith("graphql:"),
  );
  const type = mechanism.slice("graphql:".length);
  const declared = context.origins.declared_origins;
  const matches = context.operations.filter(
    ({ name, origin }) => name === detected.value && declared.includes(origin),
  );
  const extra = {
    family: "graphql",
    key: `${type} ${detected.value}`,
    operation: { type, name: detected.value },
    inferences: [],
    mechanisms: detected.mechanisms,
    observed: operationEvidence(matches),
  };
  // The static producer records operation names, not a document-to-transport
  // association. Even a unique name on a declared origin is only a candidate.
  // Do not infer its endpoint from the traffic we are trying to measure.
  if (new Set(matches.map(graphqlIdentity)).size > 1)
    return item(endpoint, "ambiguous", {
      reason: "graphql-operation-ambiguous",
      ...extra,
    });
  const reason =
    matches.length > 0
      ? "graphql-transport-unresolved"
      : !context.bodiesRetained || context.bodiesTruncated
        ? "rpc-bodies-not-retained"
        : context.coverageIncomplete
          ? "observed-coverage-incomplete"
          : declared.length === 0
            ? "origin-undeclared"
            : declared.some((origin) =>
                  context.index.exercisedOrigins.has(origin),
                )
              ? "graphql-transport-unresolved"
              : "origin-not-exercised";
  return item(endpoint, "unknown", { reason, ...extra });
}

const graphqlIdentity = (operation) =>
  JSON.stringify([
    operation.origin,
    operation.method,
    operation.endpoint_path,
    operation.type,
    operation.name,
    operation.document_sha256,
    operation.persisted_query_sha256,
  ]);

/** Static route patterns: `:id`, `[id]`, `{id}` and `*` take one segment; `**` and `[...rest]` the rest. */
function routePattern(value) {
  if (/[?#]/u.test(value))
    return { kind: "ineligible", reason: "route-pattern-unsupported" };
  if (!value.startsWith("/"))
    return {
      kind: "ineligible",
      reason:
        value === ""
          ? "value-not-url-or-path"
          : "relative-reference-base-unknown",
    };
  const segments = value
    .slice(1)
    .split("/")
    .map((segment) => {
      if (segment === "**" || /^\[\.\.\..+\]$/u.test(segment))
        return { kind: "rest" };
      if (
        segment === "*" ||
        /^:[^/?*]+$/u.test(segment) ||
        /^\[[^/]+\]$/u.test(segment) ||
        /^\{[^/]+\}$/u.test(segment)
      )
        return { kind: "param" };
      if (/[()?*:]/u.test(segment)) return { kind: "unsupported" };
      return { kind: "literal", value: segment };
    });
  if (segments.some(({ kind }) => kind === "unsupported"))
    return { kind: "ineligible", reason: "route-pattern-unsupported" };
  return {
    kind: "pattern",
    segments,
    parameterized: segments.some(({ kind }) => kind !== "literal"),
  };
}

function matchesRoute(pattern, path) {
  const segments = path.slice(1).split("/");
  for (const [index, expected] of pattern.segments.entries()) {
    if (expected.kind === "rest") return true;
    const actual = segments[index];
    if (actual === undefined || actual === "") return false;
    if (expected.kind === "literal" && expected.value !== actual) return false;
  }
  return segments.length === pattern.segments.length;
}

export function routeItem(endpoint, detected, context) {
  const pattern = routePattern(detected.value);
  // An ineligible literal is never echoed: it is keyed by its node like a
  // target-less network item.
  if (pattern.kind === "ineligible")
    return item(endpoint, "unknown", {
      family: "route",
      key: nodeKey(endpoint.node.node_id),
      reason: pattern.reason,
      inferences: [],
      mechanisms: detected.mechanisms,
    });
  const base = {
    family: "route",
    key: detected.value,
    route: { pattern: detected.value },
    inferences: [],
    mechanisms: detected.mechanisms,
  };
  const declared = context.origins.declared_origins;
  if (declared.length === 0)
    return item(endpoint, "unknown", { reason: "origin-undeclared", ...base });
  const navigations = context.navigations.filter(({ origin }) =>
    declared.includes(origin),
  );
  const exact = navigations.filter(({ path }) => path === detected.value);
  const templated =
    exact.length === 0 && pattern.parameterized
      ? navigations.filter(({ path }) => matchesRoute(pattern, path))
      : [];
  const matched = exact.length > 0 ? exact : templated;
  for (const navigation of matched) context.matchedNavigations.add(navigation);
  const observed = matched.map((navigation) => ({
    input: navigation.input,
    kind: "scenario-capture",
    origin: navigation.origin,
    path: navigation.path,
    steps: navigation.steps,
  }));
  if (matched.length > 0)
    return item(endpoint, exact.length > 0 ? "exact" : "templated", {
      ...base,
      inferences:
        exact.length > 0
          ? ["origin-declared"]
          : ["origin-declared", "route-pattern"],
      observed,
    });
  const reason =
    navigations.length === 0
      ? "origin-not-exercised"
      : context.navigationCoverageIncomplete
        ? "observed-coverage-incomplete"
        : null;
  return reason === null
    ? item(endpoint, "unmatched", base)
    : item(endpoint, "unknown", { reason, ...base });
}

const entryName = (entry) =>
  entry.path_template ?? entry.procedure ?? entry.operation ?? entry.path;
const entryOrder = (left, right) =>
  SURFACE_FAMILIES.indexOf(left.family) -
    SURFACE_FAMILIES.indexOf(right.family) ||
  compareCodePoints(left.origin, right.origin) ||
  compareCodePoints(entryName(left), entryName(right)) ||
  compareCodePoints(left.method ?? "", right.method ?? "") ||
  compareCodePoints(left.endpoint_path ?? "", right.endpoint_path ?? "") ||
  compareCodePoints(left.type ?? "", right.type ?? "") ||
  compareCodePoints(left.document_sha256 ?? "", right.document_sha256 ?? "") ||
  compareCodePoints(
    left.persisted_query_sha256 ?? "",
    right.persisted_query_sha256 ?? "",
  );

function comparisonEntries(add, observed) {
  const { comparison } = observed;
  for (const group of comparison.items)
    add(
      "network",
      groupIdentity(group),
      {
        method: group.method,
        origin: group.origin,
        path_template: group.path_template,
        ...(comparison.collection === "observed-unresolved"
          ? {
              reason: "origin-undeclared",
              static_node_ids: group.static_node_ids,
            }
          : {}),
      },
      [
        {
          input: observed.input,
          kind: "endpoint-traffic-comparison",
          record_ordinals: group.record_ordinals,
        },
      ],
    );
}

/** Observed traffic no static item explains, aggregated by identity across inputs. */
export function undeclaredEntries(context, items, trpc) {
  const entries = new Map();
  const add = (family, identity, fields, evidence) => {
    const key = `${family}\u0000${identity}`;
    const entry = entries.get(key) ?? { family, ...fields, evidence: [] };
    entry.evidence.push(...evidence);
    entries.set(key, entry);
  };
  const declared = (family, name) =>
    new Set(
      items
        .filter((entry) => entry.family === family)
        .map((entry) => name(entry)),
    );
  const procedures = declared("trpc", (entry) => entry.procedure.path);
  const transports = new Set(context.operations.map(groupIdentity));
  const claimed = new Set(trpc.observed.map(({ group }) => group));
  for (const group of context.groups) {
    if (
      context.referenced.has(group) ||
      claimed.has(group) ||
      transports.has(groupIdentity(group))
    )
      continue;
    const unresolved = context.unresolved.get(group);
    add(
      "network",
      groupIdentity(group),
      {
        method: group.method,
        origin: group.origin,
        path_template: group.path_template,
        ...(unresolved === undefined
          ? {}
          : {
              reason: "origin-undeclared",
              static_node_ids: sortCodePoints(new Set(unresolved)),
            }),
      },
      [groupEvidence(group)],
    );
  }
  for (const { group, procedures: observed } of trpc.observed)
    for (const procedure of observed)
      if (!procedures.has(procedure))
        add(
          "trpc",
          `${group.origin}\u0000${procedure}`,
          { origin: group.origin, procedure },
          [groupEvidence(group)],
        );
  // No current static GraphQL declaration establishes transport identity.
  // Keep these observations visible even when a same-name candidate was shown.
  for (const operation of context.operations)
    add(
      "graphql",
      graphqlIdentity(operation),
      {
        origin: operation.origin,
        method: operation.method,
        endpoint_path: operation.endpoint_path,
        document_sha256: operation.document_sha256,
        persisted_query_sha256: operation.persisted_query_sha256,
        operation: operation.name,
        type: operation.type,
      },
      operationEvidence([operation]),
    );
  for (const navigation of context.navigations)
    if (
      context.origins.declared_origins.includes(navigation.origin) &&
      !context.matchedNavigations.has(navigation)
    )
      add(
        "route",
        `${navigation.origin}\u0000${navigation.path}`,
        { origin: navigation.origin, path: navigation.path },
        [
          {
            input: navigation.input,
            kind: "scenario-capture",
            steps: navigation.steps,
          },
        ],
      );
  for (const observed of context.observed)
    if (
      observed.comparison !== null &&
      observed.comparison.collection !== "static-endpoints"
    )
      comparisonEntries(add, observed);
  return [...entries.values()].sort(entryOrder);
}
