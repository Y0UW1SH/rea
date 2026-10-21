import { graphqlDocumentIdentity } from "./saas-graphql.mjs";
import { classifyBody } from "./saas-api-contract-admission.mjs";
import { compareCodePoints, sortCodePoints } from "./saas-ordering.mjs";
import { recordedPath, routeTemplate } from "./saas-route-templates.mjs";
import {
  assembleTransactions,
  validateScenarioCapture,
} from "./saas-scenario-capture.mjs";
import {
  SURFACE_LIMITS,
  apiSurfaceObserved,
  count,
  hex,
  list,
  object,
  plain,
  records,
  strings,
  text,
} from "./saas-surface-inputs.mjs";
import {
  ENDPOINT_TRAFFIC_UNKNOWN_REASONS,
  METHOD_BASES,
  ORIGIN_BASES,
  PAIRING_BASES,
  STATIC_ITEM_STATUSES,
} from "./saas-surface-matching.mjs";

// Observed-input readers of the surface-coverage companion. Every shape becomes the
// same record: api-surface-style groups plus, for captures, GraphQL operations from
// retained request bodies and navigation pathnames; a 3591 comparison result keeps its
// verdicts. Dispatch is by shape; anything else fails closed.

const COLLECTIONS = [
  "static-endpoints",
  "observed-without-static-match",
  "observed-unresolved",
];
const OPERATION = /(query|mutation|subscription)\s+([_A-Za-z][_0-9A-Za-z]*)/u;
const NAME = /^[_A-Za-z][_0-9A-Za-z]*$/u;

/** Named GraphQL operations in one retained JSON request body (single or batched). */
function graphqlOperations(buffer) {
  let parsed;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(buffer),
    );
  } catch {
    return [];
  }
  const operations = [];
  for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
    if (!plain(item)) continue;
    const query = typeof item.query === "string" ? item.query : null;
    // Only names in the GraphQL grammar are read, so captured text never reaches
    // a pattern or a report; anything else counts as unnamed. A persisted query
    // carries operationName without query text.
    const declared =
      typeof item.operationName === "string" && NAME.test(item.operationName)
        ? item.operationName
        : null;
    if (declared === null && query === null) continue;
    const named =
      query === null
        ? null
        : declared === null
          ? OPERATION.exec(query)
          : new RegExp(
              `(query|mutation|subscription)\\s+${declared}(?![_0-9A-Za-z])`,
              "u",
            ).exec(query);
    const name = declared ?? named?.[2] ?? null;
    if (name !== null)
      operations.push({
        type: named?.[1] ?? null,
        name,
        ...graphqlDocumentIdentity(item),
      });
  }
  return operations;
}

function addNavigation(navigations, sanitized, stepId) {
  if (
    !plain(sanitized) ||
    typeof sanitized.url !== "string" ||
    sanitized.redacted === true
  )
    return;
  const line = recordedPath(sanitized.url);
  if (line === null) return;
  const key = `${line.origin}\u0000${line.path}`;
  const entry = navigations.get(key) ?? {
    origin: line.origin,
    path: line.path,
    steps: [],
  };
  if (!entry.steps.includes(stepId)) entry.steps.push(stepId);
  navigations.set(key, entry);
}

function captureNavigations(capture, at) {
  const navigations = new Map();
  for (const [index, step] of capture.steps.entries()) {
    addNavigation(navigations, step.before_url, step.step_id);
    addNavigation(navigations, step.after_url, step.step_id);
    const history = step.artifacts?.history;
    if (!plain(history) || history.state !== "captured") continue;
    const where = `${at}.steps[${index}].artifacts.history.value`;
    object(history.value, where);
    list(history.value.navigation_entries, `${where}.navigation_entries`);
    addNavigation(navigations, history.value.current_url, step.step_id);
    for (const entry of history.value.navigation_entries)
      addNavigation(navigations, entry?.name, step.step_id);
  }
  return [...navigations.values()].sort(
    (left, right) =>
      compareCodePoints(left.origin, right.origin) ||
      compareCodePoints(left.path, right.path),
  );
}

