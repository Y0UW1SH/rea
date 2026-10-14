import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { endpointTrafficComparisonResultSchema } from "../../../src/domain/javascript/javascriptEndpointTrafficComparisonSchemas.js";
import { createServer } from "../../../src/server/createServer.js";
import {
  analysisViewCaptureEvidence,
  analysisViewCaptureFixture,
  analysisViewObjectDenseCapture,
} from "../../fixtures/analysisView.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import {
  ENDPOINT_TRAFFIC_ORIGIN as APP,
  endpointTrafficApplicationEvidence,
  endpointTrafficHar,
  inProcessHarCaptureService,
} from "../../fixtures/endpointTrafficComparison.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const NAME = "compare_static_and_observed_endpoints";
const summarySchema = z.object({
  normalized_result: z.object({ parent_evidence_id: z.string() }),
});
const retained = (evidence_id: string) => ({
  kind: "retained-evidence",
  evidence_id,
});

const advertisedSchema = async (
  client: Client,
  kind: "inputSchema" | "outputSchema",
): Promise<Record<string, unknown>> => {
  const advertised = (await client.listTools()).tools.find(
    (tool) => tool.name === NAME,
  );
  const schema = advertised?.[kind];
  if (schema === undefined)
    throw new Error(`Endpoint comparison ${kind} is not advertised`);
  return schema;
};

