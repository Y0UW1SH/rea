import { createHash } from "node:crypto";
import { timedCaptureEvidence } from "../../fixtures/analysisView.js";
import { INITIAL_TRASH_ROWS } from "../../fixtures/environmentStateLaterReads.js";
import { jsonObjectSchema } from "../../../src/domain/jsonValue.js";

import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { describe, expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  SCENARIO_EXCHANGES,
  scenarioCaptureEvidence,
  scenarioCaptureFixture,
  scenarioServeFixture,
} from "../../fixtures/browserScenarioCapture.js";
import {
  environmentServeSource,
  environmentStateServeFixture,
  writeEnvironmentServeFiles,
  type EnvironmentServeFixture,
} from "../../fixtures/environmentServe.js";
import { startListeningProcess } from "../../support/mcp/streamableHttpProcess.js";
import {
  processTest,
  type TestProcesses,
} from "../../support/process/processFixture.js";

const HTTP_BOUNDARY_TIMEOUT_MS = 90_000;
const CARD_PATH = "/.well-known/agent-env.json";
/** SHA-256 of the 14,519-byte card served for the fixture named "renamed", its descriptions naming each tool's recorded responses; pure replay must serve these bytes. */
const REPLAY_CARD_SHA256 =
  "995c280f0798f77e76f206c068eb6c2c1f8c4210a03ac1c01fba8cc07b5d7f09";

/** Serve the fixture pair as pure replay through the built CLI. */
const serveReplayOnly = async (
  processes: TestProcesses,
  environment: Readonly<Record<string, string>> = {},
  fixture?: EnvironmentServeFixture,
  flags: readonly string[] = [],
) => {
  const root = await createTestTempDirectory("rea-environment-serve-mcp-");
  const files = await writeEnvironmentServeFiles(root, fixture);
  const started = await startListeningProcess(
    processes,
    [
      "environment-serve",
      files.manifestPath,
      "--evidence",
      files.capturePath,
      "--replay-only",
      "--port",
      "0",
      ...flags,
    ],
    environment,
  );
  return { ...started, root };
};

const connect = async (url: URL) => {
  const transport = new StreamableHTTPClientTransport(url);
  const client = new Client({ name: "environment-boundary", version: "1" });
  await client.connect(transport);
  return client;
};

processTest(
  "replays a recorded list containing an initially deleted entity",
  async ({ processes }) => {
    const fixture = environmentStateServeFixture(
      timedCaptureEvidence(INITIAL_TRASH_ROWS),
    );
    const root = await createTestTempDirectory("rea-environment-trash-mcp-");
    const files = await writeEnvironmentServeFiles(root, fixture);
    const started = await startListeningProcess(processes, [
      "environment-serve",
      files.manifestPath,
      "--evidence",
      files.capturePath,
      "--port",
      "0",
    ]);
    const client = await connect(started.url);
    try {
      const response = await client.callTool({
        name: "get_contacts",
        arguments: { maxSize: "20", offset: "0" },
      });
      expect(response.isError).toBeFalsy();
      expect(response.structuredContent).toMatchObject({
        body: INITIAL_TRASH_ROWS[0]![2],
      });
    } finally {
      await client.close();
    }
  },
  HTTP_BOUNDARY_TIMEOUT_MS,
);

processTest(
  "accepts numbers and booleans for query parameters, sent as their JSON text",
  async ({ processes }) => {
    const fixture = environmentStateServeFixture(
      timedCaptureEvidence([
        [
          "GET",
          "/api/contacts?maxSize=2&withItems=true",
          [{ id: 1, name: "Ada" }],
        ],
      ]),
    );
    const started = await serveReplayOnly(processes, {}, fixture);
    const client = await connect(started.url);
    try {
      const response = await client.callTool({
        name: "get_contacts",
        arguments: { maxSize: 2, withItems: true },
      });
      expect(response.isError).toBeFalsy();
      expect(response.structuredContent).toMatchObject({
        body: [{ id: 1, name: "Ada" }],
        replay: {
          exact_match: true,
          recorded_query: "?maxSize=2&withItems=true",
        },
      });
    } finally {
      await client.close();
    }
  },
  HTTP_BOUNDARY_TIMEOUT_MS,
);