function captureIncompleteness(capture, excluded) {
  const reasons = [];
  if (capture.events.dropped > 0)
    reasons.push(`events.dropped = ${capture.events.dropped}`);
  if (capture.completeness.status !== "complete")
    reasons.push(`completeness.status = ${capture.completeness.status}`);
  const omissions = capture.events.omissions;
  if (
    plain(omissions) &&
    ((Array.isArray(omissions.by_kind) && omissions.by_kind.length > 0) ||
      (Array.isArray(omissions.network_transactions) &&
        omissions.network_transactions.length > 0) ||
      (omissions.network_transaction_range !== undefined &&
        omissions.network_transaction_range !== null))
  )
    reasons.push("events.omissions present");
  for (const step of capture.steps) {
    if (step.status !== undefined && step.status !== "completed")
      reasons.push(`step ${step.step_id} is ${String(step.status)}`);
    if (plain(step.completeness) && step.completeness.status !== "complete")
      reasons.push(
        `step ${step.step_id} completeness is ${String(step.completeness.status)}`,
      );
  }
  if (excluded > 0)
    reasons.push(
      `${excluded} transaction(s) excluded (unavailable, redacted or unparseable request line)`,
    );
  return reasons;
}

/** Group one admitted transaction by method, origin and route template. */
function recordTransaction(groups, ordinal, transaction, line) {
  const route = routeTemplate(line.path);
  const key = `${transaction.method}\u0000${line.origin}\u0000${route.template}`;
  const group = groups.get(key) ?? {
    method: transaction.method,
    origin: line.origin,
    path_template: route.template,
    segments: new Map(),
    record_ordinals: [],
    statuses: new Set(),
    resource_types: new Set(),
    transactions: [],
  };
  for (const segment of route.segments) {
    const entry = group.segments.get(segment.segment_index) ?? {
      rule: segment.rule,
      values: new Set(),
    };
    entry.values.add(segment.value);
    group.segments.set(segment.segment_index, entry);
  }
  group.record_ordinals.push(ordinal);
  if (transaction.status !== null) group.statuses.add(transaction.status);
  group.resource_types.add(transaction.resource_type);
  group.transactions.push({
    transaction_id: transaction.transaction_id,
    step_id: transaction.step_id,
    status: transaction.status,
  });
  groups.set(key, group);
  return route.template;
}

const finishGroup = (group) => ({
  method: group.method,
  origin: group.origin,
  path_template: group.path_template,
  templated_segments: [...group.segments.entries()]
    .sort(([left], [right]) => left - right)
    .map(([segment_index, { rule, values }]) => ({
      segment_index,
      rule,
      observed_values: sortCodePoints(values),
    })),
  record_ordinals: group.record_ordinals,
  statuses: [...group.statuses].sort((left, right) => left - right),
  resource_types: sortCodePoints(group.resource_types),
  transactions: group.transactions,
});
const groupOrder = (left, right) =>
  compareCodePoints(left.origin, right.origin) ||
  compareCodePoints(left.path_template, right.path_template) ||
  compareCodePoints(left.method, right.method);

