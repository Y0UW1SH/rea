import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterEach, expect, it } from "vitest";
import {
  analysisViewCaptureEvidence,
  environmentManifestCaptureFixture,
} from "../../../tests/fixtures/analysisView.js";
import { environmentServeSource } from "../../../tests/fixtures/environmentServe.js";
import { inspectAnalysisView } from "../../application/analysisView/AnalysisViewService.js";
import {
  serveEnvironment,
  type ServedEnvironment,
} from "./serveEnvironment.js";

const servers: ServedEnvironment[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const start = async () => {
  const capture = analysisViewCaptureEvidence(
    environmentManifestCaptureFixture([
      {
        request: {
          method: "POST",
          url: "https://app.test/graphql",
          postData: {
            mimeType: "application/json",
            text: '{"id":1,"value":"�"}',
          },
        },
        response: {
          status: 200,
          content: { mimeType: "application/json", text: '{"matched":true}' },
        },
      },
    ]),
  );
  const manifest = inspectAnalysisView({
    source: { kind: "inline", evidence: capture },
    view: { kind: "environment-manifest" },
  });
  if (!manifest.ok) throw manifest.error;
  const source = environmentServeSource({ manifest: manifest.value, capture });
  const tool = source.manifest.tools[0]?.name;
  if (tool === undefined) throw new Error("Missing fixture tool");
  const started = await serveEnvironment({
    source,
    host: "127.0.0.1",
    port: 0,
    replayMode: "strict",
  });
  if (!started.ok) throw started.error;
  servers.push(started.value);
  const transport = new StreamableHTTPClientTransport(
    new URL(started.value.url),
  );
  const client = new Client({ name: "strict-transport", version: "1" });
  await client.connect(transport);
  const session = transport.sessionId;
  if (session === undefined) throw new Error("Missing MCP session");
  return { server: started.value, client, session, tool };
};

const rawCall = (tool: string, id = "1") =>
  `{"jsonrpc":"2.0","id":20,"method":"tools/call","params":{"name":${JSON.stringify(tool)},"arguments":{"body":{"id":${id},"value":"�"}}}}`;

it.each([
  "application/json;q=0, text/event-stream",
  "application/json-patch+json, text/event-stream",
  "application/json, text/event-streaming",
])("cannot bypass strict parsing with Accept: %s", async (accept) => {
  const { server, client, session, tool } = await start();
  try {
    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept,
        "mcp-session-id": session,
      },
      body: rawCall(tool, "1.0000000000000001"),
    });
    await response.body?.cancel();
    expect(response.status).toBe(406);
    expect(
      (
        await client.callTool({
          name: tool,
          arguments: { body: { id: 1, value: "�" } },
        })
      ).isError,
    ).not.toBe(true);
  } finally {
    await client.close();
  }
});

it("refuses malformed UTF-8 instead of matching its replacement character", async () => {
  const { server, client, session, tool } = await start();
  try {
    const [prefix, suffix] = rawCall(tool).split("�");
    if (prefix === undefined || suffix === undefined)
      throw new Error("Missing value marker");
    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": session,
      },
      body: Buffer.concat([
        Buffer.from(prefix),
        Buffer.from([0xff]),
        Buffer.from(suffix),
      ]),
    });
    await response.body?.cancel();
    expect(response.status).toBe(400);
    expect(
      (
        await client.callTool({
          name: tool,
          arguments: { body: { id: 1, value: "�" } },
        })
      ).isError,
    ).not.toBe(true);
  } finally {
    await client.close();
  }
});

it("keeps the live session when an initialize request fails strict numeric validation", async () => {
  const { server, client, tool } = await start();
  try {
    const response = await fetch(server.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: '{"jsonrpc":"2.0","id":1.0000000000000001,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"invalid-client","version":"1"}}}',
    });
    await response.body?.cancel();
    expect(response.status).toBe(400);
    expect(
      (
        await client.callTool({
          name: tool,
          arguments: { body: { id: 1, value: "�" } },
        })
      ).isError,
    ).not.toBe(true);
  } finally {
    await client.close();
  }
});