processTest(
  "replays recorded own JSON keys without interpreting inherited members as fields",
  async ({ processes }) => {
    const body = JSON.parse(
      '{"id":1,"__proto__":{"source":"recorded"},"nested":{"constructor":null,"__proto__":[false,0,""]}}',
    );
    const fixture = environmentStateServeFixture(
      timedCaptureEvidence([["GET", "/api/books/1", body]]),
    );
    const started = await serveReplayOnly(processes, {}, fixture);
    const client = await connect(started.url);
    try {
      const response = await client.callTool({
        name: "get_books_by_id",
        arguments: { id: "1" },
      });
      expect(response.isError).toBeFalsy();
      expect(response.structuredContent).toMatchObject({ body });
      const replayed = jsonObjectSchema.parse(
        jsonObjectSchema.parse(response.structuredContent).body,
      );
      expect(Object.hasOwn(replayed, "__proto__")).toBe(true);
      expect(Object.hasOwn(replayed, "constructor")).toBe(false);
    } finally {
      await client.close();
    }
  },
  HTTP_BOUNDARY_TIMEOUT_MS,
);

processTest(
  "validates repeated query arrays through the advertised MCP contract",
  async ({ processes }) => {
    const fixture = environmentStateServeFixture(
      timedCaptureEvidence([
        ["GET", "/api/items?tag=a&tag=b", { selected: "b" }],
        ["GET", "/api/items?tag=a&tag=c", { selected: "c" }],
      ]),
    );
    const source = environmentServeSource(fixture);
    const tool = source.manifest.tools.find(
      ({ path_template }) => path_template === "/api/items",
    );
    if (tool === undefined)
      throw new Error("Missing repeated-query fixture tool");
    const started = await serveReplayOnly(processes, {}, fixture);
    const client = await connect(started.url);
    try {
      const { tools } = await client.listTools();
      expect(
        tools.find(({ name }) => name === tool.name)?.inputSchema.properties
          ?.tag,
      ).toMatchObject({
        oneOf: [
          { type: "string" },
          { type: "number" },
          { type: "boolean" },
          { type: "array", items: { type: "string" } },
        ],
      });
      const response = await client.callTool({
        name: tool.name,
        arguments: { tag: ["a", "c"] },
      });
      expect(response.isError).toBeFalsy();
      expect(response.structuredContent).toMatchObject({
        body: { selected: "c" },
        replay: { exact_match: true, recorded_query: "?tag=a&tag=c" },
      });
    } finally {
      await client.close();
    }
  },
  HTTP_BOUNDARY_TIMEOUT_MS,
);

