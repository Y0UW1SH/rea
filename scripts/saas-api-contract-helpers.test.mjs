import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordedPath,
  routeTemplate,
  segmentRule,
} from "./lib/saas-route-templates.mjs";
import {
  originCorrespondence,
  parseOriginPairs,
} from "./lib/saas-origin-pairs.mjs";
import {
  assembleTransactions,
  readScenarioCapture,
} from "./lib/saas-scenario-capture.mjs";
import {
  NumberLexeme,
  createSchemaAccumulator,
  parseJsonForInference,
} from "./lib/saas-json-schema-inference.mjs";

const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const options = {
  required_min_samples: 3,
  enum_max_cardinality: 8,
  enum_min_samples: 5,
  format_min_samples: 2,
};

test("segment rules mirror the four exact api-surface formats", () => {
  assert.equal(segmentRule("9810"), "numeric");
  assert.equal(segmentRule(UUID), "uuid");
  assert.equal(segmentRule(UUID.toUpperCase()), "uuid");
  assert.equal(segmentRule("a".repeat(32)), "hex");
  assert.equal(segmentRule("a".repeat(31)), null);
  assert.equal(segmentRule("2026-10-20"), "iso-date");
  assert.equal(segmentRule("2026-02-30"), null);
  assert.equal(segmentRule("invoices"), null);
  assert.equal(segmentRule(""), null);
});

test("route templates replace matched segments and index them from the first segment", () => {
  const route = routeTemplate(`/api/invoices/9810/lines/${UUID}`);
  assert.equal(route.template, "/api/invoices/{numeric}/lines/{uuid}");
  assert.deepEqual(route.segments, [
    { segment_index: 2, rule: "numeric", value: "9810" },
    { segment_index: 4, rule: "uuid", value: UUID },
  ]);
  assert.equal(route.rules, "2:numeric;4:uuid;");
  assert.deepEqual(routeTemplate("/"), {
    template: "/",
    rules: "",
    segments: [],
  });
  assert.equal(routeTemplate("/a//b").template, "/a//b");
});

test("recorded paths keep raw spelling and drop query, fragment and credentials", () => {
  assert.deepEqual(recordedPath("https://app.example.test/api/x?y=1#f"), {
    origin: "https://app.example.test",
    path: "/api/x",
  });
  assert.deepEqual(recordedPath("https://app.example.test"), {
    origin: "https://app.example.test",
    path: "/",
  });
  assert.deepEqual(recordedPath("https://a.test/a/../b"), {
    origin: "https://a.test",
    path: "/a/../b",
  });
  assert.deepEqual(recordedPath("https://user:pw@a.test:8443/x"), {
    origin: "https://a.test:8443",
    path: "/x",
  });
  assert.equal(recordedPath("/relative/path"), null);
  assert.equal(recordedPath("not a url"), null);
  assert.equal(recordedPath("https://a.test\\x"), null);
});

test("origin pairs accept canonical origins only and stay one-to-one", () => {
  const pairs = parseOriginPairs(
    [
      {
        before_origin: "https://app.example.test",
        after_origin: "http://localhost:4300",
      },
      {
        before_origin: "wss://stream.example.test",
        after_origin: "ws://localhost:5000",
      },
    ],
    "origin_pairs",
  );
  assert.equal(pairs.length, 2);
  for (const bad of [
    [
      {
        before_origin: "https://app.example.test/",
        after_origin: "http://localhost:4300",
      },
    ],
    [{ before_origin: "file://", after_origin: "http://localhost:4300" }],
    [
      { before_origin: "https://a.test", after_origin: "http://l:1" },
      { before_origin: "https://a.test", after_origin: "http://l:2" },
    ],
    [
      { before_origin: "https://a.test", after_origin: "http://l:1" },
      { before_origin: "https://b.test", after_origin: "http://l:1" },
    ],
    [{ before_origin: "https://a.test" }],
    "https://a.test",
  ])
    assert.throws(() => parseOriginPairs(bad, "origin_pairs"));
});

test("origin correspondence tokens pair declared origins and keep others literal", () => {
  const pairs = parseOriginPairs(
    [
      {
        before_origin: "https://app.example.test",
        after_origin: "http://localhost:4300",
      },
    ],
    "origin_pairs",
  );
  const { token } = originCorrespondence(pairs);
  assert.equal(
    token("https://app.example.test", "before"),
    "origin-correspondence:0",
  );
  assert.equal(
    token("http://localhost:4300", "after"),
    "origin-correspondence:0",
  );
  assert.equal(
    token("http://localhost:4300", "before"),
    "literal:http://localhost:4300",
  );
  assert.equal(
    token("https://other.test", "after"),
    "literal:https://other.test",
  );
  assert.equal(
    originCorrespondence([]).token("https://x.test", "before"),
    "https://x.test",
  );
});

