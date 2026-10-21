/** The subset of an api-surface group the route-shape key reads. */
export interface ObservedGroupShape {
  readonly path_template: string;
  readonly templated_segments: readonly {
    readonly segment_index: number;
    readonly rule: string;
  }[];
}

/** Route shape of a static path: segment rules as a composite tuple, before origin. */
export function staticShapeKey(path: string): string;
/** Route shape of an api-surface group from its template and templated segments. */
export function groupShapeKey(group: ObservedGroupShape): string;
/** Origin and shape as one composite key. */
export function routeKey(origin: string, shape: string): string;
