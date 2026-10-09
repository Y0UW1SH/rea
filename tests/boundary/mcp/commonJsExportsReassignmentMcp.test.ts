import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { javaScriptExportShapeComparisonResultSchema } from "../../../src/domain/javascript/javascriptExportShapeComparisonSchemas.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { findExportNode } from "../../support/javascriptApplicationFixture.js";

const requireFixture = createRequire(import.meta.url);

it.each([
  {
    source:
      "exports = function parse() { return { kind: 'result', count: COUNT }; };",
    status: "missing",
    loadedType: "object",
  },
  {
    source: "exports = () => ({ kind: 'result', count: COUNT });",
    status: "missing",
    loadedType: "object",
  },
  {
    source:
      "const parse = () => ({ kind: 'result', count: COUNT }); exports = parse;",
    status: "missing",
    loadedType: "object",
  },
  {
    source:
      "let local; module.exports += (local = () => ({ kind: 'result', count: COUNT }));",
    status: "unavailable",
    loadedType: "string",
  },
  {
    source:
      "let local; module.exports ||= (local = () => ({ kind: 'result', count: COUNT }));",
    status: "unavailable",
    loadedType: "object",
  },
  {
    source:
      "let local; module.exports ??= (local = () => ({ kind: 'result', count: COUNT }));",
    status: "unavailable",
    loadedType: "object",
  },
  {
    source: "module.exports ||= () => ({ kind: 'result', count: COUNT });",
    status: "unavailable",
    loadedType: "object",
  },
])(
  "does not compare an unexported CommonJS callable: $source",
  async ({ source, status, loadedType }) => {
    const { client, close } = await createApplicationMcpHarness();
    onTestFinished(close);
    const applications = [];
    for (const count of [1, 2]) {
      const root = await createTestTempDirectory("rea-commonjs-reassignment-");
      const path = join(root, "parser.cjs");
      await writeFile(path, source.replace("COUNT", String(count)));
      const actual: unknown = requireFixture(path);
      expect(typeof actual).toBe(loadedType);
      if (loadedType === "object") expect(actual).toEqual({});
      const analyzed = await client.callTool({
        name: "analyze_javascript_application",
        arguments: { input_path: root },
      });
      expect(analyzed.isError).not.toBe(true);
      applications.push(parseEvidence(analyzed.structuredContent));
    }
    const [left, right] = applications;
    if (left === undefined || right === undefined)
      throw new Error("Expected both analyzed CommonJS fixtures");
    const response = await client.callTool({
      name: "compare_javascript_export_shapes",
      arguments: {
        left,
        right,
        left_module_path: "parser.cjs",
        left_export_name: "default",
        right_module_path: "parser.cjs",
        right_export_name: "default",
      },
    });
    expect(response.isError).not.toBe(true);
    const compared = javaScriptExportShapeComparisonResultSchema.parse(
      parseEvidence(response.structuredContent).normalized_result,
    );
    expect(compared.left.status).toBe(status);
    expect(compared.right.status).toBe(status);
    if (status === "missing") {
      expect(compared.left.candidates).toEqual([]);
      expect(compared.right.candidates).toEqual([]);
    }
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

it.each([
  { target: "module.exports", exportName: "default", suffix: "" },
  { target: "module['exports']", exportName: "default", suffix: "" },
  { target: "exports.parse", exportName: "parse", suffix: "" },
  { target: "module.exports.parse", exportName: "parse", suffix: "" },
  { target: "exports = module.exports", exportName: "default", suffix: "" },
  { target: "module.exports = exports", exportName: "default", suffix: "" },
  {
    target: "module.exports = exports",
    exportName: "default",
    suffix: "",
    binding: true,
  },
  {
    target: "exports.parse",
    exportName: "parse",
    suffix: "exports = () => ({ kind: 'result', count: 999 });",
  },
])(
  "preserves the real $exportName export from $target with suffix '$suffix'",
  async ({ target, exportName, suffix, binding }) => {
    const { client, close } = await createApplicationMcpHarness();
    onTestFinished(close);
    const applications = [];
    for (const count of [1, 2]) {
      const root = await createTestTempDirectory("rea-commonjs-real-exports-");
      const path = join(root, "parser.cjs");
      const callableSource = `() => ({ kind: 'result', count: ${String(count)} })`;
      await writeFile(
        path,
        binding === true
          ? `const parse = ${callableSource}; ${target} = parse; ${suffix}`
          : `${target} = ${callableSource}; ${suffix}`,
      );
      const actual: unknown = requireFixture(path);
      const callable: unknown =
        exportName === "default"
          ? actual
          : z.object({ parse: z.unknown() }).parse(actual).parse;
      if (typeof callable !== "function")
        throw new Error("Expected Node to load the real callable export");
      const returned: unknown = callable();
      expect(returned).toEqual({ kind: "result", count });
      const response = await client.callTool({
        name: "analyze_javascript_application",
        arguments: { input_path: root },
      });
      expect(response.isError).not.toBe(true);
      const evidence = parseEvidence(response.structuredContent);
      applications.push(evidence);
      const analyzed = javascriptApplicationAnalysisResultSchema.parse(
        evidence.normalized_result,
      );
      expect(
        findExportNode(analyzed.graph, "parser.cjs", exportName),
      ).toBeDefined();
      if (exportName !== "default")
        expect(
          findExportNode(analyzed.graph, "parser.cjs", "default"),
        ).toBeUndefined();
    }
    const [left, right] = applications;
    if (left === undefined || right === undefined)
      throw new Error("Expected both real CommonJS export analyses");
    const response = await client.callTool({
      name: "compare_javascript_export_shapes",
      arguments: {
        left,
        right,
        left_module_path: "parser.cjs",
        left_export_name: exportName,
        right_module_path: "parser.cjs",
        right_export_name: exportName,
      },
    });
    expect(response.isError).not.toBe(true);
    const compared = javaScriptExportShapeComparisonResultSchema.parse(
      parseEvidence(response.structuredContent).normalized_result,
    );
    expect(compared.summary).toEqual({
      added: 0,
      removed: 0,
      changed: 1,
      unknown: 0,
    });
    expect(compared.changes).toEqual([
      expect.objectContaining({
        path: "/count",
        status: "changed",
        left: { availability: "literal", value: 1 },
        right: { availability: "literal", value: 2 },
      }),
    ]);
  },
);
