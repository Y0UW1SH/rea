import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020, type AnySchema } from "ajv/dist/2020.js";
import { expect, test } from "vitest";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { observed } from "../../fixtures/analysisExecution.js";
import {
  investigationCapture,
  investigationPlan,
} from "../../fixtures/saasInvestigation.js";
import { ok } from "../../../src/domain/result.js";
import type { BrowserScenario } from "../../../src/domain/browserScenario.js";

test.skipIf(process.platform === "win32")(
  "MCP advertises a valid live-loop schema, runs it, and retains linked browser Evidence",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-live-mcp-"));
    const session = createTestBinarySession(() => ({
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(ok(null)),
    }));
    const records = new Map<string, { record: string; value: number }>();
    const server = createServer(
      { kind: "session", session },
      {
        browserScenarioCapture: {
          identity: () => ({
            id: "fixture",
            name: "Synthetic live fixture",
            version: "1",
          }),
          captureScenario: (scenario: BrowserScenario) => {
            const path = new URL(scenario.start_url.url).pathname;
            const id = path.split("/")[2]!;
            if (path.startsWith("/act/"))
              records.set(id, {
                record: `run-1-${id}`,
                value: id === "first" ? 1 : 0,
              });
            return Promise.resolve(
              ok(
                investigationCapture(scenario, {
                  actor: "operator",
                  workspace: "test-workspace",
                  record: null,
                  ...records.get(id),
                }),
              ),
            );
          },
        },
      },
    );
    const client = new Client({ name: "saas-live-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      const advertised = tools.tools.find(
        ({ name }) => name === "run_saas_investigation",
      );
      expect(advertised).toBeDefined();
      const input = {
        plan: investigationPlan(),
        journal_path: join(directory, "journal.json"),
      };
      const ajv = new Ajv2020({ strict: false });
      expect(ajv.compile(advertised!.inputSchema)(input)).toBe(true);
      const result = await client.callTool({
        name: "run_saas_investigation",
        arguments: input,
      });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        normalized_result: {
          status: "distinguished",
          surviving_hypotheses: ["a"],
        },
      });
      expect(
        ajv.compile(advertised!.outputSchema as AnySchema)(
          result.structuredContent,
        ),
      ).toBe(true);
      expect(
        session
          .exportEvidenceBundle()
          .records.filter(
            ({ operation }) => operation === "capture_browser_scenario",
          ),
      ).toHaveLength(6);
    } finally {
      await client.close();
      await server.close();
      await session.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
