import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CONTRACT_FIXTURE_VARIANTS,
  buildContractFixture,
  contractFixtureManifest,
  serializeFixture,
} from "./lib/saas-api-contract-fixture.mjs";
import {
  inferContract,
  validateContractManifest,
  verifyContract,
  writeContract,
} from "./lib/saas-api-contract.mjs";
import {
  cliPath,
  fixturesDirectory,
  generatorPath,
  manifest,
  pairs,
  stage,
} from "./saas-api-contract-test-support.mjs";

test("committed fixtures equal the deterministic builder output", async () => {
  for (const [name, expected] of [
    ["manifest.json", serializeFixture(contractFixtureManifest())],
    ...CONTRACT_FIXTURE_VARIANTS.map((variant) => [
      `${variant}.json`,
      serializeFixture(buildContractFixture(variant)),
    ]),
  ])
    assert.equal(
      await readFile(join(fixturesDirectory, name), "utf8"),
      expected,
      name,
    );
  const check = spawnSync(process.execPath, [generatorPath, "--check"], {
    encoding: "utf8",
  });
  assert.equal(check.status, 0, check.stderr);
});

test("manifest validation fails closed on unknown fields, bad limits and non-origins", () => {
  const valid = validateContractManifest(manifest());
  assert.deepEqual(valid.resource_types, ["fetch", "xhr"]);
  for (const modify of [
    (m) => {
      m.extra = 1;
    },
    (m) => {
      m.version = 2;
    },
    (m) => {
      m.captures = [];
    },
    (m) => {
      m.captures[0].file = "../escape.json";
    },
    (m) => {
      m.captures.push({ file: m.captures[0].file });
    },
    (m) => {
      m.limits.maxBytes = 32 * 1024 * 1024;
    },
    (m) => {
      m.limits.maxSchemaNodes = 0;
    },
    (m) => {
      m.options.required_min_samples = 0;
    },
    (m) => {
      m.origins = ["https://app.example.test/"];
    },
    (m) => {
      m.resource_types = [];
    },
  ]) {
    const m = manifest();
    modify(m);
    assert.throws(
      () => validateContractManifest(m),
      undefined,
      JSON.stringify(m).slice(0, 80),
    );
  }
  const defaults = validateContractManifest({
    ...manifest(),
    options: undefined,
    resource_types: undefined,
  });
  assert.equal(defaults.options.required_min_samples, 3);
});

