import { z } from "zod";
import {
  AnalysisInputError,
  AnalysisUnsupportedTargetError,
} from "../analysisErrorCore.js";
import type { AnalysisError } from "../analysisErrorBase.js";
import { err, ok, type Result } from "../result.js";
import {
  webNetworkCaptureSchema,
  type WebNetworkCapture,
} from "../webNetworkCapture.js";
import type {
  AnalysisViewParent,
  AnalysisViewRequest,
  UnsignedAnalysisView,
} from "./analysisView.js";
import { WebNetworkApiSurfaceAccumulator } from "./WebNetworkApiSurfaceAccumulator.js";

export const apiSurfaceViewSchema = z.strictObject({
  kind: z.literal("api-surface"),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().default(50),
  include_query_parameter_names: z
    .boolean()
    .optional()
    .describe(
      "Include distinct observed query parameter names and their original record ordinals; names do not establish required parameters or a complete API schema.",
    ),
});
const ruleSchema = z.enum(["numeric", "uuid", "hex", "iso-date"]);
const groupSchema = z.strictObject({
  method: z.string(),
  origin: z.string(),
  path_template: z.string(),
  templated_segments: z.array(
    z.strictObject({
      segment_index: z.number().int().nonnegative(),
      rule: ruleSchema,
      basis: z.literal("inferred"),
      observed_values: z.array(z.string()),
    }),
  ),
  record_ordinals: z.array(z.number().int().nonnegative()),
  statuses: z.array(z.number()),
  content_types: z.array(z.string()),
  query_parameter_names: z
    .array(
      z.strictObject({
        name: z.string(),
        record_ordinals: z.array(z.number().int().nonnegative()),
      }),
    )
    .optional(),
  flags: z.array(
    z.enum(["single-sample", "mixed-statuses", "mixed-content-types"]),
  ),
});
export const apiSurfaceFields = {
  records: z.strictObject({
    examined: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(),
  }),
  templated_groups: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Groups across every page that carry at least one templated segment.",
    ),
  groups: z.array(groupSchema),
  excluded_records: z.array(
    z.strictObject({
      ordinal: z.number().int().nonnegative(),
      reason: z.enum([
        "url-redacted",
        "url-unparseable",
        "request-unavailable",
        "method-unavailable",
      ]),
    }),
  ),
};
/** HAR parent facts consumed by grouping, independent of the requesting operation. */
export type WebNetworkApiSurfaceParent = Pick<
  AnalysisViewParent,
  "evidenceId" | "normalizedResult" | "limitations" | "parameters"
>;

/**
 * Admit, validate and group every retained request of one HAR parent. The
 * api-surface view and the static/observed endpoint comparison share this
 * owner; failures name the accumulator's operation and input coordinate.
 */
export const groupWebNetworkApiSurface = (
  parent: WebNetworkApiSurfaceParent,
  accumulator: WebNetworkApiSurfaceAccumulator,
  selectedLimitations: readonly string[] = [],
): Result<WebNetworkCapture, AnalysisError> => {
  const { operation, capturePath } = accumulator.owner;
  const unsupported = (reason: string) =>
    err(
      new AnalysisUnsupportedTargetError(operation, parent.evidenceId, reason),
    );
  const admitted = accumulator.admitCaptureClone(parent.normalizedResult);
  if (!admitted.ok) return admitted;
  const parsed = webNetworkCaptureSchema.safeParse(parent.normalizedResult);
  if (!parsed.success)
    return err(
      new AnalysisInputError(operation, undefined, [
        {
          path: [...capturePath],
          reason: "invalid_value",
          message:
            "Parent Evidence result does not match inspect_web_network_capture.",
        },
      ]),
    );
  const capture = parsed.data;
  if (capture.format !== "har")
    return unsupported(
      `api-surface does not support capture format ${capture.format}.`,
    );
  const declarations = z
    .object({ sensitive_value_count: z.number().int().nonnegative() })
    .safeParse(parent.parameters);
  if (!declarations.success || declarations.data.sensitive_value_count > 0)
    return unsupported("sensitive_values_unretained");
  const limitations = accumulator.addLimitations([
    ...parent.limitations,
    ...capture.limitations,
    "Grouping does not establish handler identity, URL-space schemas or causality.",
    ...selectedLimitations,
    ...(capture.records.length < capture.total_records
      ? [
          "Parent contains an ordinal subset; the surface covers only retained records.",
        ]
      : []),
  ]);
  if (!limitations.ok) return limitations;
  for (const record of capture.records) {
    const added = accumulator.add(record);
    if (!added.ok) return added;
  }
  return ok(capture);
};

/** Group retained HAR request lines; format matches do not establish handler identity. */
export const projectWebNetworkApiSurfaceView = (
  parent: AnalysisViewParent,
  view: AnalysisViewRequest,
  accumulator = new WebNetworkApiSurfaceAccumulator({
    includeQueryParameterNames:
      view.kind === "api-surface" &&
      view.include_query_parameter_names === true,
  }),
): Result<UnsignedAnalysisView, AnalysisError> => {
  if (
    parent.operation !== "inspect_web_network_capture" ||
    view.kind !== "api-surface"
  )
    return err(
      new AnalysisUnsupportedTargetError(
        "inspect_analysis_view",
        parent.evidenceId,
        `View ${view.kind} is unsupported for parent operation ${parent.operation}; api-surface requires inspect_web_network_capture.`,
      ),
    );
  const grouped = groupWebNetworkApiSurface(
    parent,
    accumulator,
    view.include_query_parameter_names === true
      ? [
          "Observed query parameter names do not establish required parameters, value types or a complete API schema.",
        ]
      : [],
  );
  if (!grouped.ok) return grouped;
  const capture = grouped.value;
  const page = accumulator.page(view.offset, view.limit);
  return ok({
    kind: "api-surface",
    view,
    parent_evidence_id: parent.evidenceId,
    parent_operation: "inspect_web_network_capture",
    parent_digest: parent.evidenceId.slice(3),
    artifact: { path: capture.artifact.path, sha256: capture.artifact.sha256 },
    records: {
      examined: capture.records.length,
      total: capture.total_records,
      excluded: page.excluded_records.length,
    },
    ...page,
  });
};
