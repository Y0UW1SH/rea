import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { buildContractFixture } from "./lib/saas-api-contract-fixture.mjs";
import {
  inferContract,
  verifyContract,
  writeContract,
} from "./lib/saas-api-contract.mjs";
import {
  appendTransaction,
  contractFor,
  failTransaction,
  manifest,
  pairs,
  persist,
  setResponseBody,
  stage,
} from "./saas-api-contract-test-support.mjs";
import { setRequestBody } from "./saas-surface-test-support.mjs";

test("hash-only APQ references retain identity and refuse a different hash", async (t) => {
  const dir = await stage(t);
  const capture = buildContractFixture("reference-a");
  const apq = (hash) =>
    JSON.stringify({
      operationName: "ListCustomers",
      extensions: {
        persistedQuery: { version: 1, sha256Hash: hash.repeat(64) },
      },
    });
  setRequestBody(capture, "t8", apq("a"));
  await persist(dir, "hash-reference", capture);
  const inferred = await inferContract(
    { ...manifest(), captures: [{ file: "hash-reference.json" }] },
    dir,
  );
  assert.equal(inferred.status, "produced", inferred.report.reason);
  const out = join(dir, "hash-contract");
  await writeContract(out, inferred);
  const same = await verifyContract(out, dir, "hash-reference.json");
  assert.equal(same.status, "pass");
  setRequestBody(
    capture,
    "t8",
    apq("a").replace('"version":1', '"version":1.0000000000000001'),
  );
  await persist(dir, "rounded-version", capture);
  const rounded = await verifyContract(out, dir, "rounded-version.json");
  assert.equal(rounded.status, "unknown");
  assert.equal(rounded.unverified_graphql_transactions, 1);
  setRequestBody(capture, "t8", apq("b"));
  await persist(dir, "other-hash", capture);
  const different = await verifyContract(out, dir, "other-hash.json");
  assert.equal(different.status, "fail");
  assert.ok(
    different.findings.some((f) => f.kind === "unmatched_graphql_operation"),
  );
});

test("unidentified GraphQL reference envelopes preserve uncertainty", async (t) => {
  const dir = await stage(t);
  for (const [name, request, redacted] of [
    [
      "inconsistent-hash",
      {
        query: "query ListCustomers { id }",
        extensions: {
          persistedQuery: { version: 1, sha256Hash: "a".repeat(64) },
        },
      },
      false,
    ],
    ["missing-hash", { extensions: { persistedQuery: { version: 1 } } }, false],
    ["redacted-request", { query: "query ListCustomers { id }" }, true],
  ]) {
    const capture = buildContractFixture("reference-a");
    setRequestBody(capture, "t8", JSON.stringify(request));
    capture.events.items.find(
      (e) =>
        e.transaction_id === "t8" &&
        e.kind === "network-content" &&
        e.phase === "request",
    ).body.redacted = redacted;
    await persist(dir, name, capture);
    const inferred = await inferContract(
      { ...manifest(), captures: [{ file: `${name}.json` }] },
      dir,
    );
    assert.equal(inferred.status, "produced", inferred.report.reason);
    const out = join(dir, `${name}-contract`);
    await writeContract(out, inferred);
    const report = await verifyContract(out, dir, `${name}.json`);
    assert.equal(report.status, "unknown", name);
    assert.equal(report.unverified_graphql_transactions, 1, name);
  }
});

