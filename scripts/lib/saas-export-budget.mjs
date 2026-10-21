const MAX_POLICY_BYTES = 1024 * 1024;
const MAX_REPORT_BYTES = 16 * 1024 * 1024;

// Count JSON's UTF-8 bytes without allocating escaped strings or the complete
// serialization. Cache long repeated strings so field aliases cost one scan.
function admitJson(value, maximum, label, pretty = false) {
  const indent = pretty ? 2 : 0;
  let bytes = pretty ? 1 : 0;
  const strings = new Map();
  const reserve = (count) => {
    bytes += count;
    if (bytes > maximum)
      throw new Error(`${label}: exceeds ${maximum / (1024 * 1024)} MiB`);
  };
  const stringBytes = (text) => {
    if (strings.has(text)) return strings.get(text);
    let size = 2;
    for (let i = 0; i < text.length; i++) {
      const code = text.codePointAt(i);
      if (code === 34 || code === 92) size += 2;
      else if (code < 32) size += [8, 9, 10, 12, 13].includes(code) ? 2 : 6;
      else if (code < 128) size++;
      else if (code < 2048) size += 2;
      else if (code >= 0xd800 && code <= 0xdfff) size += 6;
      else if (code <= 0xffff) size += 3;
      else {
        size += 4;
        i++;
      }
      if (size > maximum)
        throw new Error(`${label}: exceeds ${maximum / (1024 * 1024)} MiB`);
    }
    if (text.length > 64) strings.set(text, size);
    return size;
  };
  const visit = (item, depth) => {
    if (typeof item === "string") return reserve(stringBytes(item));
    if (item === null) return reserve(4);
    if (typeof item === "number" || typeof item === "boolean")
      return reserve(Object.is(item, -0) ? 2 : String(item).length);
    const array = Array.isArray(item);
    const keys = array ? null : Object.keys(item);
    const length = array ? item.length : keys.length;
    reserve(2);
    for (let i = 0; i < length; i++) {
      if (i) reserve(1);
      if (indent) reserve(1 + indent * (depth + 1));
      if (!array) reserve(stringBytes(keys[i]) + 1 + (indent ? 1 : 0));
      visit(item[array ? i : keys[i]], depth + 1);
    }
    if (length && indent) reserve(1 + indent * depth);
  };
  visit(value, 0);
}

export function admitReport(report) {
  // Match serializeReport's signed-zero tokens, indentation and final newline.
  admitJson(report, MAX_REPORT_BYTES, "report", true);
  return report;
}
export function admitPolicy(policy) {
  admitJson(policy, MAX_POLICY_BYTES, "policy");
}