const connect = async () => {
  const session = createTestBinarySession(() => {
    throw new Error("endpoint comparison must not start a deep provider");
  });
  const server = createServer(
    { kind: "session", session },
    { webNetworkCapture: inProcessHarCaptureService() },
  );
  const client = new Client({ name: "endpoint-traffic-mcp", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const root = await createTestTempDirectory("rea-endpoint-traffic-mcp-");
  const harPath = join(root, "session.har");
  await writeFile(harPath, JSON.stringify(endpointTrafficHar()));
  const inspect = async (extra: Record<string, unknown> = {}) => {
    const response = await client.callTool({
      name: "inspect_web_network_capture",
      arguments: { capture_path: harPath, format: "har", ...extra },
    });
    expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
    return response;
  };
  const compare = (arguments_: Record<string, unknown>) =>
    client.callTool({ name: NAME, arguments: arguments_ });
  return { client, session, inspect, compare };
};

it("pairs retained and portable Evidence identically and keeps its advertised contract", async () => {
  const { client, session, inspect, compare } = await connect();
  const application = endpointTrafficApplicationEvidence();
  const summary = await inspect({ detail: "summary" });
  const observedId = summarySchema.parse(summary.structuredContent)
    .normalized_result.parent_evidence_id;
  const capture = session
    .exportEvidenceBundle()
    .records.find(({ evidence_id }) => evidence_id === observedId);
  if (capture === undefined) throw new Error("HAR Evidence was not retained");

  const inline = await compare({
    static: application,
    observed: capture,
    origins: [APP],
  });
  expect(inline.isError, JSON.stringify(inline.content)).not.toBe(true);
  const recordsBefore = session.exportEvidenceBundle().records;
  const referenced = await compare({
    static: retained(application.evidence_id),
    observed: retained(observedId),
    origins: [APP],
  });
  expect(referenced.structuredContent).toEqual(inline.structuredContent);
  expect(session.exportEvidenceBundle().records).toEqual(recordsBefore);

  const evidence = parseEvidence(referenced.structuredContent);
  expect(evidence).toMatchObject({
    operation: NAME,
    confidence: "inferred",
    authority: "analyst-inference",
    evidence_links: [application.evidence_id, observedId],
    parameters: {
      static_evidence_id: application.evidence_id,
      observed_evidence_id: observedId,
      origins: [APP],
      collection: "static-endpoints",
      offset: 0,
      limit: 50,
    },
  });
  const result = endpointTrafficComparisonResultSchema.parse(
    evidence.normalized_result,
  );
  expect(result.summary).toEqual({
    static_network_endpoints: 4,
    matched: 2,
    matched_exact: 2,
    ambiguous: 0,
    not_observed_in_capture: 1,
    unknown: 1,
    unknown_reasons: [{ reason: "candidate-endpoint", count: 1 }],
    observed_groups: 3,
    observed_matched: 2,
    observed_ambiguous: 0,
    observed_unresolved: 0,
    observed_without_static_match: 1,
  });
  if (result.collection !== "static-endpoints")
    throw new Error("Expected the default static-endpoints collection");
  expect(
    result.items.map(({ status, target }) => [target?.path ?? null, status]),
  ).toEqual([
    ["/api/admin/export", "not-observed-in-capture"],
    ["/api/users", "matched"],
    ["/rest/user/login", "matched"],
    [null, "unknown"],
  ]);
  const unmatched = await compare({
    static: retained(application.evidence_id),
    observed: retained(observedId),
    origins: [APP],
    collection: "observed-without-static-match",
  });
  expect(
    endpointTrafficComparisonResultSchema.parse(
      parseEvidence(unmatched.structuredContent).normalized_result,
    ),
  ).toMatchObject({
    collection: "observed-without-static-match",
    page: { offset: 0, limit: 50, total: 1, next_offset: null },
    items: [
      {
        method: "GET",
        origin: APP,
        path_template: "/api/orders",
        record_ordinals: [2],
      },
    ],
  });

  // Without origins, the relative paths' groups are unresolved, not unmatched.
  const undeclared = endpointTrafficComparisonResultSchema.parse(
    parseEvidence(
      (
        await compare({
          static: retained(application.evidence_id),
          observed: retained(observedId),
          collection: "observed-unresolved",
        })
      ).structuredContent,
    ).normalized_result,
  );
  expect(undeclared.summary).toMatchObject({
    unknown_reasons: [
      { reason: "candidate-endpoint", count: 1 },
      { reason: "origin-undeclared", count: 3 },
    ],
    observed_matched: 0,
    observed_ambiguous: 0,
    observed_unresolved: 2,
    observed_without_static_match: 1,
  });
  expect(undeclared.items).toMatchObject([
    { path_template: "/api/users", reason: "origin-undeclared" },
    { path_template: "/rest/user/login", reason: "origin-undeclared" },
  ]);
  for (const value of ["query-secret", "fragment-secret", '"KEY"'])
    expect(JSON.stringify(evidence)).not.toContain(value);

  const unknowns = await client.callTool({
    name: "list_unknowns",
    arguments: {},
  });
  expect(JSON.stringify(unknowns.structuredContent)).toContain(
    `against this captured traffic? (comparison ${evidence.evidence_id})`,
  );

  const outputSchema = await advertisedSchema(client, "outputSchema");
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  expect(ajv.validateSchema(outputSchema)).toBe(true);
  const validateOutput = ajv.compile(outputSchema);
  expect(
    validateOutput(referenced.structuredContent),
    JSON.stringify(validateOutput.errors),
  ).toBe(true);
});

it("advertises structural input rules the server also enforces", async () => {
  const { client, session, inspect, compare } = await connect();
  const application = endpointTrafficApplicationEvidence();
  expect(session.recordEvidence(application).ok).toBe(true);
  const observedId = summarySchema.parse(
    (await inspect({ detail: "summary" })).structuredContent,
  ).normalized_result.parent_evidence_id;
  const capture = session
    .exportEvidenceBundle()
    .records.find(({ evidence_id }) => evidence_id === observedId);
  const inputSchema = await advertisedSchema(client, "inputSchema");
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  expect(ajv.validateSchema(inputSchema)).toBe(true);
  const validateInput = ajv.compile(inputSchema);
  for (const example of toolContract(NAME).examples)
    expect(validateInput(example.input)).toBe(true);
  expect(
    validateInput({ static: application, observed: capture, origins: [APP] }),
  ).toBe(true);
  const references = {
    static: retained(application.evidence_id),
    observed: retained(observedId),
  };
  for (const origins of [
    ["wss://[::1]:8443", "http://127.0.0.1:8080", APP],
    ["https://xn--bcher-kva.example"],
  ])
    expect(validateInput({ ...references, origins })).toBe(true);
  // The advertised schema refuses structural mistakes before dispatch; the
  // server keeps the exact serialized-origin check for the remaining superset.
  for (const origins of [
    [`${APP}/api`],
    ["https://App.example.test"],
    ["ftp://files.example.test"],
    ["app.example.test"],
    [APP, APP],
  ]) {
    expect(validateInput({ ...references, origins }), origins[0]).toBe(false);
    expect(
      parseMcpToolError(await compare({ ...references, origins })).error,
    ).toMatchObject({ code: "invalid_request" });
  }
  expect(validateInput({ ...references, origins: [`${APP}:`] })).toBe(true);
  expect(
    parseMcpToolError(await compare({ ...references, origins: [`${APP}:`] }))
      .error,
  ).toMatchObject({ code: "invalid_request" });
  for (const field of [
    { collection: "observed" },
    { offset: -1 },
    { limit: 0 },
    { limit: 1.5 },
  ]) {
    expect(validateInput({ ...references, ...field })).toBe(false);
    expect(
      parseMcpToolError(await compare({ ...references, ...field })).error,
    ).toMatchObject({ code: "invalid_request" });
  }
});

it("refuses sensitive HAR parents and keeps ordinal subsets from claiming absence", async () => {
  const { inspect, compare } = await connect();
  const application = endpointTrafficApplicationEvidence();
  const sensitive = parseEvidence(
    (await inspect({ sensitive_values: ["unrelated-literal"] }))
      .structuredContent,
  );
  expect(
    parseMcpToolError(
      await compare({ static: application, observed: sensitive }),
    ).error,
  ).toMatchObject({
    code: "unsupported_target",
    details: {
      operation: NAME,
      path: sensitive.evidence_id,
      reason: "sensitive_values_unretained",
    },
  });

  const subset = parseEvidence(
    (await inspect({ record_ordinals: [0, 1] })).structuredContent,
  );
  const response = await compare({
    static: application,
    observed: subset,
    origins: [APP],
  });
  const result = endpointTrafficComparisonResultSchema.parse(
    parseEvidence(response.structuredContent).normalized_result,
  );
  expect(result.coverage.observed_records).toEqual({
    examined: 2,
    total: 4,
    excluded: 0,
  });
  expect(result.summary).toMatchObject({
    not_observed_in_capture: 0,
    unknown_reasons: [
      { reason: "candidate-endpoint", count: 1 },
      { reason: "observed-coverage-incomplete", count: 1 },
    ],
  });
  expect(result.limitations).toContain(
    "Parent contains an ordinal subset; the surface covers only retained records.",
  );
});

it("admits portable captures before parsing and reports malformed inputs at their coordinates", async () => {
  const { client, compare } = await connect();
  const application = endpointTrafficApplicationEvidence();
  const dense = await compare({
    static: application,
    observed: analysisViewCaptureEvidence(analysisViewObjectDenseCapture()),
  });
  expect(parseMcpToolError(dense).error).toMatchObject({
    code: "resource_constraint",
    details: { operation: NAME, resource: "memory" },
  });
  // Inline static Evidence gets structural admission before Evidence parsing:
  // nesting deeper than any JSON Evidence is refused at its own coordinate.
  let deep: unknown = 0;
  for (let depth = 0; depth < 1_010; depth += 1) deep = [deep];
  const deepStatic = parseMcpToolError(
    await compare({
      static: { ...application, normalized_result: deep },
      observed: analysisViewCaptureEvidence(),
    }),
  ).error;
  expect(deepStatic).toMatchObject({
    code: "invalid_request",
    details: { operation: NAME },
  });
  expect(JSON.stringify(deepStatic.details)).toContain(
    '"path":["static","normalized_result"',
  );
  await client.ping();

  const saz = analysisViewCaptureFixture();
  const unsupported = await compare({
    static: application,
    observed: analysisViewCaptureEvidence({ ...saz, format: "saz" }),
  });
  expect(parseMcpToolError(unsupported).error).toMatchObject({
    code: "unsupported_target",
    details: { reason: "api-surface does not support capture format saz." },
  });

  const capture = analysisViewCaptureEvidence();
  for (const [arguments_, path] of [
    [{ static: application, observed: retained("ev_missing") }, "observed"],
    [{ static: capture, observed: capture }, "static"],
    [{ static: application, observed: application }, "observed"],
    [
      {
        static: application,
        observed: { ...capture, evidence_id: `ev_${"0".repeat(64)}` },
      },
      "observed",
    ],
  ] as const) {
    const error = parseMcpToolError(await compare(arguments_)).error;
    expect(error).toMatchObject({ code: "invalid_request" });
    expect(JSON.stringify(error.details)).toContain(`"${path}"`);
  }
  expect(
    parseMcpToolError(
      await compare({
        static: application,
        observed: capture,
        origins: ["https://app.example.test/", APP, APP],
      }),
    ).error,
  ).toMatchObject({ code: "invalid_request" });
  expect(
    parseMcpToolError(
      await compare({
        static: application,
        observed: retained(`ev_${"f".repeat(64)}`),
      }),
    ).error,
  ).toMatchObject({ details: { reason: "missing" } });
});