for (const omission of [
  "not-requested",
  "truncated",
  "unparseable",
  "redacted-envelope",
  "failed-request",
]) {
  test(`missing GraphQL reference identity stays unknown: ${omission}`, async (t) => {
    const dir = await stage(t);
    const reference = buildContractFixture("reference-b");
    const event = reference.events.items.find(
      (e) =>
        e.transaction_id === "t8" &&
        e.kind === "network-content" &&
        e.phase === "request",
    );
    if (omission === "truncated")
      event.body = { state: "unavailable", reason: "body-size-limit" };
    else if (omission === "unparseable") setRequestBody(reference, "t8", "{");
    else if (omission === "redacted-envelope") {
      setRequestBody(reference, "t8", '"[REDACTED]"');
      event.body.redacted = true;
    } else event.body = { state: "not_requested" };
    if (omission === "failed-request")
      failTransaction(reference, "t8", "net::ERR_FAILED");
    await persist(dir, "missing-reference", reference);
    const replacement = buildContractFixture("reference-a");
    setRequestBody(
      replacement,
      "t8",
      JSON.stringify({
        operationName: "ListCustomers",
        query:
          "query ListCustomers($first: Int) { otherCustomers(first: $first) { id name } }",
        variables: { first: 10 },
      }),
    );
    await persist(dir, "other-document", replacement);
    // Missing evidence must survive either capture ordering, without classifying REST as GraphQL.
    for (const files of [
      ["reference-a.json", "missing-reference.json"],
      ["missing-reference.json", "reference-a.json"],
    ]) {
      const inferred = await inferContract(
        { ...manifest(), captures: files.map((file) => ({ file })) },
        dir,
      );
      assert.equal(inferred.status, "produced", inferred.report.reason);
      const out = join(dir, `missing-contract-${files[0]}`);
      await writeContract(out, inferred);
      const report = await verifyContract(out, dir, "other-document.json");
      assert.equal(
        report.status,
        "unknown",
        JSON.stringify(report.findings ?? report.reason),
      );
      assert.equal(report.unverified_graphql_transactions, 1);
      assert.equal(
        inferred.openapi.paths["/graphql"].post[
          "x-rea-graphql-unidentified-samples"
        ],
        1,
      );
      assert.equal(
        Object.hasOwn(
          inferred.openapi.paths["/api/invoices"].post,
          "x-rea-graphql-operations",
        ),
        false,
      );
    }
  });
}

test("verification does not turn unsupported JSON numbers into schema drift", async (t) => {
  const dir = await stage(t);
  for (const number of ["1e999", "1e-999", "1.0000000000000001"]) {
    const reference = buildContractFixture("reference-a");
    setResponseBody(reference, "t8", `{"data":{"value":${number}}}`);
    await persist(dir, "numeric-reference", reference);
    const inferred = await inferContract(
      { ...manifest(), captures: [{ file: "numeric-reference.json" }] },
      dir,
    );
    assert.equal(inferred.status, "produced", inferred.report.reason);
    const out = join(dir, `numeric-contract-${number}`);
    await writeContract(out, inferred);
    const report = await verifyContract(out, dir, "numeric-reference.json");
    assert.equal(
      report.status,
      "unknown",
      `${number}: ${JSON.stringify(report.findings ?? report.reason)}`,
    );
    assert.deepEqual(report.findings, []);
    assert.ok(report.unverified_bodies > 0);
    assert.equal(report.unverified_graphql_transactions, 1);
  }
});

test("unsupported numbers keep REST conformance unknown despite other verified responses", async (t) => {
  const { dir, out } = await contractFor(t);
  const replacement = buildContractFixture("replacement");
  setResponseBody(replacement, "t2", '{"id":1,"name":false}');
  await persist(dir, "rest-drift", replacement);
  const drift = await verifyContract(out, dir, "rest-drift.json", {
    originPairs: pairs,
  });
  assert.equal(drift.status, "fail");
  assert.ok(
    drift.findings.some((finding) => finding.instance_path === "/name"),
  );
  setResponseBody(replacement, "t2", '{"id":1e999,"name":false}');
  await persist(dir, "inexact-rest", replacement);
  const inexact = await verifyContract(out, dir, "inexact-rest.json", {
    originPairs: pairs,
  });
  assert.equal(inexact.status, "unknown");
  assert.equal(inexact.unverified_numeric_bodies, 1);
  assert.ok(inexact.verified_response_bodies > 0);
});

test("redacted GraphQL reference responses cannot establish complete conformance", async (t) => {
  const dir = await stage(t);
  const capture = buildContractFixture("reference-a");
  capture.events.items.find(
    (e) =>
      e.transaction_id === "t8" &&
      e.kind === "network-content" &&
      e.phase === "response",
  ).body.redacted = true;
  await persist(dir, "redacted-reference", capture);
  const inferred = await inferContract(
    {
      ...manifest(),
      captures: [
        { file: "redacted-reference.json" },
        { file: "reference-a.json" },
      ],
    },
    dir,
  );
  assert.equal(inferred.status, "produced", inferred.report.reason);
  const out = join(dir, "redacted-contract");
  await writeContract(out, inferred);
  const report = await verifyContract(out, dir, "reference-a.json");
  assert.equal(report.status, "unknown");
  assert.equal(report.unverified_graphql_transactions, 1);
});

