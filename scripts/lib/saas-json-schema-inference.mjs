import { parseExportJson } from "./saas-export-comparison.mjs";
import { compareCodePoints } from "./saas-ordering.mjs";

// Structure-first JSON Schema inference over observed samples. Every inference is
// marked: required-ness and enum candidates come with sample counts, formats need every
// sample (including empty strings) to agree, and number lexemes decide integer or number.

/** The original numeric token of one JSON value, preserved before any rounding. */
export class NumberLexeme {
  constructor(lexeme) {
    this.lexeme = lexeme;
  }
}

const INTEGER = /^-?(?:0|[1-9][0-9]*)$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DATE_TIME =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$/u;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u;
const DECIMAL = /^-?[0-9]+\.[0-9]+$/u;
export const DECIMAL_STRING_PATTERN = "^-?[0-9]+\\.[0-9]+$";
const MAX_DISTINCT_TRACKED = 64;

/** A calendar date that survives a UTC round trip, as ajv-formats and segmentRule demand. */
const isCalendarDate = (value) => {
  if (!DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
};
const isDateTime = (value) =>
  DATE_TIME.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  isCalendarDate(value.slice(0, 10));

/** Strict JSON parsing that hands number tokens to the inference untouched. */
export function parseJsonForInference(
  text,
  { maxFields = 1024, maxArrayLength = 100_000, maxValues = 1_000_000 } = {},
) {
  return parseExportJson(
    text,
    maxFields,
    maxArrayLength,
    maxValues,
    (lexeme) => new NumberLexeme(lexeme),
  );
}

function createNode(budget) {
  budget.count += 1;
  if (budget.count > budget.max)
    throw new Error(`schema: exceeds maxSchemaNodes (${budget.max})`);
  return {
    samples: 0,
    objects: 0,
    types: new Set(),
    properties: null,
    items: null,
    strings: null,
    numbers: null,
  };
}

function observeString(node, value, redacted) {
  node.strings ??= {
    samples: 0,
    redacted: 0,
    empty: 0,
    nonEmpty: 0,
    uuid: 0,
    dateTime: 0,
    date: 0,
    decimal: 0,
    distinct: new Set(),
    overflow: false,
  };
  const strings = node.strings;
  strings.samples += 1;
  if (redacted) {
    strings.redacted += 1;
    return;
  }
  if (value.length === 0) strings.empty += 1;
  else {
    strings.nonEmpty += 1;
    if (UUID.test(value)) strings.uuid += 1;
    if (isDateTime(value)) strings.dateTime += 1;
    if (isCalendarDate(value)) strings.date += 1;
    if (DECIMAL.test(value)) strings.decimal += 1;
  }
  if (strings.distinct.has(value)) return;
  if (strings.distinct.size < MAX_DISTINCT_TRACKED) strings.distinct.add(value);
  else strings.overflow = true;
}

function observe(node, value, redacted, budget) {
  node.samples += 1;
  if (value === null) {
    node.types.add("null");
    return;
  }
  if (value instanceof NumberLexeme) {
    node.types.add("number");
    node.numbers ??= { integers: 0, decimals: 0, unsafe: false };
    if (INTEGER.test(value.lexeme)) {
      node.numbers.integers += 1;
      if (!Number.isSafeInteger(Number(value.lexeme)))
        node.numbers.unsafe = true;
    } else node.numbers.decimals += 1;
    return;
  }
  if (typeof value === "boolean") {
    node.types.add("boolean");
    return;
  }
  if (typeof value === "string") {
    node.types.add("string");
    observeString(node, value, redacted);
    return;
  }
  if (Array.isArray(value)) {
    node.types.add("array");
    node.items ??= createNode(budget);
    for (const item of value) observe(node.items, item, redacted, budget);
    return;
  }
  node.types.add("object");
  node.objects += 1;
  node.properties ??= new Map();
  for (const [key, item] of Object.entries(value)) {
    let entry = node.properties.get(key);
    if (entry === undefined) {
      entry = { seen: 0, node: createNode(budget) };
      node.properties.set(key, entry);
    }
    entry.seen += 1;
    observe(entry.node, item, redacted, budget);
  }
}

function renderStrings(strings, schema, options) {
  const unredacted = strings.samples - strings.redacted;
  if (
    unredacted >= options.format_min_samples &&
    strings.nonEmpty > 0 &&
    strings.empty === 0
  ) {
    if (strings.uuid === strings.nonEmpty) schema.format = "uuid";
    else if (strings.dateTime === strings.nonEmpty) schema.format = "date-time";
    else if (strings.date === strings.nonEmpty) schema.format = "date";
    else if (strings.decimal === strings.nonEmpty) {
      schema.pattern = DECIMAL_STRING_PATTERN;
      schema["x-rea-format"] = "decimal-string";
    }
  }
  if (
    !strings.overflow &&
    unredacted >= options.enum_min_samples &&
    strings.distinct.size <= options.enum_max_cardinality
  )
    schema["x-rea-enum-candidates"] = [...strings.distinct].sort(
      compareCodePoints,
    );
}

function renderProperties(node, schema, options) {
  const keys = [...node.properties.keys()].sort(compareCodePoints);
  const required = [];
  // Object.fromEntries defines own properties, so a "__proto__" member stays data.
  schema.properties = Object.fromEntries(
    keys.map((key) => [key, render(node.properties.get(key).node, options)]),
  );
  const presence = Object.fromEntries(
    keys.map((key) => [
      key,
      { seen: node.properties.get(key).seen, samples: node.objects },
    ]),
  );
  for (const key of keys)
    if (
      node.properties.get(key).seen === node.objects &&
      node.objects >= options.required_min_samples
    )
      required.push(key);
  if (required.length > 0) {
    schema.required = required;
    schema["x-rea-basis"] = "inferred";
  }
  schema["x-rea-presence"] = presence;
}

function render(node, options) {
  const types = [...node.types]
    .map((type) =>
      type === "number" && node.numbers.decimals === 0 ? "integer" : type,
    )
    .sort(compareCodePoints);
  const schema = {};
  if (types.length === 1) schema.type = types[0];
  else if (types.length > 1) schema.type = types;
  if (node.numbers?.unsafe)
    schema["x-rea-exactness"] = "unsafe-integer-observed";
  if (node.properties !== null) renderProperties(node, schema, options);
  if (node.items !== null) schema.items = render(node.items, options);
  if (node.strings !== null) renderStrings(node.strings, schema, options);
  schema["x-rea-samples"] = node.samples;
  return schema;
}

/** Merge parsed samples into one schema; `finish` is pure and repeatable. */
export function createSchemaAccumulator({ maxSchemaNodes }) {
  if (!Number.isSafeInteger(maxSchemaNodes) || maxSchemaNodes < 1)
    throw new Error("maxSchemaNodes: expected positive integer");
  const budget = { count: 0, max: maxSchemaNodes };
  const root = createNode(budget);
  return {
    add(value, { redacted = false } = {}) {
      observe(root, value, redacted, budget);
    },
    finish(options) {
      for (const key of [
        "required_min_samples",
        "enum_max_cardinality",
        "enum_min_samples",
        "format_min_samples",
      ])
        if (!Number.isSafeInteger(options[key]) || options[key] < 1)
          throw new Error(`${key}: expected positive integer`);
      return render(root, options);
    },
    get samples() {
      return root.samples;
    },
  };
}
