// Companion mirror of two small rules whose owners stay in TypeScript:
//   segmentRule / scanRouteTemplate -> src/domain/analysisView/webNetworkRouteTemplates.ts
//   raw path extraction             -> src/domain/recordedTransportUrl.ts (parseRecordedTransportUrl)
// tests/boundary/cli/saasApiContract.test.ts asserts parity against those owners, so a
// drift in either copy fails a test instead of silently diverging.

/** Exact segment formats shared with the api-surface view, in its precedence order. */
export const ROUTE_RULES = ["numeric", "uuid", "hex", "iso-date"];

const SPECIAL_SCHEMES = ["ftp:", "file:", "http:", "https:", "ws:", "wss:"];

/** The first exact format rule a recorded path segment satisfies, if any. */
export function segmentRule(value) {
  if (/^[0-9]+$/u.test(value)) return "numeric";
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      value,
    )
  )
    return "uuid";
  if (/^[0-9a-f]{32,}$/iu.test(value)) return "hex";
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u.test(value)) {
    const date = new Date(`${value}T00:00:00.000Z`);
    if (
      Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value
    )
      return "iso-date";
  }
  return null;
}

/** Replace rule-matching segments with `{rule}`; segment indices count from the first segment. */
export function routeTemplate(path) {
  const segments = [];
  const parts = [];
  const rules = [];
  let copied = 0;
  let index = 0;
  let start = 1;
  for (;;) {
    const slash = path.indexOf("/", start);
    const end = slash < 0 ? path.length : slash;
    const value = path.slice(start, end);
    const rule = segmentRule(value);
    if (rule !== null) {
      segments.push({ segment_index: index, rule, value });
      parts.push(path.slice(copied, start), `{${rule}}`);
      rules.push(`${index}:${rule};`);
      copied = end;
    }
    if (slash < 0) break;
    start = slash + 1;
    index += 1;
  }
  if (segments.length === 0) return { template: path, rules: "", segments };
  parts.push(path.slice(copied));
  return { template: parts.join(""), rules: rules.join(""), segments };
}

/**
 * Origin plus the raw recorded path of an absolute transport URL, never URL.pathname
 * (which removes observed dot segments). Null when the spelling has no stable
 * scheme://authority or no WHATWG origin.
 */
export function recordedPath(value) {
  if (typeof value !== "string") return null;
  const prefix = /^[\x00-\x20]*(?:([A-Za-z][A-Za-z0-9+.-]*):)?\/\//u.exec(
    value,
  );
  const absolute = URL.parse(value);
  const origin =
    absolute !== null && absolute.origin !== "null" ? absolute.origin : null;
  if (
    prefix === null ||
    origin === null ||
    !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value)
  )
    return null;
  const authorityStart = prefix[0].length;
  const special = SPECIAL_SCHEMES.includes(absolute.protocol);
  let authorityEnd = authorityStart;
  while (
    authorityEnd < value.length &&
    !"/?#".includes(value[authorityEnd]) &&
    !(special && value[authorityEnd] === "\\")
  )
    authorityEnd += 1;
  const authority = value.slice(authorityStart, authorityEnd);
  if (authority.length === 0 || /[\t\n\r]/u.test(authority)) return null;
  if (special && value[authorityEnd] === "\\") return null;
  if (value[authorityEnd] !== "/") return { origin, path: "/" };
  let pathEnd = authorityEnd;
  while (pathEnd < value.length && !"?#".includes(value[pathEnd])) pathEnd += 1;
  return { origin, path: value.slice(authorityEnd, pathEnd) };
}
