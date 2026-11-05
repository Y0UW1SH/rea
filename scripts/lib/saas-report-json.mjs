const negativeZero = JSON.rawJSON("-0");

// Native JSON escaping preserves strings and keys; only numeric -0 needs a
// lossless token because JSON.stringify otherwise silently emits positive 0.
export const serializeReport = (value) =>
  `${JSON.stringify(
    value,
    (_key, item) => (Object.is(item, -0) ? negativeZero : item),
    2,
  )}\n`;