describe("rea environment-serve --replay-only", () => {
  processTest(
    "selects strict replay through the CLI and refuses unmodeled requests",
    async ({ processes }) => {
      const started = await serveReplayOnly(processes, {}, undefined, [
        "--replay-mode",
        "strict",
      ]);
      const client = await connect(started.url);
      try {
        const { tools } = await client.listTools();
        expect(tools[0]?.description).toContain("strict");
        const result = await client.callTool({
          name: "get_users_by_id",
          arguments: { id: "999" },
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.content)).toMatch(/unmodeled request/iu);
      } finally {
        await client.close();
      }
    },
    HTTP_BOUNDARY_TIMEOUT_MS,
  );
  processTest(
    "lists one tool per manifest tool and replays exact and best-effort records as untrusted target content",
    async ({ processes }) => {
      const source = environmentServeSource();
      const started = await serveReplayOnly(processes);
      expect(started.url.hostname).toBe("127.0.0.1");
      expect(started.url.pathname).toBe("/mcp");
      const client = await connect(started.url);
      try {
        const { tools } = await client.listTools();
        expect(tools).toHaveLength(source.manifest.tools.length);
        expect(tools.map(({ name }) => name).sort()).toEqual(
          source.manifest.tools.map(({ name }) => name).sort(),
        );
        const users = tools.find(({ name }) => name === "get_users_by_id");
        expect(users?.description).toContain(
          '; returns a JSON object with fields "id", "uid", "login", "email"; recorded statuses 200;',
        );
        expect(users?.annotations).toEqual({
          readOnlyHint: true,
          idempotentHint: true,
          openWorldHint: false,
        });
        const exact = await client.callTool({
          name: "get_users_by_id",
          arguments: { id: "2" },
        });
        expect(exact.isError).toBeFalsy();
        expect(exact.structuredContent).toMatchObject({
          status: 200,
          content_type: "application/json",
          body: { login: "probe" },
          replay: {
            exact_match: true,
            evidence_id: source.evidenceId,
            recorded_path: "/api/users/2",
            truncated: false,
          },
        });
        expect(exact._meta).toMatchObject({
          provenance: { untrusted_content: true, source: "analysis_target" },
        });
        const inexact = await client.callTool({
          name: "get_users_by_id",
          arguments: { id: "999" },
        });
        expect(inexact.structuredContent).toMatchObject({
          body: { login: "probe" },
          replay: { exact_match: false },
        });
        const folder = await client.callTool({
          name: "get_folders_by_uid",
          arguments: { uid: "general" },
        });
        expect(folder.structuredContent).toMatchObject({
          replay: { recorded_path: "/api/folders/general" },
        });
      } finally {
        await client.close();
      }
    },
    HTTP_BOUNDARY_TIMEOUT_MS,
  );

  processTest(
    "serves the stateless environment card named by ENVIRONMENT_NAME and refuses every data-plane method",
    async ({ processes }) => {
      const source = environmentServeSource();
      const started = await serveReplayOnly(processes, {
        ENVIRONMENT_NAME: "renamed",
      });
      const origin = new URL(started.url).origin;
      const card = await fetch(new URL(CARD_PATH, origin));
      expect(card.status).toBe(200);
      const text = await card.text();
      expect(
        createHash("sha256").update(text).digest("hex"),
        `${Buffer.byteLength(text)}-byte card`,
      ).toBe(REPLAY_CARD_SHA256);
      const body: unknown = JSON.parse(text);
      expect(body).toMatchObject({
        name: "renamed",
        protocolVersion: "1.0",
        url: "/agentenv",
        preferredTransport: "JSONRPC",
        additionalInterfaces: [{ url: "/mcp", transport: "mcp" }],
        capabilities: { extensions: null, operations: [] },
        children_environments: null,
      });
      expect(
        (body as { capabilities: { tools: unknown[] } }).capabilities.tools,
      ).toHaveLength(source.manifest.tools.length);
      const rpc = await fetch(new URL("/agentenv", origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "data/reset" }),
      });
      await expect(rpc.json()).resolves.toEqual({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32601, message: "method not found: data/reset" },
      });
      expect(started.stderr()).toContain('"transport":"streamable-http"');
    },
    HTTP_BOUNDARY_TIMEOUT_MS,
  );
});

describe("rea environment-serve --replay-mode strict", () => {
  processTest(
    "serves pure replay with strict matching for a recorded body-less scenario GET through the CLI",
    async ({ processes }) => {
      // As Playwright records them: a request without exposed bytes has a not_exposed body.
      const capture = scenarioCaptureFixture(
        SCENARIO_EXCHANGES.map((exchange) =>
          exchange.requestBody === undefined
            ? { ...exchange, requestBodyHidden: true as const }
            : exchange,
        ),
      );
      const root = await createTestTempDirectory("rea-environment-strict-mcp-");
      const files = await writeEnvironmentServeFiles(
        root,
        scenarioServeFixture(scenarioCaptureEvidence(capture)),
      );
      // Strict replay alone, without --replay-only: no state is derived or served.
      const started = await startListeningProcess(processes, [
        "environment-serve",
        files.manifestPath,
        "--evidence",
        files.capturePath,
        "--replay-mode",
        "strict",
        "--port",
        "0",
      ]);
      expect(started.stderr()).not.toContain("Environment state unavailable");
      const origin = new URL(started.url).origin;
      const card = (await (await fetch(new URL(CARD_PATH, origin))).json()) as {
        capabilities: {
          operations: unknown[];
          extensions: unknown;
          tools: { description: string }[];
        };
      };
      expect(card.capabilities.operations).toEqual([]);
      expect(card.capabilities.extensions).toBeNull();
      expect(card.capabilities.tools.length).toBeGreaterThan(0);
      for (const { description } of card.capabilities.tools)
        expect(description).toContain("strict replay");
      const client = await connect(started.url);
      try {
        const replayed = await client.callTool({
          name: "get_users_by_id",
          arguments: { id: "3" },
        });
        expect(replayed.isError).toBeFalsy();
        expect(replayed.structuredContent).toMatchObject({
          status: 200,
          body: { id: 3, login: "viewer" },
          replay: {
            exact_match: true,
            mode: "strict",
            match_scope: "path-query-json-body",
            recorded_path: "/api/users/3",
          },
        });
        const refused = await client.callTool({
          name: "get_users_by_id",
          arguments: { id: "999" },
        });
        expect(refused.isError).toBe(true);
        expect(JSON.stringify(refused.content)).toMatch(/unmodeled request/iu);
      } finally {
        await client.close();
      }
    },
    HTTP_BOUNDARY_TIMEOUT_MS,
  );
});

