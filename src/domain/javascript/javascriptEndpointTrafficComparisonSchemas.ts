import { z } from "zod";

import { digestSchema, prefixedDigestSchema } from "../digests.js";

const evidenceIdSchema = prefixedDigestSchema("ev");
const countSchema = z.number().int().nonnegative();
const ordinalSchema = z.number().int().nonnegative();
const textSchema = z.string().min(1);

/** URL schemes whose requests a HAR api-surface grouping can contain. */
export const ENDPOINT_TRAFFIC_PROTOCOLS: ReadonlySet<string> = new Set([
  "http:",
  "https:",
  "ws:",
  "wss:",
]);

// `\x2f` keeps "/" escaped inside the class for clients that compile the
// advertised pattern in `v` mode, where an unescaped "/" there is invalid.
const ADVERTISED_ORIGIN_PATTERN = /^(?:https?|wss?):\/\/[^\x2f?#@\sA-Z]+$/u;

/** Whether a value is one exact serialized HTTP(S) or WS(S) origin. */
const isExactOrigin = (value: string): boolean => {
  const parsed = URL.parse(value);
  return (
    parsed !== null &&
    ENDPOINT_TRAFFIC_PROTOCOLS.has(parsed.protocol) &&
    parsed.origin === value
  );
};

/** Why a static network endpoint has no matched or not-observed status. */
export const ENDPOINT_TRAFFIC_UNKNOWN_REASONS = [
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
] as const;
export type EndpointTrafficUnknownReason =
  (typeof ENDPOINT_TRAFFIC_UNKNOWN_REASONS)[number];

/** Independently paged result lists. */
export const ENDPOINT_TRAFFIC_COLLECTIONS = [
  "static-endpoints",
  "observed-without-static-match",
  "observed-unresolved",
] as const;

/** Caller choices shared by the MCP request, CLI request and Evidence parameters. */
export const endpointTrafficComparisonOptionsShape = {
  origins: z
    .array(
      z
        .string()
        // Advertised structural superset of every serialized origin: a lowercase
        // http(s)/ws(s) scheme and an authority without path, query, fragment,
        // userinfo, whitespace or uppercase. URL parsing keeps the exact check.
        .regex(
          ADVERTISED_ORIGIN_PATTERN,
          "Expected an exact serialized http, https, ws or wss origin such as https://app.example.test",
        )
        .refine(
          isExactOrigin,
          "Expected an exact serialized http, https, ws or wss origin such as https://app.example.test",
        ),
    )
    .refine((origins) => new Set(origins).size === origins.length, {
      message: "Declared origins must be unique",
    })
    .meta({ uniqueItems: true })
    .default([])
    .describe(
      "Exact origins that origin-relative static paths such as /api/users are joined against. The join is a caller-declared inference; omit to leave those paths unknown.",
    ),
  collection: z
    .enum(ENDPOINT_TRAFFIC_COLLECTIONS)
    .default("static-endpoints")
    .describe(
      "Result list to page: static-endpoints (every static network endpoint and its status), observed-without-static-match (observed groups with no compatible static finding), or observed-unresolved (observed groups whose only static counterpart could not be joined, such as an origin-relative path without declared origins). Summary counts always cover every list.",
    ),
  offset: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe("First item of the selected collection."),
  limit: z
    .number()
    .int()
    .positive()
    .default(50)
    .describe("Maximum items returned from the selected collection."),
} as const;

const methodSchema = z
  .strictObject({
    values: z.array(textSchema),
    basis: z.enum(["callee-name", "api-definition", "unknown"]),
  })
  .superRefine((method, context) => {
    if ((method.values.length === 0) !== (method.basis === "unknown"))
      context.addIssue({
        code: "custom",
        path: ["values"],
        message: "Only an unknown method basis has no method values",
      });
  });

const targetSchema = z.strictObject({
  origin: textSchema
    .nullable()
    .describe("Origin of an absolute static URL; null for a relative path."),
  path: textSchema.describe(
    "Recorded static path without query or fragment, compared as still-encoded text.",
  ),
  origin_basis: z.enum(["literal", "declared", "undeclared"]),
});

const groupIdentityShape = {
  method: z.string(),
  origin: z.string(),
  path_template: z.string(),
  record_ordinals: z.array(ordinalSchema),
} as const;

const pairedGroupSchema = z.strictObject({
  group: z
    .number()
    .int()
    .nonnegative()
    .describe("Index into paired_groups on this page."),
  basis: z.enum(["exact", "template-compatible"]),
});

const itemBase = {
  static_node_id: prefixedDigestSchema("jag_node"),
  mechanisms: z.array(textSchema).min(1),
} as const;

const staticEndpointItemSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ...itemBase,
    status: z.literal("matched"),
    method: methodSchema,
    target: targetSchema,
    match_basis: z.enum(["exact", "template-compatible"]),
    observed: z.array(pairedGroupSchema).min(1),
  }),
  z.strictObject({
    ...itemBase,
    status: z.literal("ambiguous"),
    method: methodSchema,
    target: targetSchema,
    reason: z.literal("method-inference-disagrees"),
    observed: z.array(pairedGroupSchema).min(1),
  }),
  z.strictObject({
    ...itemBase,
    status: z.literal("not-observed-in-capture"),
    method: methodSchema,
    target: targetSchema,
  }),
  z.strictObject({
    ...itemBase,
    status: z.literal("unknown"),
    reason: z.enum(ENDPOINT_TRAFFIC_UNKNOWN_REASONS),
    method: methodSchema.nullable(),
    target: targetSchema.nullable(),
  }),
]);

