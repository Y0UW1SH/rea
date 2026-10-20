import { open, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { admitPolicy, admitReport } from "./saas-export-budget.mjs";

const own = (o, k) => Object.hasOwn(o, k);
function object(value, keys, at) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error(`${at}: expected object`);
  if (keys && Object.keys(value).some((k) => !keys.includes(k)))
    throw new Error(`${at}: unsupported field`);
}
function text(v, at) {
  if (typeof v !== "string" || !v.trim())
    throw new Error(`${at}: expected nonempty string`);
}
function unique(items, at) {
  if (new Set(items).size !== items.length)
    throw new Error(`${at}: duplicate values`);
}
function boundedInteger(value, ceiling, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > ceiling)
    throw new Error(`${name}: expected positive integer at most ${ceiling}`);
}
function validate(p) {
  object(
    p,
    ["version", "name", "reference", "replacement", "fields", "keys", "limits"],
    "policy",
  );
  if (p.version !== 1) throw new Error("version: expected 1");
  text(p.name, "name");
  object(
    p.limits,
    ["maxBytes", "maxRecords", "maxFields", "maxValues"],
    "limits",
  );
  for (const [key, ceiling] of [
    ["maxBytes", 16 * 1024 * 1024],
    ["maxRecords", 100000],
    ["maxFields", 1024],
    ["maxValues", 1000000],
  ])
    boundedInteger(
      key === "maxValues" && p.limits[key] === undefined
        ? 100000
        : p.limits[key],
      ceiling,
      key,
    );
  if (
    !Array.isArray(p.fields) ||
    !p.fields.length ||
    p.fields.length > p.limits.maxFields
  )
    throw new Error("fields: expected nonempty bounded array");
  for (const f of p.fields) {
    object(f, ["name", "reference", "replacement", "type"], "field");
    for (const key of ["name", "reference", "replacement"])
      text(f[key], `field ${key}`);
    if (!["string", "integer", "decimal"].includes(f.type))
      throw new Error("unsupported field type");
  }
  for (const key of ["name", "reference", "replacement"])
    unique(
      p.fields.map((f) => f[key]),
      `fields ${key}`,
    );
  if (!Array.isArray(p.keys) || !p.keys.length)
    throw new Error("keys: expected nonempty array");
  unique(p.keys, "keys");
  for (const k of p.keys)
    if (!p.fields.some((f) => f.name === k))
      throw new Error("key is not a selected field");
  for (const side of ["reference", "replacement"]) {
    object(p[side], ["file", "format"], side);
    text(p[side].file, "file");
    if (!["csv", "json"].includes(p[side].format))
      throw new Error("format: expected csv or json");
  }
}

