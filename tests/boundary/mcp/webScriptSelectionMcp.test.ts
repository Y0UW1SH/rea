import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { expect, it, onTestFinished } from "vitest";

import { silentLogger } from "../../../src/logger.js";
import { registerWebScriptTool } from "../../../src/server/registerWebScriptTool.js";
import { readWithoutFifoWriter } from "../../fixtures/fifoInput.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.skipIf(process.platform === "win32")(
  "returns a capture_path invalid_request for a named pipe without waiting or publishing output",
  async () => {
    const root = await createTestTempDirectory("rea-script-selection-mcp-");
    const capturePath = join(root, "capture.pipe");
    const outputDirectory = join(root, "export");
    await promisify(execFile)("mkfifo", [capturePath]);

    const server = new McpServer({ name: "script-selection", version: "1" });
    registerWebScriptTool(server, {
      logger: silentLogger,
      recordEvidence: undefined,
    });
    const client = new Client({ name: "script-selection-test", version: "1" });
    onTestFinished(async () => {
      await client.close();
      await server.close();
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const outcome = await readWithoutFifoWriter(capturePath, () =>
      client.callTool({
        name: "export_web_scripts",
        arguments: {
          capture_path: capturePath,
          output_directory: outputDirectory,
        },
      }),
    );
    expect(outcome.state).toBe("completed");
    if (outcome.state !== "completed")
      throw new Error("MCP capture selection waited for a FIFO writer");
    expect(outcome.result.isError).toBe(true);
    expect(outcome.result.structuredContent).toMatchObject({
      error: {
        code: "invalid_request",
        details: {
          operation: "export_web_scripts",
          issues: [
            {
              path: ["capture_path"],
              reason: "invalid_value",
              message: expect.stringContaining("regular file"),
            },
          ],
        },
      },
    });
    expect(JSON.stringify(outcome.result)).toContain(capturePath);
    await expect(access(outputDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);
