// Companion mirror of the declared deployment-origin correspondence whose owners stay in
// TypeScript: the origin_pairs schema in src/domain/browserScenarioDiffValues.ts, the
// canonical ordering in src/domain/browserScenarioNormalization.ts and the projection in
// src/domain/browserScenarioOriginCorrespondence.ts. The vitest wrapper asserts parity.

const PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

/** A serialized WHATWG origin: scheme, host and non-default port, nothing else. */
export function isCanonicalOrigin(value) {
  if (typeof value !== "string") return false;
  const url = URL.parse(value);
  return url !== null && PROTOCOLS.has(url.protocol) && url.origin === value;
}

/** Validate caller-declared pairs exactly as the comparison input schema does. */
export function parseOriginPairs(value, at) {
  if (!Array.isArray(value)) throw new Error(`${at}: expected array`);
  const pairs = value.map((pair, index) => {
    if (
      !pair ||
      typeof pair !== "object" ||
      Array.isArray(pair) ||
      Object.getPrototypeOf(pair) !== Object.prototype
    )
      throw new Error(`${at}[${index}]: expected object`);
    const keys = Object.keys(pair);
    if (
      keys.length !== 2 ||
      keys.some((key) => key !== "before_origin" && key !== "after_origin")
    )
      throw new Error(
        `${at}[${index}]: expected exactly before_origin and after_origin`,
      );
    for (const key of ["before_origin", "after_origin"])
      if (!isCanonicalOrigin(pair[key]))
        throw new Error(
          `${at}[${index}].${key}: expected a canonical HTTP(S) or WS(S) origin without credentials, path, query, or fragment`,
        );
    return {
      before_origin: pair.before_origin,
      after_origin: pair.after_origin,
    };
  });
  for (const key of ["before_origin", "after_origin"]) {
    const seen = new Set();
    for (const [index, pair] of pairs.entries()) {
      if (seen.has(pair[key]))
        throw new Error(
          `${at}[${index}].${key}: origin correspondence must be one-to-one on each side`,
        );
      seen.add(pair[key]);
    }
  }
  return pairs;
}

/** The committed order: pairs sorted by before_origin, as the comparison records them. */
export function sortOriginPairs(pairs) {
  return [...pairs].sort((a, b) =>
    a.before_origin < b.before_origin
      ? -1
      : a.before_origin > b.before_origin
        ? 1
        : 0,
  );
}

/**
 * Comparison-only tokens: a declared origin on either side becomes the pair identity,
 * every other origin stays literal, and no pairs means no projection at all.
 */
export function originCorrespondence(pairs) {
  if (pairs.length === 0) return { token: (origin) => origin };
  const before = new Map(
    pairs.map((pair, index) => [
      pair.before_origin,
      `origin-correspondence:${index}`,
    ]),
  );
  const after = new Map(
    pairs.map((pair, index) => [
      pair.after_origin,
      `origin-correspondence:${index}`,
    ]),
  );
  return {
    token(origin, side) {
      const map = side === "before" ? before : after;
      return map.get(origin) ?? `literal:${origin}`;
    },
  };
}