/** Read stable raw bytes before interpreting text, preserving malformed evidence. */
export async function readBoundedExport(root, file, maxBytes) {
  boundedInteger(maxBytes, 16 * 1024 * 1024, "maxBytes");
  if (
    typeof file !== "string" ||
    file.includes("\0") ||
    isAbsolute(file) ||
    file.split(/[\\/]/u).includes("..") ||
    file.includes("\\")
  )
    throw new Error("file: expected relative path without traversal");
  const base = await realpath(root);
  const path = await realpath(resolve(base, file));
  const rel = relative(base, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error("file: escapes input directory");
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const verifyIdentity = async (identity) => {
      const current = await realpath(resolve(base, file));
      if (current !== path || (await realpath(root)) !== base)
        throw new Error("file: selected path changed");
      const named = await stat(current, { bigint: true });
      if (named.dev !== identity.dev || named.ino !== identity.ino)
        throw new Error("file: selected identity changed");
    };
    const before = await handle.stat({ bigint: true });
    await verifyIdentity(before);
    if (!before.isFile()) throw new Error("file: expected regular file");
    if (before.size > BigInt(maxBytes))
      throw new Error("file: exceeds maxBytes");
    const buffer = Buffer.alloc(maxBytes + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = await handle.read(
        buffer,
        bytes,
        buffer.length - bytes,
        null,
      );
      if (!read.bytesRead) break;
      bytes += read.bytesRead;
    }
    if (bytes > maxBytes) throw new Error("file: exceeds maxBytes");
    const after = await handle.stat({ bigint: true });
    await verifyIdentity(after);
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(bytes) !== after.size
    )
      throw new Error("file: changed during read");
    const data = buffer.subarray(0, bytes);
    return {
      data,
      bytes,
      sha256: createHash("sha256").update(data).digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

export function decodeExportText(source) {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    source.data,
  );
}

// JSON.parse alone silently accepts duplicate object members. This small strict
// decoder detects them before assignment, caps depth, and keeps numeric fields
// subject to the projection's string-only exactness rule.
export function parseExportJson(
  input,
  maxFields = 1024,
  maxArrayLength = 100000,
  maxValues = 100000,
  decodeNumber = (lexeme) => JSON.parse(lexeme),
) {
  let at = 0,
    values = 0;
  const admit = () => {
    if (++values > maxValues) throw new Error("JSON: exceeds maxValues");
  };
  const space = () => {
    while (/[\x20\t\r\n]/u.test(input[at] ?? "x")) at++;
  };
  function string() {
    const start = at++;
    while (at < input.length) {
      const c = input[at++];
      if (c === '"') return JSON.parse(input.slice(start, at));
      if (c === "\\") at++;
    }
    throw new Error("JSON: unterminated string");
  }
  function value(depth) {
    admit();
    if (depth > 32) throw new Error("JSON: nesting exceeds 32");
    space();
    const c = input[at];
    if (c === '"') return string();
    if (c === "{" || c === "[") {
      at++;
      space();
      const array = c === "[";
      const end = array ? "]" : "}";
      const result = array ? [] : {};
      const seen = new Set();
      if (input[at] === end) {
        at++;
        return result;
      }
      for (;;) {
        space();
        let key;
        if (!array) {
          if (input[at] !== '"') throw new Error("JSON: expected member name");
          admit();
          key = string();
          if (seen.has(key)) throw new Error("JSON: duplicate member");
          seen.add(key);
          if (seen.size > maxFields) throw new Error("JSON: exceeds maxFields");
          space();
          if (input[at++] !== ":") throw new Error("JSON: expected colon");
        }
        if (array && result.length >= maxArrayLength)
          throw new Error("JSON: exceeds array record budget");
        const item = value(depth + 1);
        if (array) {
          result.push(item);
        } else
          Object.defineProperty(result, key, {
            value: item,
            enumerable: true,
            writable: true,
            configurable: true,
          });
        space();
        if (input[at] === end) {
          at++;
          return result;
        }
        if (input[at++] !== ",") throw new Error("JSON: expected comma");
      }
    }
    const match =
      /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(
        input.slice(at),
      );
    if (!match) throw new Error("JSON: invalid value");
    at += match[0].length;
    // Number lexemes reach the caller untouched so inference can see exact tokens.
    return /^[-0-9]/u.test(match[0])
      ? decodeNumber(match[0])
      : JSON.parse(match[0]);
  }
  const result = value(0);
  space();
  if (at !== input.length) throw new Error("JSON: trailing input");
  return result;
}

function csv(input, limits) {
  const rows = [];
  let row = [],
    start = 0,
    at = 0,
    quoted = false,
    closed = false,
    values = 0,
    fieldEnd = 0;
  const cell = (end) => {
    if (rows.length >= limits.maxRecords + 1)
      throw new Error("CSV: exceeds maxRecords");
    if (++values > limits.maxValues) throw new Error("CSV: exceeds maxValues");
    if (row.length >= limits.maxFields)
      throw new Error("CSV: exceeds maxFields");
    row.push(
      closed
        ? input.slice(start, fieldEnd).replaceAll('""', '"')
        : input.slice(start, end),
    );
    fieldEnd = 0;
    closed = false;
    start = at;
  };
  const endRow = (end) => {
    cell(end);
    if (rows.length >= limits.maxRecords + 1)
      throw new Error("CSV: exceeds maxRecords");
    rows.push(row);
    row = [];
  };
  while (at < input.length) {
    const c = input[at++];
    if (quoted) {
      if (c === '"') {
        if (input[at] === '"') {
          at++;
        } else {
          quoted = false;
          closed = true;
          fieldEnd = at - 1;
        }
      }
      continue;
    }
    if (c === ",") {
      cell(at - 1);
      continue;
    }
    if (c === "\n" || c === "\r") {
      const end = at - 1;
      if (c === "\r") {
        if (input[at] !== "\n") throw new Error("CSV: bare carriage return");
        at++;
      }
      endRow(end);
      continue;
    }
    if (closed) throw new Error("CSV: unexpected text after closing quote");
    if (c === '"') {
      if (at - 1 !== start) throw new Error("CSV: unexpected quote");
      quoted = true;
      start = at;
    }
  }
  if (quoted) throw new Error("CSV: unterminated quote");
  if (start < input.length || closed || row.length) endRow(at);
  if (!rows.length) throw new Error("CSV: missing header");
  const headers = rows.shift();
  if (headers.some((h) => !h)) throw new Error("CSV: empty header");
  unique(headers, "CSV headers");
  return {
    headers,
    rows: rows.map((r) => {
      if (r.length !== headers.length)
        throw new Error("CSV: row width differs from header");
      return Object.fromEntries(headers.map((h, i) => [h, r[i]]));
    }),
  };
}

function scalar(value, type) {
  // JSON numbers are deliberately rejected, including integers: numeric source
  // lexemes may have already lost information before arriving at this boundary.
  if (typeof value !== "string")
    throw new Error(`${type}: selected value must be a string`);
  if (type === "string") return value;
  if (type === "integer") {
    if (!/^-?(?:0|[1-9][0-9]*)$/u.test(value))
      throw new Error("integer: invalid exact spelling");
    return value === "-0" ? "0" : value;
  }
  if (!/^-?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$/u.test(value))
    throw new Error("decimal: invalid exact spelling");
  const negative = value.startsWith("-");
  let [whole, fraction = ""] = (negative ? value.slice(1) : value).split(".");
  whole = whole.replace(/^0+/u, "") || "0";
  fraction = fraction.replace(/0+$/u, "");
  return `${negative && (whole !== "0" || fraction) ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
function project(source, format, policy, side) {
  const input = decodeExportText(source);
  if (input.startsWith("\ufeff"))
    throw new Error("UTF-8 BOM is not supported; remove it explicitly");
  let rows, headers;
  if (format === "csv") ({ rows, headers } = csv(input, policy.limits));
  else {
    rows = parseExportJson(
      input,
      policy.limits.maxFields,
      policy.limits.maxRecords,
      policy.limits.maxValues,
    );
    if (!Array.isArray(rows))
      throw new Error("JSON: expected array of records");
    if (rows.length > policy.limits.maxRecords)
      throw new Error("JSON: exceeds maxRecords");
    headers = [];
    const names = new Set();
    for (const row of rows) {
      object(row, null, "JSON record");
      for (const name of Object.keys(row)) {
        names.add(name);
        if (names.size > policy.limits.maxFields)
          throw new Error("JSON: union of columns exceeds maxFields");
      }
    }
    headers = [...names];
  }
  // CSV headers establish selected columns even for zero rows. Empty JSON arrays
  // have no schema and therefore do not establish selected-field coverage.
  const selected = policy.fields.map((f) => f[side]);
  for (const name of selected)
    if (!headers.includes(name))
      throw new Error(`${side}: selected column missing: ${name}`);
  const records = new Map();
  for (const row of rows) {
    const pairs = policy.fields.map((f) => {
      if (!own(row, f[side]))
        throw new Error(`${side}: selected field missing: ${f[side]}`);
      return [f.name, scalar(row[f[side]], f.type)];
    });
    const value = Object.fromEntries(pairs);
    const keys = policy.keys.map((k) => value[k]);
    if (keys.some((k) => k === ""))
      throw new Error(`${side}: empty record key`);
    const key = JSON.stringify(keys);
    if (records.has(key))
      throw new Error(`${side}: duplicate record key ${key}`);
    records.set(key, value);
  }
  return {
    records,
    metadata: {
      file: policy[side].file,
      format,
      bytes: source.bytes,
      sha256: source.sha256,
      records: rows.length,
      excludedFields: headers.filter((h) => !selected.includes(h)).sort(),
    },
  };
}
export async function compareExports(policy, root) {
  const inputs = {};
  let admittedPolicy;
  try {
    validate(policy);
    policy = {
      ...policy,
      reference: { ...policy.reference },
      replacement: { ...policy.replacement },
      fields: policy.fields.map((field) => ({ ...field })),
      keys: [...policy.keys],
      limits: {
        ...policy.limits,
        maxValues: policy.limits.maxValues ?? 100000,
      },
    };
    admitPolicy(policy);
    admittedPolicy = policy;
    const sides = {};
    for (const side of ["reference", "replacement"]) {
      const source = await readBoundedExport(
        root,
        policy[side].file,
        policy.limits.maxBytes,
      );
      inputs[side] = {
        file: policy[side].file,
        bytes: source.bytes,
        sha256: source.sha256,
      };
      sides[side] = project(source, policy[side].format, policy, side);
    }
    const reference = sides.reference.records,
      replacement = sides.replacement.records;
    const missing = [...reference.keys()]
      .filter((k) => !replacement.has(k))
      .sort();
    const extra = [...replacement.keys()]
      .filter((k) => !reference.has(k))
      .sort();
    const changed = [...reference.keys()]
      .filter(
        (k) =>
          replacement.has(k) &&
          !isDeepStrictEqual(reference.get(k), replacement.get(k)),
      )
      .sort();
    return admitReport({
      version: 1,
      name: policy.name,
      status:
        missing.length || extra.length || changed.length ? "fail" : "pass",
      policy,
      reference: sides.reference.metadata,
      replacement: sides.replacement.metadata,
      missingReplacementKeys: missing.map((k) => JSON.parse(k)),
      extraReplacementKeys: extra.map((k) => JSON.parse(k)),
      changedRecords: changed.map((k) => ({
        key: JSON.parse(k),
        fields: policy.fields
          .filter(
            (f) => reference.get(k)[f.name] !== replacement.get(k)[f.name],
          )
          .map((f) => ({
            name: f.name,
            reference: reference.get(k)[f.name],
            replacement: replacement.get(k)[f.name],
          })),
      })),
      limitations: [
        "Offline selected export content only; vendor behavior, capture authenticity, persistence, permissions and live integrations are not verified.",
        "Row ordering and unselected fields are excluded. Decimal trailing zeros and leading zeros are normalized; no rounding, tolerance or currency conversion is applied.",
        "Entity identifiers and relationships compare literally; independent generated IDs require separate evidence-backed correspondence in the workflow evaluator.",
        "Files are read from the local input directory; no download is initiated and no export is executed. The input directory must be trusted and stable: path checks are not a sandbox against concurrent hostile filesystem changes.",
      ],
    });
  } catch (error) {
    const invalid = {
      version: 1,
      status: "invalid",
      ...(admittedPolicy ? { policy: admittedPolicy } : {}),
      inputs,
      reason:
        error instanceof Error ? error.message : "Export comparison failed",
    };
    try {
      return admitReport(invalid);
    } catch {
      // An error can include a very large duplicate key or other source value.
      // Keep the bounded policy and raw provenance, but explicitly omit that
      // oversized diagnostic. This envelope is below 2 MiB plus fixed metadata.
      invalid.reason =
        "report: invalid diagnostic exceeds 16 MiB; diagnostic detail omitted, policy and input provenance retained";
      return invalid;
    }
  }
}