test("required coverage is independent of sparse-capture conformance and business compatibility", async (t) => {
  const { dir, out } = await contractFor(t);
  const sparse = buildContractFixture("replacement");
  sparse.events.items = sparse.events.items.filter(
    (event) => event.transaction_id === "t1",
  );
  sparse.events.retained = sparse.events.items.length;
  await persist(dir, "sparse-policy", sparse);
  const report = await verifyContract(out, dir, "sparse-policy.json", {
    originPairs: pairs,
    requiredOperations: [
      { method: "GET", path: "/api/invoices" },
      { method: "POST", path: "/graphql" },
    ],
  });
  assert.equal(report.status, "pass");
  assert.ok(report.conclusions);
  assert.equal(report.conclusions.conformance.status, "pass");
  assert.equal(report.conclusions.required_coverage.status, "incomplete");
  assert.deepEqual(report.conclusions.required_coverage.missing, [
    { method: "POST", path: "/graphql" },
  ]);
  assert.equal(report.conclusions.business_compatibility.status, "unknown");
  const invalid = await verifyContract(out, dir, "sparse-policy.json", {
    originPairs: pairs,
    requiredOperations: [{ method: "GET", path: "/not-in-contract" }],
  });
  assert.equal(invalid.status, "invalid");
});

test("required coverage owns selectors before asynchronous reads and after returning", async (t) => {
  const { dir, out } = await contractFor(t);
  const sparse = buildContractFixture("replacement");
  sparse.events.items = sparse.events.items.filter(
    (event) => event.transaction_id === "t1",
  );
  sparse.events.retained = sparse.events.items.length;
  await persist(dir, "mutable-policy", sparse);
  const requiredOperations = [{ method: "POST", path: "/graphql" }];
  const pending = verifyContract(out, dir, "mutable-policy.json", {
    originPairs: pairs,
    requiredOperations,
  });
  Object.assign(requiredOperations[0], {
    method: "GET",
    path: "/api/invoices",
  });
  const report = await pending;
  assert.equal(report.conclusions.required_coverage.status, "incomplete");
  assert.deepEqual(report.conclusions.required_coverage.required, [
    { method: "POST", path: "/graphql" },
  ]);
  const settled = await verifyContract(out, dir, "mutable-policy.json", {
    originPairs: pairs,
    requiredOperations,
  });
  Object.assign(requiredOperations[0], { method: "POST", path: "/graphql" });
  assert.deepEqual(settled.conclusions.required_coverage, {
    status: "complete",
    required: [{ method: "GET", path: "/api/invoices" }],
    missing: [],
  });
});

test("GraphQL verification distinguishes same-name documents and validates each response schema", async (t) => {
  const dir = await stage(t);
  const reference = buildContractFixture("reference-b");
  setRequestBody(
    reference,
    "t8",
    JSON.stringify({
      operationName: "ListCustomers",
      query: "query ListCustomers { balance }",
      variables: { first: "ten" },
    }),
  );
  setResponseBody(reference, "t8", JSON.stringify({ data: { balance: 10 } }));
  await persist(dir, "second-graphql", reference);
  const inferred = await inferContract(
    {
      ...manifest(),
      options: { ...manifest().options, required_min_samples: 1 },
      captures: [{ file: "reference-a.json" }, { file: "second-graphql.json" }],
    },
    dir,
  );
  assert.equal(inferred.status, "produced", inferred.report.reason);
  const out = join(dir, "graphql-contract");
  await writeContract(out, inferred);
  const replacement = buildContractFixture("replacement");
  setResponseBody(replacement, "t8", JSON.stringify({ data: { balance: 10 } }));
  await persist(dir, "swapped-graphql", replacement);
  const report = await verifyContract(out, dir, "swapped-graphql.json", {
    originPairs: pairs,
  });
  assert.equal(report.status, "fail");
  assert.ok(
    report.findings.some(
      (f) =>
        f.graphql_operation &&
        f.side === "response" &&
        f.keyword === "required",
    ),
  );
  assert.equal(report.unexercised_graphql_operations.length, 1);
  setResponseBody(
    replacement,
    "t8",
    JSON.stringify({ data: { customers: [{ id: "1", name: "Customer" }] } }),
  );
  setRequestBody(
    replacement,
    "t8",
    JSON.stringify({
      operationName: "ListCustomers",
      query:
        "query ListCustomers($first: Int) { customers(first: $first) { id name } }",
      variables: { first: "ten" },
    }),
  );
  await persist(dir, "wrong-variables", replacement);
  const variables = await verifyContract(out, dir, "wrong-variables.json", {
    originPairs: pairs,
  });
  assert.equal(variables.status, "fail");
  assert.ok(
    variables.findings.some(
      (f) =>
        f.graphql_operation &&
        f.side === "request" &&
        f.instance_path === "/variables/first",
    ),
  );
});

