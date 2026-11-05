export interface OriginPair {
  readonly before_origin: string;
  readonly after_origin: string;
}

/** A serialized WHATWG origin: scheme, host and non-default port, nothing else. */
export function isCanonicalOrigin(value: unknown): boolean;
/** Validate caller-declared pairs exactly as the comparison input schema does. */
export function parseOriginPairs(value: unknown, at: string): OriginPair[];
/** The committed order: pairs sorted by before_origin. */
export function sortOriginPairs(pairs: readonly OriginPair[]): OriginPair[];
/** Comparison-only tokens for declared origins; no pairs means no projection. */
export function originCorrespondence(pairs: readonly OriginPair[]): {
  readonly token: (origin: string, side: "before" | "after") => string;
};
