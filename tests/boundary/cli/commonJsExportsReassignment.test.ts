import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { javaScriptExportShapeComparisonResultSchema } from "../../../src/domain/javascript/javascriptExportShapeComparisonSchemas.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "does not report definite CLI differences between functions assigned only to exports",
  async ({ cli }) => {
    const applications = [];
    for (const count of [1, 2]) {
      const root = await createTestTempDirectory("rea-cli-commonjs-exports-");
      await writeFile(
        join(root, "parser.cjs"),
        `exports = function parse() { return { kind: 'result', count: ${String(count)} }; };`,
      );
      const analyzed = await cli.run({
        arguments: ["analyze-javascript-application", root, "--json"],
      });
      expect(analyzed.exitCode).toBe(0);
      applications.push(parseEvidence(analyzed.json));
    }
    const [left, right] = applications;
    if (left === undefined || right === undefined)
      throw new Error("Expected both CLI analyses");
    const response = await cli.run({
      arguments: [
        "compare-javascript-export-shapes",
        JSON.stringify({
          left,
          right,
          left_module_path: "parser.cjs",
          left_export_name: "default",
          right_module_path: "parser.cjs",
          right_export_name: "default",
        }),
        "--json",
      ],
    });
    expect(response.exitCode).toBe(0);
    const compared = javaScriptExportShapeComparisonResultSchema.parse(
      parseEvidence(response.json).normalized_result,
    );
    expect(compared.left.status).toBe("missing");
    expect(compared.right.status).toBe("missing");
    expect(compared.summary).toMatchObject({
      added: 0,
      removed: 0,
      changed: 0,
    });
    expect(compared.changes.every(({ status }) => status === "unknown")).toBe(
      true,
    );
  },
);