describe("rea environment-serve", () => {
  processTest(
    "serves read tools from the state it derives from the capture and loads a replacement state through the data plane",
    async ({ processes }) => {
      const root = await createTestTempDirectory("rea-environment-state-mcp-");
      const fixture = environmentStateServeFixture();
      // Only the manifest and the capture: the server derives the state itself.
      const files = await writeEnvironmentServeFiles(root, fixture);
      const started = await startListeningProcess(processes, [
        "environment-serve",
        files.manifestPath,
        "--evidence",
        files.capturePath,
        "--port",
        "0",
      ]);
      expect(started.stderr()).not.toContain("Environment state unavailable");
      const origin = new URL(started.url).origin;
      const card = (await (await fetch(new URL(CARD_PATH, origin))).json()) as {
        capabilities: {
          operations: string[];
          extensions: { uri: string }[] | null;
          tools: { name: string }[];
        };
      };
      expect(card.capabilities.operations).toEqual([
        "data/reset",
        "data/add",
        "data/get",
      ]);
      expect(card.capabilities.extensions).toMatchObject([
        { uri: "urn:agentenv:intake/v1" },
      ]);
      const names = card.capabilities.tools.map(({ name }) => name);
      expect(names).toContain("get_users_by_id");
      for (const write of [
        "post_annotations",
        "delete_dashboards_by_uid",
        "post_folders",
        "put_folders_by_uid",
        "delete_teams_by_id",
      ])
        expect(names).not.toContain(write);
      const rpc = async (method: string, params?: unknown) =>
        (
          await fetch(new URL("/agentenv", origin), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          })
        ).json() as Promise<{
          result?: {
            parts: [
              {
                data: {
                  rea_state: {
                    state_evidence_id: string;
                    entities: unknown[];
                  };
                };
              },
            ];
          };
          error?: { code: number };
        }>;
      await expect(rpc("data/add", { parts: [] })).resolves.toMatchObject({
        error: { code: -32602 },
      });
      const current = await rpc("data/get");
      const document = current.result?.parts[0].data;
      // The derived state is the one inspect-analysis-view projects from the capture.
      expect(document?.rea_state.state_evidence_id).toBe(
        fixture.state.evidence_id,
      );
      expect(document?.rea_state.entities.length).toBeGreaterThan(0);
      const client = await connect(started.url);
      try {
        const before = await client.callTool({
          name: "get_users_by_id",
          arguments: { id: "3" },
        });
        expect(before.structuredContent).toMatchObject({
          body: { login: "viewer" },
          state: { source: "state", view: "item", id: "3" },
        });
        await expect(
          rpc("data/add", {
            parts: [
              {
                kind: "data",
                data: { rea_state: { ...document?.rea_state, entities: [] } },
              },
            ],
          }),
        ).resolves.toMatchObject({ result: {} });
        const emptied = await client.callTool({
          name: "get_users_by_id",
          arguments: { id: "3" },
        });
        expect(emptied.isError).toBe(true);
        expect(emptied._meta).toMatchObject({
          provenance: { untrusted_content: true },
        });
        await expect(rpc("data/reset")).resolves.toMatchObject({ result: {} });
        const restored = await client.callTool({
          name: "get_users_by_id",
          arguments: { id: "3" },
        });
        expect(restored.structuredContent).toMatchObject({
          body: { login: "viewer" },
        });
      } finally {
        await client.close();
      }
    },
    HTTP_BOUNDARY_TIMEOUT_MS,
  );
});
