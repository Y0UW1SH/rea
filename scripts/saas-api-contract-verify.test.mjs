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