const body = (text) => {
  const bytes = Buffer.from(text, "utf8");
  return {
    state: "captured",
    representation: "playwright-response-body-bytes",
    encoding: "base64",
    content: bytes.toString("base64"),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    media_type: "application/json",
    redacted: false,
  };
};
const url = (value) => ({
  url: value,
  origin: new URL(value).origin,
  query_parameter_names: [],
  redacted: false,
});
const capture = (events) => ({
  scenario: {
    network_content: {
      request_body: true,
      response_body: true,
      header_values: false,
    },
  },
  steps: [
    { step_index: 0, step_id: "scenario_start" },
    { step_index: 1, step_id: "open-invoices" },
  ],
  events: { items: events },
  completeness: { status: "complete" },
});
const request = (sequence, step_index, id, method, value) => ({
  sequence,
  step_index,
  kind: "request",
  transaction_id: id,
  method,
  url: url(value),
  resource_type: "fetch",
  header_names: ["accept"],
  status: null,
});
const response = (sequence, step_index, id, value, status) => ({
  sequence,
  step_index,
  kind: "response",
  transaction_id: id,
  method: "GET",
  url: url(value),
  resource_type: "fetch",
  header_names: ["content-type"],
  status,
});
const content = (sequence, step_index, id, phase, source, text) => ({
  sequence,
  step_index,
  kind: "network-content",
  transaction_id: id,
  phase,
  source_event_sequence: source,
  headers: { state: "not_requested" },
  body: body(text),
});

test("transactions join request, response and content and inherit the request step", () => {
  const target = "https://app.example.test/api/invoices/9810";
  const [transaction] = assembleTransactions(
    capture([
      request(1, 1, "t1", "GET", target),
      response(2, 1, "t1", target, 200),
      content(3, 1, "t1", "response", 2, '{"id":9810}'),
    ]),
    { maxTransactions: 10 },
  );
  assert.equal(transaction.transaction_id, "t1");
  assert.equal(transaction.step_id, "open-invoices");
  assert.equal(transaction.method, "GET");
  assert.equal(transaction.url.origin, "https://app.example.test");
  assert.equal(transaction.status, 200);
  assert.equal(transaction.response.body.state, "captured");
  assert.equal(transaction.response.body.media_type, "application/json");
  assert.equal(
    transaction.response.body.buffer.toString("utf8"),
    '{"id":9810}',
  );
  assert.equal(transaction.request.body.state, "absent");
});

test("content without its request keeps the receipt step and digest mismatches fail closed", () => {
  const target = "https://app.example.test/api/orphan";
  const [orphan] = assembleTransactions(
    capture([content(5, 1, "t9", "response", 4, "{}")]),
    { maxTransactions: 10 },
  );
  assert.equal(orphan.step_id, "open-invoices");
  assert.equal(orphan.method, null);
  const tampered = content(3, 1, "t1", "response", 2, '{"id":1}');
  tampered.body.sha256 = "0".repeat(64);
  assert.throws(
    () =>
      assembleTransactions(
        capture([
          request(1, 1, "t1", "GET", target),
          response(2, 1, "t1", target, 200),
          tampered,
        ]),
        { maxTransactions: 10 },
      ),
    /digest/,
  );
  assert.throws(
    () =>
      assembleTransactions(
        capture([
          request(1, 1, "a", "GET", target),
          request(2, 1, "b", "GET", target),
        ]),
        { maxTransactions: 1 },
      ),
    /maxTransactions/,
  );
});

test("reading a capture returns its bytes and digest and rejects unparseable files", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rea-contract-capture-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const text = JSON.stringify(capture([]));
  await writeFile(join(dir, "capture.json"), text);
  const read = await readScenarioCapture(dir, "capture.json", 1024 * 1024);
  assert.equal(read.bytes, Buffer.byteLength(text));
  assert.equal(read.sha256, createHash("sha256").update(text).digest("hex"));
  assert.deepEqual(read.capture.steps.length, 2);
  await writeFile(join(dir, "broken.json"), "[");
  await assert.rejects(readScenarioCapture(dir, "broken.json", 1024 * 1024));
  await assert.rejects(
    readScenarioCapture(dir, "../capture.json", 1024 * 1024),
  );
});