test("inference yields an evidence-cited OpenAPI contract and a coverage report", async (t) => {
  const dir = await stage(t);
  const result = await inferContract(manifest(), dir);
  assert.equal(
    result.status,
    "produced",
    JSON.stringify(result.report).slice(0, 300),
  );
  const { openapi, report } = result;
  assert.equal(openapi.openapi, "3.1.0");
  assert.deepEqual(openapi.servers, [{ url: "https://app.example.test" }]);
  assert.deepEqual(Object.keys(openapi.paths), [
    "/api/customers/{numeric_2}",
    "/api/invoices",
    "/api/invoices/{numeric_2}",
    "/api/reports/{iso-date_2}",
    "/graphql",
  ]);
  const customers = openapi.paths["/api/customers/{numeric_2}"].get;
  assert.equal(
    customers["x-rea-api-surface-template"],
    "/api/customers/{numeric}",
  );
  assert.deepEqual(
    customers.parameters.map((p) => [p.name, p.in, p.required]),
    [["numeric_2", "path", true]],
  );
  const customerSchema =
    customers.responses["200"].content["application/json"].schema;
  assert.equal(customerSchema.type, "object");
  assert.equal(customerSchema.properties.id.type, "integer");
  assert.equal(customerSchema.properties.created_at.format, "date-time");
  assert.equal(
    customerSchema.properties.balance["x-rea-format"],
    "decimal-string",
  );
  assert.deepEqual(customerSchema.required, [
    "balance",
    "created_at",
    "email",
    "id",
    "name",
    "tags",
  ]);
  assert.equal(customerSchema["x-rea-basis"], "inferred");
  assert.equal(customers["x-rea-evidence"].samples, 4);
  assert.deepEqual(customers["x-rea-evidence"].transactions[0], {
    capture: 0,
    transaction_id: "t2",
    step_id: "open-invoices",
    status: 200,
  });
  assert.deepEqual(customers["x-rea-request-header-names"], [
    "accept",
    "authorization",
    "x-trace-id",
  ]);
  assert.ok(customers["x-rea-unknowns"].includes("error-responses-unobserved"));
  const invoices = openapi.paths["/api/invoices"];
  assert.deepEqual(
    invoices.get.parameters.map((p) => [p.name, p.in, p.required]),
    [["page", "query", false]],
  );
  assert.equal(
    invoices.get.responses["200"].content["application/json"].schema.items
      .properties.total["x-rea-format"],
    "decimal-string",
  );
  assert.equal(
    invoices.post.requestBody.content["application/json"].schema.properties
      .lines.items.properties.quantity.type,
    "integer",
  );
  assert.ok(invoices.post.responses["201"]);
  assert.equal(Object.hasOwn(invoices.post, "x-rea-graphql-operations"), false);
  const graphql = openapi.paths["/graphql"].post;
  const operations = Object.values(graphql["x-rea-graphql-operations"]);
  assert.equal(operations.length, 1);
  assert.equal(operations[0].identity.operation_name, "ListCustomers");
  assert.equal(operations[0].identity.endpoint_path, "/graphql");
  assert.equal(
    operations[0].request.properties.variables.properties.first.type,
    "integer",
  );
  assert.equal(
    openapi.paths["/api/invoices/{numeric_2}"].get.responses["404"].content[
      "application/json"
    ].schema.properties.error.type,
    "string",
  );
  const reports = openapi.paths["/api/reports/{iso-date_2}"].get;
  assert.equal(reports.responses["200"]["x-rea-body-truncated"], 2);
  assert.equal(report.status, "produced");
  assert.equal(report.primary_origin, "https://app.example.test");
  assert.deepEqual(report.coverage.excluded, {
    "non-json-body": 2,
    "other-origin": 2,
  });
  assert.equal(report.coverage.truncated, 2);
  assert.equal(report.coverage.admitted, 16);
  assert.equal(report.inputs.length, 2);
  assert.match(report.inputs[0].sha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(report.inputs[0].completeness, {
    status: "complete",
    dropped: 0,
  });
  assert.match(report.openapi_sha256, /^[a-f0-9]{64}$/u);
  assert.ok(
    report.limitations.some((line) => /Response\.body\(\)/u.test(line)),
  );
  const text = JSON.stringify(result);
  assert.equal(
    text.includes("SENTINEL"),
    false,
    "header values must never be read",
  );
  assert.equal(text.includes('"enum"'), false);
  const again = await inferContract(manifest(), dir);
  assert.equal(JSON.stringify(again), text);
});

test("inference fails closed on missing content, tampered bodies and over-budget schemas", async (t) => {
  const dir = await stage(t);
  const noContent = buildContractFixture("reference-a");
  noContent.scenario.network_content = {
    request_body: false,
    response_body: false,
    header_values: false,
  };
  noContent.events.items = noContent.events.items.filter(
    (event) => event.kind !== "network-content",
  );
  noContent.events.retained = noContent.events.items.length;
  await writeFile(join(dir, "none.json"), serializeFixture(noContent));
  const missing = await inferContract(
    { ...manifest(), captures: [{ file: "none.json" }] },
    dir,
  );
  assert.equal(missing.status, "invalid");
  assert.match(missing.report.reason, /network content/u);
  const tampered = buildContractFixture("reference-a");
  const content = tampered.events.items.find(
    (event) => event.kind === "network-content",
  );
  content.body.sha256 = "0".repeat(64);
  await writeFile(join(dir, "tampered.json"), serializeFixture(tampered));
  const bad = await inferContract(
    { ...manifest(), captures: [{ file: "tampered.json" }] },
    dir,
  );
  assert.equal(bad.status, "invalid");
  assert.match(bad.report.reason, /digest/u);
  const tiny = manifest();
  tiny.limits.maxSchemaNodes = 3;
  assert.equal((await inferContract(tiny, dir)).status, "invalid");
  const escape = manifest();
  escape.captures[0].file = "../reference-a.json";
  assert.equal((await inferContract(escape, dir)).status, "invalid");
  assert.equal(
    (
      await inferContract(
        { ...manifest(), captures: [{ file: "absent.json" }] },
        dir,
      )
    ).status,
    "invalid",
  );
});

test("verify accepts a conforming replacement and classifies drift", async (t) => {
  const dir = await stage(t);
  const out = join(dir, "contract");
  const inferred = await inferContract(manifest(), dir);
  assert.equal(inferred.status, "produced");
  await writeContract(out, inferred);
  const ok = await verifyContract(out, dir, "replacement.json", {
    originPairs: pairs,
  });
  assert.equal(ok.status, "pass", JSON.stringify(ok.findings));
  assert.equal(ok.matched, 8);
  assert.deepEqual(ok.findings, []);
  assert.deepEqual(ok.unexercised_operations, []);
  const drifted = await verifyContract(out, dir, "replacement-drifted.json", {
    originPairs: pairs,
  });
  assert.equal(drifted.status, "fail");
  const kinds = drifted.findings.map((finding) => finding.kind).sort();
  for (const kind of [
    "structural",
    "presence",
    "unobserved_status",
    "unmatched_operation",
  ])
    assert.ok(kinds.includes(kind), kinds.join(","));
  const structural = drifted.findings.find(
    (finding) => finding.kind === "structural",
  );
  assert.equal(structural.keyword, "type");
  assert.match(structural.instance_path, /total/u);
  assert.equal(Object.hasOwn(structural, "value"), false);
  const unmapped = await verifyContract(out, dir, "replacement.json", {});
  assert.equal(unmapped.status, "unknown");
  assert.equal(unmapped.matched, 0);
  const broken = await verifyContract(out, dir, "manifest.json", {
    originPairs: pairs,
  });
  assert.equal(broken.status, "invalid");
  await writeFile(join(out, "openapi.json"), "{}");
  assert.equal(
    (await verifyContract(out, dir, "replacement.json", { originPairs: pairs }))
      .status,
    "invalid",
  );
});

test("CLI writes contract files and maps exit codes for infer and verify", async (t) => {
  const dir = await stage(t);
  const out = join(dir, "out");
  const run = (args) =>
    spawnSync(process.execPath, [cliPath, ...args], {
      encoding: "utf8",
      timeout: 60_000,
    });
  const inferred = run(["infer", join(dir, "manifest.json"), "--out", out]);
  assert.equal(inferred.status, 0, inferred.stderr);
  assert.equal(JSON.parse(inferred.stdout).status, "produced");
  const openapi = JSON.parse(await readFile(join(out, "openapi.json"), "utf8"));
  assert.equal(openapi.openapi, "3.1.0");
  assert.equal(
    JSON.parse(await readFile(join(out, "contract-report.json"), "utf8"))
      .status,
    "produced",
  );
  assert.equal(
    run(["infer", join(dir, "manifest.json"), "--out", out]).status,
    2,
    "existing output directory is never reused",
  );
  const map = "https://app.example.test=http://localhost:4300";
  const pass = run([
    "verify",
    out,
    join(dir, "replacement.json"),
    "--origin-map",
    map,
  ]);
  assert.equal(pass.status, 0, pass.stderr);
  assert.equal(JSON.parse(pass.stdout).status, "pass");
  assert.equal(
    JSON.parse(pass.stdout).conclusions.required_coverage.status,
    "not-requested",
  );
  const sparse = buildContractFixture("replacement");
  sparse.events.items = sparse.events.items.filter(
    (event) => event.transaction_id === "t1",
  );
  sparse.events.retained = sparse.events.items.length;
  await writeFile(join(dir, "sparse.json"), serializeFixture(sparse));
  const graphqlKey = Object.keys(
    openapi.paths["/graphql"].post["x-rea-graphql-operations"],
  )[0];
  await writeFile(
    join(dir, "policy.json"),
    JSON.stringify({
      required_operations: [
        { method: "POST", path: "/graphql", graphql_operation: graphqlKey },
      ],
    }),
  );
  const verifyPolicy = (file) =>
    run([
      "verify",
      out,
      join(dir, file),
      "--origin-map",
      map,
      "--coverage-policy",
      join(dir, "policy.json"),
    ]);
  const incomplete = verifyPolicy("sparse.json");
  assert.equal(incomplete.status, 2, incomplete.stderr);
  const coverage = JSON.parse(incomplete.stdout);
  assert.equal(coverage.status, "pass");
  assert.equal(coverage.conclusions.required_coverage.status, "incomplete");
  assert.equal(verifyPolicy("replacement.json").status, 0);
  const fail = run([
    "verify",
    out,
    join(dir, "replacement-drifted.json"),
    "--origin-map",
    map,
  ]);
  assert.equal(fail.status, 1, fail.stderr);
  assert.equal(JSON.parse(fail.stdout).status, "fail");
  assert.equal(run(["verify", out, join(dir, "replacement.json")]).status, 2);
  assert.equal(run([]).status, 2);
  assert.equal(run(["infer"]).status, 2);
  assert.equal(
    run([
      "verify",
      out,
      join(dir, "replacement.json"),
      "--origin-map",
      "not-an-origin=x",
    ]).status,
    2,
  );
  assert.equal(
    run(["verify", out, join(dir, "replacement.json"), "--origin-map"]).status,
    2,
  );
});
