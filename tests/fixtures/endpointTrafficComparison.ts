import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { WebNetworkCaptureService } from "../../src/application/WebNetworkCaptureService.js";
import { decodeHarCapture } from "../../src/browser/history/HarCapture.js";
import type { Evidence } from "../../src/domain/evidence.js";
import {
  createJavaScriptApplicationGraph,
  createJavaScriptApplicationNode,
} from "../../src/domain/javascript/javascriptApplicationGraph.js";
import { artifactEvidence } from "../../src/domain/javascript/javascriptApplicationGraph.fixture.js";
import { ok } from "../../src/domain/result.js";
import {
  analysisViewBindJavaScriptGraphs,
  analysisViewJavaScriptAnalysis,
  analysisViewJavaScriptEvidence,
} from "./analysisView.js";
import { historicalHar } from "./historicalHar.js";

export const ENDPOINT_TRAFFIC_ORIGIN = "https://app.example.test";

/**
 * Static findings for a self-authored client: `fetch("/api/users")`,
 * `http.post("/rest/user/login")`, `fetch("/api/admin/export")`, a
 * string-built `fetch(base + "orders")` with no literal, and the candidate
 * `translate.get("KEY")`, projected as analyze_javascript_application does.
 */
const FINDINGS = [
  { value: "/api/users", mechanism: "call:fetch" },
  { value: "/rest/user/login", mechanism: "call:http.post" },
  { value: "/api/admin/export", mechanism: "call:fetch" },
  { value: "KEY", mechanism: "call:translate.get", candidate: true },
] as const;

/** Authenticated application Evidence whose graph carries the client endpoints. */
export const endpointTrafficApplicationEvidence = (): Evidence => {
  const analysis = analysisViewJavaScriptAnalysis();
  const sha256 = analysis.root_artifact_sha256;
  const endpoints = FINDINGS.map((finding) => {
    const candidate = "candidate" in finding;
    return createJavaScriptApplicationNode({
      kind: "endpoint",
      identity: {
        strategy: "artifact-local-key",
        stability: "artifact-version",
        artifact_sha256: sha256,
        namespace: "network",
        key: JSON.stringify([
          candidate ? "candidate" : "literal",
          finding.value,
        ]),
      },
      observations: [
        {
          label: finding.value,
          properties: {
            endpoint_kind: "network",
            value: finding.value,
            mechanism: finding.mechanism,
            ...(candidate ? { interpretation: "candidate" } : {}),
          },
          evidence: artifactEvidence(sha256, "main.js", "ast-static-analysis"),
        },
      ],
    });
  });
  const graph = analysis.graph;
  return analysisViewJavaScriptEvidence(
    analysisViewBindJavaScriptGraphs(
      analysis,
      createJavaScriptApplicationGraph({
        schema: "JavaScriptApplicationGraph",
        root_node_ids: graph.root_node_ids,
        nodes: [...graph.nodes, ...endpoints],
        edges: graph.edges,
        coverage: graph.coverage,
        limitations: graph.limitations,
      }),
    ),
  );
};

/** HAR recorded for the client; /api/orders comes from the string-built URL. */
export const endpointTrafficHar = () => {
  const fixture = historicalHar();
  const entry = fixture.log.entries[0]!;
  const origin = ENDPOINT_TRAFFIC_ORIGIN;
  fixture.log.entries = (
    [
      ["GET", `${origin}/api/users?page=2&token=query-secret`],
      ["POST", `${origin}/rest/user/login`],
      ["GET", `${origin}/api/orders#fragment-secret`],
      ["POST", `${origin}/rest/user/login`],
    ] as const
  ).map(([method, url]) => ({
    ...entry,
    request: { ...entry.request, method, url },
  }));
  return fixture;
};

/** Historical inspection over the real HAR decoder, without a decoder process. */
export const inProcessHarCaptureService = () =>
  new WebNetworkCaptureService({
    inspect: async (input) => {
      const bytes = await readFile(input.capture_path);
      return ok({
        ...decodeHarCapture(bytes.toString("utf8"), input.sensitive_values),
        artifact: {
          path: input.capture_path,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          bytes: bytes.length,
        },
        format: "har" as const,
        runtime_attribution: "unknown" as const,
        limitations: [],
      });
    },
  });
