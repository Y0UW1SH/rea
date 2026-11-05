import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTRACT_FIXTURE_VARIANTS,
  buildContractFixture,
  contractFixtureManifest,
  serializeFixture,
} from "./lib/saas-api-contract-fixture.mjs";
import { inferContract, writeContract } from "./lib/saas-api-contract.mjs";

// Shared by the API contract node:test suites: staged fixture directories and
// capture mutations that keep every retained body digest consistent.

export const fixturesDirectory = fileURLToPath(
  new URL("./fixtures/saas-api-contract/", import.meta.url),
);
export const cliPath = fileURLToPath(
  new URL("./saas-api-contract.mjs", import.meta.url),
);
export const generatorPath = fileURLToPath(
  new URL("./saas-api-contract-fixtures.mjs", import.meta.url),
);
export const manifest = () => contractFixtureManifest();
export const pairs = [
  {
    before_origin: "https://app.example.test",
    after_origin: "http://localhost:4300",
  },
];

/** A temporary directory removed when the test ends. */
export async function scratch(t, prefix = "rea-contract-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Write the manifest and the requested fixture variants into a scratch directory. */
export async function stage(
  t,
  manifestValue = manifest(),
  variants = CONTRACT_FIXTURE_VARIANTS,
) {
  const dir = await scratch(t);
  await writeFile(join(dir, "manifest.json"), serializeFixture(manifestValue));
  for (const variant of variants)
    await writeFile(
      join(dir, `${variant}.json`),
      serializeFixture(buildContractFixture(variant)),
    );
  return dir;
}

/** Stage the fixtures, infer the committed manifest and write the contract. */
export async function contractFor(t, manifestValue = manifest()) {
  const dir = await stage(t, manifestValue);
  const inferred = await inferContract(manifestValue, dir);
  assert.equal(inferred.status, "produced", inferred.report.reason);
  const out = join(dir, "contract");
  await writeContract(out, inferred);
  return { dir, out, inferred };
}

export const persist = (dir, name, capture) =>
  writeFile(join(dir, `${name}.json`), serializeFixture(capture));

export const encodeBody = (text, mediaType, representation) => {
  const bytes = Buffer.from(text, "utf8");
  return {
    state: "captured",
    representation,
    encoding: "base64",
    content: bytes.toString("base64"),
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    media_type: mediaType,
    redacted: false,
  };
};

const responseContent = (capture, id) =>
  capture.events.items.find(
    (event) =>
      event.kind === "network-content" &&
      event.transaction_id === id &&
      event.phase === "response",
  );

/** Replace one transaction's response body with new JSON (or other) content. */
export function setResponseBody(
  capture,
  id,
  text,
  mediaType = "application/json",
) {
  responseContent(capture, id).body = encodeBody(
    text,
    mediaType,
    "playwright-response-body-bytes",
  );
}

/** Turn one transaction into a failed request with no response. */
export function failTransaction(capture, id, failure) {
  capture.events.items = capture.events.items.filter(
    (event) =>
      !(
        event.transaction_id === id &&
        (event.kind === "response" ||
          (event.kind === "network-content" && event.phase === "response"))
      ),
  );
  const finished = capture.events.items.find(
    (event) => event.transaction_id === id && event.kind === "request-finished",
  );
  finished.kind = "request-failed";
  finished.failure = failure;
  capture.events.retained = capture.events.items.length;
}

/** Append a complete transaction (request, response, content, finished) to step 2. */
export function appendTransaction(
  capture,
  { id, method, path, status, body, mediaType },
) {
  const origin = capture.scenario.start_origin;
  let sequence =
    Math.max(...capture.events.items.map((event) => event.sequence)) + 1;
  const url = {
    url: `${origin}${path}`,
    origin,
    query_parameter_names: [],
    redacted: false,
  };
  const base = {
    step_index: 2,
    transaction_id: id,
    redirected_from_transaction_id: null,
    redirected_from_transaction_state: "root",
    method,
    url,
    resource_type: "fetch",
    header_names: ["accept"],
    failure: null,
  };
  const request = {
    ...base,
    sequence: sequence++,
    kind: "request",
    status: null,
  };
  const response = { ...base, sequence: sequence++, kind: "response", status };
  const content = {
    sequence: sequence++,
    step_index: 2,
    kind: "network-content",
    transaction_id: id,
    phase: "response",
    source_event_sequence: response.sequence,
    headers: { state: "not_requested" },
    body: encodeBody(body, mediaType, "playwright-response-body-bytes"),
  };
  const finished = {
    ...base,
    sequence: sequence++,
    kind: "request-finished",
    status: null,
  };
  capture.events.items.push(request, response, content, finished);
  capture.events.retained = capture.events.items.length;
}
