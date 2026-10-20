import { createHash } from "node:crypto";
import { basename, dirname, resolve } from "node:path";
import {
  decodeExportText,
  parseExportJson,
  readBoundedExport,
} from "./saas-export-comparison.mjs";
import { compareCodePoints } from "./saas-ordering.mjs";
import { inspectProductProfile } from "./saas-product-profile.mjs";
import { SURFACE_LIMITS } from "./saas-surface-inputs.mjs";
import { FIXED_LIMITATIONS } from "./saas-surface-matching.mjs";

// Report-side helpers of the surface-coverage companion: planned experiments in the
// product-profile vocabulary, the limitation lines every report states, profile merging
// re-validated against scripts/fixtures/saas-profiles/profile.schema.json, and bounded
// file reading for the CLI.

const FAMILY_ORDER = ["network", "trpc", "graphql", "route"];
const STATUS_ORDER = ["unmatched", "ambiguous", "unknown"];
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

export const experimentId = (family, key) =>
  `surface-${family}-${sha256(`${family}\u0000${key}`).slice(0, 12)}`;

const where = (item) => {
  const [location] = item.evidence.static.locations;
  return location === undefined
    ? "an unavailable location"
    : `${location.source}:${location.line}:${location.column}`;
};
const describe = (item) =>
  `${item.evidence.static.mechanisms.join(", ")} at ${where(item)}`;

/** What a scenario has to make the UI issue for this item. */
function requested(item) {
  if (item.family === "trpc")
    return `the tRPC procedure ${item.procedure.path} (${item.procedure.method})`;
  if (item.family === "graphql")
    return `the GraphQL ${item.operation.type} ${item.operation.name}`;
  if (item.family === "route") return `a navigation to ${item.route.pattern}`;
  if (item.key.startsWith("node:"))
    return `the request declared at ${where(item)} (${item.evidence.static.mechanisms.join(", ")})`;
  return item.key;
}

function uncertainty(item) {
  const subject = `Static ${item.family} endpoint ${item.key} (${describe(item)})`;
  if (item.status === "unmatched")
    return `${subject} was not exercised by any supplied observation; its behavior is unknown, not absent.`;
  if (item.status === "ambiguous") {
    const methods = [
      ...new Set(
        item.evidence.observed.map((entry) => entry.method).filter(Boolean),
      ),
    ].sort(compareCodePoints);
    return `${subject} was observed only with methods that disagree with its inferred method (${methods.join(", ")}); which request it issues is ambiguous.`;
  }
  return `${subject} could not be matched: ${item.reason}.`;
}

const mutating = (item) =>
  item.family === "network"
    ? (item.method?.values ?? []).some((method) => MUTATING_METHODS.has(method))
    : item.family === "trpc"
      ? item.procedure.method === "mutate" ||
        item.procedure.method === "mutation"
      : item.family === "graphql"
        ? item.operation.type === "mutation"
        : false;

/** Schema-conformant profile experiments for every gap, one per family and key, in priority order. */
export function buildExperiments(items, workflowId, declaredOrigins) {
  const gaps = new Map();
  for (const item of items) {
    if (item.status === "exact" || item.status === "templated") continue;
    const id = experimentId(item.family, item.key);
    if (!gaps.has(id)) gaps.set(id, item);
  }
  const ordered = [...gaps.entries()].sort(
    ([, left], [, right]) =>
      FAMILY_ORDER.indexOf(left.family) - FAMILY_ORDER.indexOf(right.family) ||
      STATUS_ORDER.indexOf(left.status) - STATUS_ORDER.indexOf(right.status) ||
      Number(mutating(right)) - Number(mutating(left)) ||
      compareCodePoints(left.key, right.key),
  );
  const origin = (item) =>
    item.target?.origin ?? declaredOrigins[0] ?? "the reference origin";
  return {
    experiments: ordered.map(([id, item]) => ({
      id,
      workflowId,
      uncertainty: uncertainty(item),
      proposedObservation: `Record a browser scenario on ${origin(item)} reaching the UI that issues ${requested(item)}, with network bodies; rerun surface coverage.`,
      status: "planned",
      evidence: [],
    })),
    experimentPriorities: ordered.map(([id, item], index) => ({
      id,
      rank: index + 1,
      family: item.family,
      status: item.status,
      mutating: mutating(item),
    })),
  };
}