test("GraphQL identity cannot be established by a response or operation name alone", async (t) => {
  const { dir, out } = await contractFor(t);
  const capture = buildContractFixture("replacement");
  capture.events.items = capture.events.items.filter(
    (event) =>
      !(
        event.transaction_id === "t8" &&
        event.kind === "network-content" &&
        event.phase === "request"
      ),
  );
  capture.events.retained = capture.events.items.length;
  await persist(dir, "no-graphql-request", capture);
  const missing = await verifyContract(out, dir, "no-graphql-request.json", {
    originPairs: pairs,
  });
  assert.equal(missing.status, "unknown");
  assert.equal(missing.unverified_graphql_transactions, 1);
  const changed = buildContractFixture("replacement");
  setRequestBody(
    changed,
    "t8",
    JSON.stringify({
      operationName: "ListCustomers",
      query: "query ListCustomers { differentService }",
    }),
  );
  await persist(dir, "unknown-document", changed);
  const unknown = await verifyContract(out, dir, "unknown-document.json", {
    originPairs: pairs,
  });
  assert.equal(unknown.status, "fail");
  assert.ok(
    unknown.findings.some((f) => f.kind === "unmatched_graphql_operation"),
  );
});

test("GraphQL response omissions stay unknown and APQ retains operation identity", async (t) => {
  const dir = await stage(t);
  const reference = buildContractFixture("reference-a");
  const requestEvent = reference.events.items.find(
    (e) =>
      e.transaction_id === "t8" &&
      e.kind === "network-content" &&
      e.phase === "request",
  );
  const request = JSON.parse(
    Buffer.from(requestEvent.body.content, "base64").toString(),
  );
  const { createHash } = await import("node:crypto");
  const hash = createHash("sha256").update(request.query).digest("hex");
  setRequestBody(
    reference,
    "t8",
    JSON.stringify({
      ...request,
      extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
    }),
  );
  const response = reference.events.items.find(
    (e) =>
      e.transaction_id === "t8" &&
      e.kind === "network-content" &&
      e.phase === "response",
  );
  response.body = { state: "not_requested" };
  await persist(dir, "apq-reference", reference);
  const inferred = await inferContract(
    { ...manifest(), captures: [{ file: "apq-reference.json" }] },
    dir,
  );
  assert.equal(inferred.status, "produced", inferred.report.reason);
  const out = join(dir, "apq-contract");
  await writeContract(out, inferred);
  setRequestBody(
    reference,
    "t8",
    JSON.stringify({
      operationName: request.operationName,
      variables: request.variables,
      extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
    }),
  );
  await persist(dir, "apq-only", reference);
  const report = await verifyContract(out, dir, "apq-only.json");
  assert.equal(report.status, "unknown");
  assert.equal(report.unexercised_graphql_operations.length, 0);
  assert.equal(report.unverified_graphql_transactions, 1);
});

// Behaviours found by the independent review of the first increment: every case here
// describes a replacement or capture shape that used to pass, crash or round-trip badly.

