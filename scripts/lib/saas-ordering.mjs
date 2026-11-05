// Deterministic ordering shared by the SaaS companions: Unicode code point order, as
// the TypeScript views sort templates and methods (src/domain/unicodeCodePointOrder.ts).

/** Negative, zero or positive by the first differing code point, then by length. */
export function compareCodePoints(left, right) {
  const a = [...left];
  const b = [...right];
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = a[index].codePointAt(0) - b[index].codePointAt(0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** A sorted array copy of any iterable of strings. */
export const sortCodePoints = (values) => [...values].sort(compareCodePoints);