/** A scenario capture: transactions grouped like api-surface, operations and navigations. */
function captureObserved(capture, at) {
  try {
    validateScenarioCapture(capture);
  } catch (error) {
    throw new Error(`${at}: ${error instanceof Error ? error.message : error}`);
  }
  const transactions = assembleTransactions(capture, {
    maxTransactions: SURFACE_LIMITS.maxTransactions,
  });
  const groups = new Map();
  const operations = [];
  let excluded = 0;
  let truncatedBodies = 0;
  for (const [ordinal, transaction] of transactions.entries()) {
    const line =
      transaction.method === null ||
      transaction.url === null ||
      transaction.url.redacted
        ? null
        : recordedPath(transaction.url.url);
    if (line === null) {
      excluded += 1;
      continue;
    }
    const template = recordTransaction(groups, ordinal, transaction, line);
    const body = classifyBody(
      transaction.request.body,
      SURFACE_LIMITS.maxBodyBytes,
    );
    if (body.kind === "truncated") truncatedBodies += 1;
    if (body.kind !== "json") continue;
    for (const operation of graphqlOperations(body.body.buffer))
      operations.push({
        ...operation,
        method: transaction.method,
        origin: line.origin,
        path_template: template,
        endpoint_path: line.path,
        transaction_id: transaction.transaction_id,
        step_id: transaction.step_id,
        status: transaction.status,
      });
  }
  return {
    kind: "scenario-capture",
    groups: [...groups.values()].map(finishGroup).sort(groupOrder),
    records: {
      examined: transactions.length,
      total: transactions.length,
      excluded,
    },
    incompleteness: captureIncompleteness(capture, excluded),
    body_incompleteness:
      truncatedBodies === 0
        ? []
        : [
            `${truncatedBodies} request bod${truncatedBodies === 1 ? "y" : "ies"} truncated or unavailable (body-size-limit)`,
          ],
    bodiesRetained: capture.scenario.network_content.request_body === true,
    operations,
    navigations: captureNavigations(capture, at),
    comparison: null,
    limitations: strings(capture.limitations),
  };
}

function groupIdentity(item, where) {
  object(item, where);
  text(item.method, `${where}.method`);
  text(item.origin, `${where}.origin`);
  text(item.path_template, `${where}.path_template`);
  list(item.record_ordinals, `${where}.record_ordinals`);
  item.record_ordinals.forEach((ordinal, index) =>
    count(ordinal, `${where}.record_ordinals[${index}]`),
  );
  return {
    method: item.method,
    origin: item.origin,
    path_template: item.path_template,
    record_ordinals: [...item.record_ordinals],
  };
}

function pairings(item, where, pairedCount) {
  list(item.observed, `${where}.observed`);
  return item.observed.map((pairing, index) => {
    const here = `${where}.observed[${index}]`;
    object(pairing, here);
    count(pairing.group, `${here}.group`);
    if (pairing.group >= pairedCount)
      throw new Error(`${here}.group: references a missing paired group`);
    if (!PAIRING_BASES.includes(pairing.basis))
      throw new Error(`${here}.basis: expected exact or template-compatible`);
    return { group: pairing.group, basis: pairing.basis };
  });
}

function verdictMethod(method, where) {
  object(method, where, ["values", "basis"]);
  list(method.values, `${where}.values`);
  method.values.forEach((value, index) =>
    text(value, `${where}.values[${index}]`),
  );
  if (!METHOD_BASES.includes(method.basis))
    throw new Error(`${where}.basis: expected ${METHOD_BASES.join(", ")}`);
  if ((method.values.length === 0) !== (method.basis === "unknown"))
    throw new Error(`${where}.values: only an unknown basis has no values`);
  return { values: [...method.values], basis: method.basis };
}