test("inference parsing keeps number lexemes", () => {
  const parsed = parseJsonForInference(
    '{"a":1,"b":1.0,"c":9007199254740993,"d":-0}',
  );
  for (const key of ["a", "b", "c", "d"])
    assert.ok(parsed[key] instanceof NumberLexeme);
  assert.equal(parsed.a.lexeme, "1");
  assert.equal(parsed.b.lexeme, "1.0");
  assert.equal(parsed.c.lexeme, "9007199254740993");
  assert.equal(parsed.d.lexeme, "-0");
  assert.throws(() => parseJsonForInference('{"a":1,"a":2}'), /duplicate/);
});

const sample = (id, name, when, uid, maybe) =>
  parseJsonForInference(
    JSON.stringify({ id, name, tags: ["x"], amount: "1.50", when, uid, maybe }),
  );

test("schemas merge types, presence, formats and enum candidates with evidence markers", () => {
  const accumulator = createSchemaAccumulator({ maxSchemaNodes: 1000 });
  const when = "2026-10-20T00:00:00.000Z";
  for (const index of [1, 2, 3])
    accumulator.add(sample(index, "a", when, UUID, null));
  accumulator.add(sample(4, "b", when, UUID.replace("0f8f", "1a2b"), { x: 1 }));
  const schema = accumulator.finish(options);
  assert.equal(schema.type, "object");
  assert.deepEqual(Object.keys(schema.properties), [
    "amount",
    "id",
    "maybe",
    "name",
    "tags",
    "uid",
    "when",
  ]);
  assert.equal(schema.properties.id.type, "integer");
  assert.equal(schema.properties.amount.pattern, "^-?[0-9]+\\.[0-9]+$");
  assert.equal(schema.properties.amount["x-rea-format"], "decimal-string");
  assert.equal(schema.properties.when.format, "date-time");
  assert.equal(schema.properties.uid.format, "uuid");
  assert.deepEqual(schema.properties.maybe.type, ["null", "object"]);
  assert.equal(schema.properties.tags.type, "array");
  assert.equal(schema.properties.tags.items.type, "string");
  assert.deepEqual(schema.required, [
    "amount",
    "id",
    "maybe",
    "name",
    "tags",
    "uid",
    "when",
  ]);
  assert.equal(schema["x-rea-basis"], "inferred");
  assert.equal(schema["x-rea-samples"], 4);
  assert.deepEqual(schema["x-rea-presence"].maybe, { seen: 4, samples: 4 });
  assert.equal(
    Object.hasOwn(schema.properties.name, "x-rea-enum-candidates"),
    false,
  );
  accumulator.add(sample(5, "a", when, UUID, null));
  const more = accumulator.finish(options);
  assert.deepEqual(more.properties.name["x-rea-enum-candidates"], ["a", "b"]);
  assert.equal(Object.hasOwn(more.properties.name, "enum"), false);
  assert.equal(
    JSON.stringify(more),
    JSON.stringify(accumulator.finish(options)),
  );
});

test("mixed numeric lexemes widen to number and unsafe integers are flagged", () => {
  const numbers = createSchemaAccumulator({ maxSchemaNodes: 100 });
  numbers.add(parseJsonForInference("[1, 2.5]"));
  assert.equal(numbers.finish(options).items.type, "number");
  const unsafe = createSchemaAccumulator({ maxSchemaNodes: 100 });
  unsafe.add(parseJsonForInference("[9007199254740993]"));
  const schema = unsafe.finish(options);
  assert.equal(schema.items.type, "integer");
  assert.equal(schema.items["x-rea-exactness"], "unsafe-integer-observed");
});

test("required needs enough samples, redacted bodies add structure only, node budget fails closed", () => {
  const sparse = createSchemaAccumulator({ maxSchemaNodes: 100 });
  sparse.add(parseJsonForInference('{"a":1}'));
  sparse.add(parseJsonForInference('{"a":2}'));
  assert.equal(Object.hasOwn(sparse.finish(options), "required"), false);
  const redacted = createSchemaAccumulator({ maxSchemaNodes: 100 });
  for (let index = 0; index < 6; index += 1)
    redacted.add(parseJsonForInference('{"token":"abc"}'), { redacted: true });
  const schema = redacted.finish(options);
  assert.equal(schema.properties.token.type, "string");
  assert.equal(
    Object.hasOwn(schema.properties.token, "x-rea-enum-candidates"),
    false,
  );
  const tiny = createSchemaAccumulator({ maxSchemaNodes: 2 });
  assert.throws(
    () => tiny.add(parseJsonForInference('{"a":{"b":{"c":1}}}')),
    /maxSchemaNodes/,
  );
});
