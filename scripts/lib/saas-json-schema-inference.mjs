import { parseExportJson } from "./saas-export-comparison.mjs";

// Value-free JSON Schema inference over observed samples. Every inference is marked:
// required-ness and enum candidates come with sample counts, formats need every sample to
// agree, and number lexemes (not JavaScript Numbers) decide integer versus number.

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

const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

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
    node.strings ??= {
      samples: 0,
      redacted: 0,
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
    if (value.length > 0) {
      strings.nonEmpty += 1;
      if (UUID.test(value)) strings.uuid += 1;
      if (DATE_TIME.test(value)) strings.dateTime += 1;
      if (DATE.test(value)) strings.date += 1;
      if (DECIMAL.test(value)) strings.decimal += 1;
    }
    if (strings.distinct.has(value)) return;
    if (strings.distinct.size < MAX_DISTINCT_TRACKED)
      strings.distinct.add(value);
    else strings.overflow = true;
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

function render(node, options) {
  const types = [...node.types]
    .map((type) =>
      type === "number" && node.numbers.decimals === 0 ? "integer" : type,
    )
    .sort(compare);
  const schema = {};
  if (types.length === 1) schema.type = types[0];
  else if (types.length > 1) schema.type = types;
  if (node.numbers?.unsafe)
    schema["x-rea-exactness"] = "unsafe-integer-observed";
  if (node.properties !== null) {
    const keys = [...node.properties.keys()].sort(compare);
    const properties = {};
    const presence = {};
    const required = [];
    for (const key of keys) {
      const entry = node.properties.get(key);
      properties[key] = render(entry.node, options);
      presence[key] = { seen: entry.seen, samples: node.objects };
      if (
        entry.seen === node.objects &&
        node.objects >= options.required_min_samples
      )
        required.push(key);
    }
    schema.properties = properties;
    if (required.length > 0) {
      schema.required = required;
      schema["x-rea-basis"] = "inferred";
    }
    schema["x-rea-presence"] = presence;
  }
  if (node.items !== null) schema.items = render(node.items, options);
  if (node.strings !== null) {
    const strings = node.strings;
    const unredacted = strings.samples - strings.redacted;
    if (unredacted >= options.format_min_samples && strings.nonEmpty > 0) {
      if (strings.uuid === strings.nonEmpty) schema.format = "uuid";
      else if (strings.dateTime === strings.nonEmpty)
        schema.format = "date-time";
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
      schema["x-rea-enum-candidates"] = [...strings.distinct].sort(compare);
  }
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