test("verify flags wrong media types on matched operations and ignores unmatched non-JSON noise", async (t) => {
  const { dir, out } = await contractFor(t);
  const html = buildContractFixture("replacement");
  setResponseBody(html, "t2", "<html>fallback</html>", "text/html");
  await persist(dir, "html", html);
  const report = await verifyContract(out, dir, "html.json", {
    originPairs: pairs,
  });
  assert.equal(report.status, "fail");
  const finding = report.findings.find(
    (candidate) =>
      candidate.kind === "structural" && candidate.keyword === "mediaType",
  );
  assert.ok(finding, JSON.stringify(report.findings));
  assert.equal(finding.path, "/api/customers/{numeric_2}");
  assert.equal(finding.side, "response");
  assert.equal(report.excluded["non-json-body"], 1);
  assert.equal(
    report.findings.some(
      (candidate) => candidate.kind === "unmatched_operation",
    ),
    false,
  );
});

test("verify is unknown without verified response bodies or a complete capture, and lists unexercised operations", async (t) => {
  const { dir, out } = await contractFor(t);
  const noResponses = buildContractFixture("replacement");
  noResponses.scenario.network_content.response_body = false;
  noResponses.events.items = noResponses.events.items.filter(
    (event) =>
      !(event.kind === "network-content" && event.phase === "response"),
  );
  noResponses.events.retained = noResponses.events.items.length;
  await persist(dir, "no-responses", noResponses);
  const blind = await verifyContract(out, dir, "no-responses.json", {
    originPairs: pairs,
  });
  assert.equal(blind.status, "unknown", JSON.stringify(blind.findings));
  assert.equal(blind.verified_response_bodies, 0);
  assert.ok(blind.unverified_bodies > 0);
  assert.equal(blind.excluded["unmatched-without-body"], 1);
  const partial = buildContractFixture("replacement");
  partial.completeness = {
    status: "incomplete",
    equality_eligible: false,
    missing_sections: ["events"],
    truncated_sections: [],
  };
  partial.events.dropped = 3;
  partial.events.omissions.by_kind = [
    { kind: "request", count: 3, reasons: ["max-events"] },
  ];
  await persist(dir, "partial", partial);
  const incomplete = await verifyContract(out, dir, "partial.json", {
    originPairs: pairs,
  });
  assert.equal(incomplete.status, "unknown");
  assert.deepEqual(incomplete.capture.completeness, {
    status: "incomplete",
    dropped: 3,
  });
  const sparse = buildContractFixture("replacement");
  sparse.events.items = sparse.events.items.filter(
    (event) => event.transaction_id === "t1",
  );
  sparse.events.retained = sparse.events.items.length;
  await persist(dir, "sparse", sparse);
  const few = await verifyContract(out, dir, "sparse.json", {
    originPairs: pairs,
  });
  assert.equal(few.status, "pass");
  assert.deepEqual(
    few.unexercised_operations.map(
      (operation) => `${operation.method} ${operation.path}`,
    ),
    [
      "GET /api/customers/{numeric_2}",
      "POST /api/invoices",
      "GET /api/invoices/{numeric_2}",
      "GET /api/reports/{iso-date_2}",
      "POST /graphql",
    ],
  );
});

test("failed and unfinished requests are recorded, not modeled as default responses", async (t) => {
  const dir = await stage(t);
  const failed = buildContractFixture("reference-a");
  failTransaction(failed, "t9", "net::ERR_FAILED");
  failed.events.items.find(
    (event) => event.transaction_id === "t1" && event.kind === "response",
  ).status = 302;
  await persist(dir, "failed-a", failed);
  const inferred = await inferContract(
    {
      ...manifest(),
      captures: [{ file: "failed-a.json" }, { file: "reference-b.json" }],
    },
    dir,
  );
  assert.equal(inferred.status, "produced", inferred.report.reason);
  const invoice = inferred.openapi.paths["/api/invoices/{numeric_2}"].get;
  assert.equal(Object.hasOwn(invoice.responses, "default"), false);
  assert.deepEqual(invoice["x-rea-failures"], {
    count: 1,
    reasons: ["net::ERR_FAILED"],
  });
  assert.deepEqual(Object.keys(invoice.responses), ["200", "404"]);
  const list = inferred.openapi.paths["/api/invoices"].get;
  assert.deepEqual(Object.keys(list.responses), ["200", "302"]);
  assert.ok(list["x-rea-unknowns"].includes("error-responses-unobserved"));
  const out = join(dir, "contract");
  await writeContract(out, await inferContract(manifest(), dir));
  const replacement = buildContractFixture("replacement");
  failTransaction(replacement, "t7", "net::ERR_CONNECTION_RESET");
  await persist(dir, "failed-replacement", replacement);
  const report = await verifyContract(out, dir, "failed-replacement.json", {
    originPairs: pairs,
  });
  assert.equal(report.status, "fail");
  const finding = report.findings.find(
    (candidate) => candidate.kind === "failed_request",
  );
  assert.ok(finding, JSON.stringify(report.findings));
  assert.equal(finding.path, "/api/invoices");
  assert.equal(finding.message, "net::ERR_CONNECTION_RESET");
});