/** A verdict target is copied only as a recorded path without query or fragment. */
function verdictTarget(target, where) {
  object(target, where, ["origin", "path", "origin_basis"]);
  if (target.origin !== null) text(target.origin, `${where}.origin`);
  text(target.path, `${where}.path`);
  if (!target.path.startsWith("/") || /[?#]/u.test(target.path))
    throw new Error(
      `${where}.path: expected a recorded path without query or fragment`,
    );
  if (!ORIGIN_BASES.includes(target.origin_basis))
    throw new Error(
      `${where}.origin_basis: expected ${ORIGIN_BASES.join(", ")}`,
    );
  return {
    origin: target.origin,
    path: target.path,
    origin_basis: target.origin_basis,
  };
}

function staticItem(item, where, pairedCount) {
  object(item, where);
  text(item.static_node_id, `${where}.static_node_id`);
  list(item.mechanisms, `${where}.mechanisms`);
  if (!STATIC_ITEM_STATUSES.includes(item.status))
    throw new Error(
      `${where}.status: expected ${STATIC_ITEM_STATUSES.join(", ")}`,
    );
  const result = {
    static_node_id: item.static_node_id,
    status: item.status,
    method:
      item.method === null
        ? null
        : verdictMethod(item.method, `${where}.method`),
    target:
      item.target === null
        ? null
        : verdictTarget(item.target, `${where}.target`),
    observed: [],
  };
  if (item.status === "matched") {
    if (!PAIRING_BASES.includes(item.match_basis))
      throw new Error(
        `${where}.match_basis: expected exact or template-compatible`,
      );
    result.match_basis = item.match_basis;
  }
  if (item.status === "unknown") {
    if (!ENDPOINT_TRAFFIC_UNKNOWN_REASONS.includes(item.reason))
      throw new Error(`${where}.reason: unknown reason vocabulary`);
    result.reason = item.reason;
  }
  if (item.status === "ambiguous") {
    text(item.reason, `${where}.reason`);
    result.reason = item.reason;
  }
  if (item.status === "matched" || item.status === "ambiguous")
    result.observed = pairings(item, where, pairedCount);
  return result;
}

/** A compare_static_and_observed_endpoints result; only complete collections are accepted. */
function comparisonObserved(value, at) {
  if (!COLLECTIONS.includes(value.collection))
    throw new Error(`${at}.collection: expected ${COLLECTIONS.join(", ")}`);
  object(value.page, `${at}.page`);
  count(value.page.total, `${at}.page.total`);
  list(value.items, `${at}.items`, SURFACE_LIMITS.maxGroups);
  if (value.page.total !== value.items.length)
    throw new Error(
      `${at}: comparison page is partial (page.total ${value.page.total} differs from items.length ${value.items.length}); supply the complete collection`,
    );
  object(value.static, `${at}.static`);
  hex(value.static.root_artifact_sha256, `${at}.static.root_artifact_sha256`);
  text(value.static.graph_id, `${at}.static.graph_id`);
  object(value.coverage, `${at}.coverage`);
  text(value.coverage.static_graph, `${at}.coverage.static_graph`);
  const { records: counts, reasons } = records(
    value.coverage.observed_records,
    `${at}.coverage.observed_records`,
  );
  list(value.declared_origins, `${at}.declared_origins`);
  let paired = [];
  if (value.collection === "static-endpoints") {
    list(value.paired_groups, `${at}.paired_groups`);
    paired = value.paired_groups.map((group, index) =>
      groupIdentity(group, `${at}.paired_groups[${index}]`),
    );
  }
  const items = value.items.map((item, index) => {
    const where = `${at}.items[${index}]`;
    if (value.collection === "static-endpoints")
      return staticItem(item, where, paired.length);
    const identity = groupIdentity(item, where);
    if (value.collection !== "observed-unresolved") return identity;
    list(item.static_node_ids, `${where}.static_node_ids`);
    item.static_node_ids.forEach((id, position) =>
      text(id, `${where}.static_node_ids[${position}]`),
    );
    return { ...identity, static_node_ids: [...item.static_node_ids] };
  });
  return {
    kind: "endpoint-traffic-comparison",
    groups: [],
    records: counts,
    incompleteness: reasons,
    body_incompleteness: [],
    bodiesRetained: false,
    operations: [],
    navigations: [],
    comparison: {
      collection: value.collection,
      items,
      paired_groups: paired,
      static: {
        root_artifact_sha256: value.static.root_artifact_sha256,
        graph_id: value.static.graph_id,
      },
      static_graph: value.coverage.static_graph,
      declared_origins: value.declared_origins.filter(
        (origin) => typeof origin === "string",
      ),
    },
    limitations: strings(value.limitations),
  };
}

/** Dispatch one observed file by shape; anything else fails closed. */
export function readObservedInput(value, at) {
  object(value, at);
  if (Array.isArray(value.groups) && plain(value.records))
    return apiSurfaceObserved(value, at);
  if (
    plain(value.scenario) &&
    Array.isArray(value.steps) &&
    plain(value.events)
  )
    return captureObserved(value, at);
  if (
    typeof value.collection === "string" &&
    plain(value.page) &&
    Array.isArray(value.items)
  )
    return comparisonObserved(value, at);
  throw new Error(
    `${at}: unrecognized observed shape (expected an api-surface view, a scenario capture or an endpoint traffic comparison)`,
  );
}