/** The bounds every report states, plus the ones its inputs and families add. */
export function surfaceLimitations(analysis, context, items, trpc) {
  const families = new Set(items.map((item) => item.family));
  const lines = [...FIXED_LIMITATIONS];
  if (analysis.coverage.status !== "complete")
    lines.push(
      `Static graph coverage is ${analysis.coverage.status}; endpoints in omitted or unavailable files are absent from this comparison.`,
    );
  for (const observed of context.observed) {
    if (observed.incompleteness.length > 0)
      lines.push(
        `Observed input ${observed.file} is incomplete (${observed.incompleteness.join("; ")}); absence in it is reported as unknown, never as unexercised.`,
      );
    if (observed.comparison !== null)
      lines.push(
        `Observed input ${observed.file} is an endpoint traffic comparison; its verdicts are adopted as recorded and its paired groups carry record ordinals only.`,
      );
    for (const line of observed.limitations)
      lines.push(`${observed.file}: ${line}`);
  }
  if (families.has("graphql"))
    lines.push(
      "GraphQL operations match only retained JSON request bodies (operationName, else the first named operation in the query text); api-surface views and captures without request bodies cannot exercise them.",
    );
  if (families.has("trpc") || trpc.bases.length > 0)
    lines.push(
      "tRPC procedures match only path segments after a declared link base, with batches split on commas; procedures without a link base, and link bases that are not literal paths, stay unknown.",
    );
  if (families.has("route"))
    lines.push(
      "Client routes compare parameterized static route patterns with navigation pathnames on the declared origins as recorded; server-driven and file-system routes (#4772) are not modeled.",
    );
  lines.push(
    "Endpoints behind feature-flag-gated code are declared like any other; a declaration does not establish that the UI can reach it, and a gated gap may be unreachable in the captured configuration.",
    "Minified bundles without source maps cite generated-code locations only; source_map_reference is not resolved.",
    "No HAR is decoded, no request is issued and no secret is read: only origins, paths, templates, operation and procedure names are copied into this report.",
  );
  return [...new Set(lines)];
}

/** Append planned experiments to a product profile; existing ids are never overwritten. */
export function mergeProfile(profile, workflowId, experiments) {
  const before = inspectProductProfile(profile);
  if (before.status !== "valid_plan")
    throw new Error(`profile: ${JSON.stringify(before.issues).slice(0, 300)}`);
  if (!profile.workflows.some(({ id }) => id === workflowId))
    throw new Error(`profile: workflow ${workflowId} is not declared`);
  const existing = new Set(profile.experiments.map(({ id }) => id));
  const added = experiments.filter(({ id }) => !existing.has(id));
  const merged = {
    ...profile,
    experiments: [...profile.experiments, ...added],
  };
  const after = inspectProductProfile(merged);
  if (after.status !== "valid_plan")
    throw new Error(
      `profile: merged profile is invalid ${JSON.stringify(after.issues).slice(0, 300)}`,
    );
  return {
    profileId: profile.profileId,
    workflowId,
    added: added.map(({ id }) => id),
    existing: experiments
      .filter(({ id }) => existing.has(id))
      .map(({ id }) => id),
    profile: merged,
  };
}

/** Read one JSON input beneath its own directory, bounded and duplicate-member strict. */
export async function readSurfaceFile(path) {
  const absolute = resolve(path);
  const source = await readBoundedExport(
    dirname(absolute),
    basename(absolute),
    SURFACE_LIMITS.maxBytes,
  );
  return {
    file: basename(absolute),
    sha256: source.sha256,
    value: parseExportJson(
      decodeExportText(source),
      1024,
      1_000_000,
      10_000_000,
    ),
  };
}

export const exitCodeFor = (report) =>
  report.status === "invalid" ? 2 : report.gaps > 0 ? 1 : 0;