test("every reference capture verifies against its own contract, including deep bodies and sparse samples", async (t) => {
  const { dir, out } = await contractFor(t);
  for (const file of ["reference-a.json", "reference-b.json"]) {
    const self = await verifyContract(out, dir, file, {});
    assert.equal(
      self.status,
      "pass",
      `${file}: ${JSON.stringify(self.findings ?? self.reason)}`,
    );
  }
  const edge = buildContractFixture("reference-a");
  let nested = { leaf: "1" };
  for (let depth = 0; depth < 14; depth += 1) nested = { level: nested };
  setResponseBody(edge, "t9", JSON.stringify(nested));
  setResponseBody(
    edge,
    "t2",
    JSON.stringify({
      id: 1,
      uid: "0f8fad5b-d9cb-469f-a165-70867728950e",
      day: "2026-02-30",
      amount: "1.50",
    }),
  );
  setResponseBody(
    edge,
    "t3",
    JSON.stringify({ id: 2, uid: "", day: "2026-10-20", amount: "" }),
  );
  await persist(dir, "edge", edge);
  const inferred = await inferContract(
    { ...manifest(), captures: [{ file: "edge.json" }] },
    dir,
  );
  assert.equal(inferred.status, "produced", inferred.report.reason);
  const deep = join(dir, "deep-contract");
  await writeContract(deep, inferred);
  const self = await verifyContract(deep, dir, "edge.json", {});
  assert.equal(
    self.status,
    "pass",
    JSON.stringify(self.findings ?? self.reason),
  );
});

test("empty bodies, declared origins and duplicate captures are handled explicitly", async (t) => {
  const dir = await stage(t);
  const withDelete = buildContractFixture("reference-a");
  appendTransaction(withDelete, {
    id: "t12",
    method: "DELETE",
    path: "/api/invoices/9810",
    status: 204,
    body: "",
    mediaType: null,
  });
  await persist(dir, "with-delete", withDelete);
  const inferred = await inferContract(
    { ...manifest(), captures: [{ file: "with-delete.json" }] },
    dir,
  );
  assert.equal(inferred.status, "produced", inferred.report.reason);
  const remove = inferred.openapi.paths["/api/invoices/{numeric_2}"].delete;
  assert.ok(
    remove,
    Object.keys(inferred.openapi.paths["/api/invoices/{numeric_2}"]).join(","),
  );
  assert.deepEqual(Object.keys(remove.responses), ["204"]);
  assert.equal(Object.hasOwn(remove.responses["204"], "content"), false);
  assert.equal(remove.responses["204"]["x-rea-empty-bodies"], 1);
  const typo = await inferContract(
    { ...manifest(), origins: ["https://nothing.example.test"] },
    dir,
  );
  assert.equal(typo.status, "invalid");
  assert.match(typo.report.reason, /no admitted transaction/u);
  const scripts = await inferContract(
    { ...manifest(), resource_types: ["script"] },
    dir,
  );
  assert.equal(scripts.status, "invalid");
  const duplicate = await inferContract(
    {
      ...manifest(),
      captures: [{ file: "reference-a.json" }, { file: "reference-a.json" }],
    },
    dir,
  );
  assert.equal(duplicate.status, "invalid");
  assert.match(duplicate.report.reason, /duplicate capture/u);
  const truncated = manifest();
  truncated.limits.maxEvidencePerOperation = 1;
  const evidence = (await inferContract(truncated, dir)).openapi.paths[
    "/api/customers/{numeric_2}"
  ].get["x-rea-evidence"];
  assert.equal(evidence.transactions.length, 1);
  assert.equal(evidence.evidence_truncated, true);
  assert.deepEqual(
    evidence.captures.map((capture) => capture.file),
    ["reference-a.json", "reference-b.json"],
  );
});
