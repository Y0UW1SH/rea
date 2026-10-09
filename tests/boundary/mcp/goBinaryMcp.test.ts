import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { toolAvailability } from "../../../src/contracts/toolOutputSchemaPrimitives.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createGoBinaryFixture } from "../../fixtures/go/image.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";

it("advertises valid schemas and inspects real file bytes through MCP without an active target", async () => {
  const session = createTestBinarySession(() => {
    throw new Error("Go metadata must not start a deep provider");
  });
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "go-metadata-contract", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const status = await client.callTool({
    name: "binary_session",
    arguments: {},
  });
  const availability = z
    .object({
      result: z.object({ tool_availability: z.array(toolAvailability) }),
    })
    .parse(status.structuredContent).result.tool_availability;
  expect(availability).toContainEqual(
    expect.objectContaining({
      name: "inspect_go_binary",
      available: true,
      reason: "available",
    }),
  );
  const advertised = (await client.listTools()).tools.find(
    (tool) => tool.name === "inspect_go_binary",
  );
  if (advertised?.outputSchema === undefined)
    throw new Error("Go metadata must publish both schemas");
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const inputSchema: Record<string, unknown> = advertised.inputSchema;
  const outputSchema: Record<string, unknown> = advertised.outputSchema;
  expect(ajv.validateSchema(inputSchema)).toBe(true);
  expect(ajv.validateSchema(outputSchema)).toBe(true);
  expect(
    ajv.validate(inputSchema, { path: "/artifacts/program", execute: true }),
  ).toBe(false);
  expect(ajv.validate(inputSchema, { path: "/artifacts/\0program" })).toBe(
    false,
  );
  expect(advertised.annotations).toMatchObject({
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  const root = await createTestTempDirectory("rea-go-mcp-");
  const path = join(root, "application");
  const fixture = createGoBinaryFixture({
    moduleText: "path\texample.com/tool\nnew-record\tfuture\n",
  });
  await writeFile(path, fixture.bytes);
  const response = await client.callTool({
    name: "inspect_go_binary",
    arguments: { path },
  });
  expect(response.isError).not.toBe(true);
  expect(
    ajv.validate(outputSchema, response.structuredContent),
    JSON.stringify(ajv.errors),
  ).toBe(true);
  const parsed = toolContract("inspect_go_binary").outputSchema.parse(
    response.structuredContent,
  );
  const evidence = parseEvidence(parsed);
  expect(evidence.confidence).toBe("observed");
  expect(parsed.normalized_result.build_info?.module).toMatchObject({
    path: "example.com/tool",
    complete: false,
    unparsed_lines: ["new-record\tfuture"],
  });
  expect(evidence.limitations.join(" ")).toContain(
    "could not be parsed completely",
  );
  expect(session.evidenceById(evidence.evidence_id)).toEqual(evidence);
  const invalid = await client.callTool({
    name: "inspect_go_binary",
    arguments: { path: "relative.bin" },
  });
  expect(invalid.isError).toBe(true);
  expect(parseMcpToolError(invalid)).toMatchObject({
    error: {
      code: "invalid_request",
      details: { issues: [{ path: ["path"], reason: "invalid_format" }] },
    },
  });
});