const unresolvedGroupSchema = z.strictObject({
  ...groupIdentityShape,
  reason: z
    .literal("origin-undeclared")
    .describe(
      "Origin-relative static paths share this route shape, but no origins were declared to join them.",
    ),
  static_node_ids: z.array(prefixedDigestSchema("jag_node")).min(1),
});

const resultBase = {
  static: z.strictObject({
    evidence_id: evidenceIdSchema,
    graph_id: prefixedDigestSchema("jag"),
    root_artifact_sha256: digestSchema,
  }),
  observed: z.strictObject({
    evidence_id: evidenceIdSchema,
    artifact: z.strictObject({
      path: z.string(),
      sha256: digestSchema.nullable(),
    }),
  }),
  declared_origins: z.array(textSchema),
  summary: z.strictObject({
    static_network_endpoints: countSchema,
    matched: countSchema,
    matched_exact: countSchema,
    ambiguous: countSchema,
    not_observed_in_capture: countSchema,
    unknown: countSchema,
    unknown_reasons: z.array(
      z.strictObject({
        reason: z.enum(ENDPOINT_TRAFFIC_UNKNOWN_REASONS),
        count: z.number().int().positive(),
      }),
    ),
    observed_groups: countSchema,
    observed_matched: countSchema.describe(
      "Observed groups listed by at least one matched static endpoint.",
    ),
    observed_ambiguous: countSchema.describe(
      "Observed groups listed only by ambiguous (method-inference-disagrees) static endpoints.",
    ),
    observed_unresolved: countSchema,
    observed_without_static_match: countSchema,
  }),
  page: z.strictObject({
    offset: countSchema,
    limit: z.number().int().positive(),
    total: countSchema,
    next_offset: countSchema.nullable(),
  }),
  coverage: z.strictObject({
    static_graph: z.enum(["complete", "partial", "unknown", "unavailable"]),
    observed_records: z.strictObject({
      examined: countSchema,
      total: countSchema,
      excluded: countSchema,
    }),
  }),
  evidence_links: z.array(evidenceIdSchema).length(2),
  limitations: z.array(textSchema),
} as const;

/** Static endpoint statuses, or one page of observed groups by static counterpart. */
export const endpointTrafficComparisonResultSchema = z
  .discriminatedUnion("collection", [
    z.strictObject({
      ...resultBase,
      collection: z.literal("static-endpoints"),
      items: z.array(staticEndpointItemSchema),
      paired_groups: z
        .array(z.strictObject(groupIdentityShape))
        .describe(
          "Each observed group paired by an item on this page, once, with its record ordinals.",
        ),
    }),
    z.strictObject({
      ...resultBase,
      collection: z.literal("observed-without-static-match"),
      items: z.array(z.strictObject(groupIdentityShape)),
    }),
    z.strictObject({
      ...resultBase,
      collection: z.literal("observed-unresolved"),
      items: z.array(unresolvedGroupSchema),
    }),
  ])
  .superRefine((result, context) => {
    const { summary } = result;
    if (
      summary.matched +
        summary.ambiguous +
        summary.not_observed_in_capture +
        summary.unknown !==
        summary.static_network_endpoints ||
      summary.matched_exact > summary.matched ||
      summary.unknown_reasons.reduce((total, { count }) => total + count, 0) !==
        summary.unknown ||
      summary.observed_matched +
        summary.observed_ambiguous +
        summary.observed_unresolved +
        summary.observed_without_static_match !==
        summary.observed_groups
    )
      context.addIssue({
        code: "custom",
        path: ["summary"],
        message: "Comparison summary counts are inconsistent",
      });
    if (
      result.collection === "static-endpoints" &&
      result.items.some(
        (item) =>
          "observed" in item &&
          item.observed.some(
            ({ group }) => group >= result.paired_groups.length,
          ),
      )
    )
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Pairings must reference a paired group on this page",
      });
    if (result.items.length > result.page.limit)
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "A page cannot exceed its limit",
      });
  });

export type EndpointTrafficComparisonResult = z.output<
  typeof endpointTrafficComparisonResultSchema
>;
export type EndpointTrafficStaticItem = z.output<
  typeof staticEndpointItemSchema
>;
