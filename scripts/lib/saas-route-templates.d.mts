/** Exact segment formats shared with the api-surface view. */
export type RouteRule = "numeric" | "uuid" | "hex" | "iso-date";

export interface RouteTemplateSegment {
  readonly segment_index: number;
  readonly rule: RouteRule;
  readonly value: string;
}
export interface RouteTemplateResult {
  readonly template: string;
  readonly rules: string;
  readonly segments: readonly RouteTemplateSegment[];
}

/** The first exact format rule a recorded path segment satisfies, if any. */
export function segmentRule(value: string): RouteRule | null;
/** Replace rule-matching segments with `{rule}`; segment indices count from the first segment. */
export function routeTemplate(path: string): RouteTemplateResult;
/** Origin plus raw recorded path of an absolute transport URL, or null. */
export function recordedPath(
  value: unknown,
): { readonly origin: string; readonly path: string } | null;
