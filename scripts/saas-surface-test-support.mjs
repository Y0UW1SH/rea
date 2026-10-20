import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildSurfaceApiSurface,
  buildSurfaceCapture,
  surfaceOrigins,
} from "./lib/saas-surface-fixture.mjs";

// Shared by the surface-coverage node:test suites: a synthetic analysis result in the
// shape analyze_javascript_application produces for the fixture bundle, and input
// records as the CLI hands them to reconcileSurface.

export const SHA = "a".repeat(64);
export const sha256 = (text) => createHash("sha256").update(text).digest("hex");
export const cliPath = fileURLToPath(
  new URL("./saas-surface-coverage.mjs", import.meta.url),
);
export const fixturesDirectory = fileURLToPath(
  new URL("./fixtures/saas-surface/", import.meta.url),
);
export const generatorPath = fileURLToPath(
  new URL("./saas-surface-fixtures.mjs", import.meta.url),
);
export const genericProfile = () =>
  JSON.parse(
    readFileSync(
      new URL("./fixtures/saas-profiles/generic.json", import.meta.url),
      "utf8",
    ),
  );

const endpointNode = ({
  value,
  mechanisms,
  kind = "network",
  candidate = false,
  partial = false,
  line = 1,
}) => ({
  node_id: `jag_node_${sha256(JSON.stringify([kind, value, mechanisms, candidate, partial]))}`,
  kind: "endpoint",
  identity: {
    strategy: "artifact-local-key",
    stability: "artifact-version",
    artifact_sha256: SHA,
    namespace: kind,
    key: JSON.stringify([candidate ? "candidate" : "literal", value]),
  },
  observations: mechanisms.map((mechanism, index) => ({
    label: value,
    properties: {
      endpoint_kind: kind,
      value,
      mechanism,
      ...(candidate ? { interpretation: "candidate" } : {}),
      ...(partial ? { resolution: "partial" } : {}),
    },
    evidence: {
      state: "observed",
      location: {
        available: true,
        value: {
          kind: "source-range",
          source: "main.js",
          start: { line, column: index },
          end: { line, column: index + value.length },
        },
      },
    },
  })),
});

/** A consumed-fields analysis result whose endpoint nodes carry the given findings. */
export const analysisOf = (findings, coverage = "complete") => ({
  input_path: "/bundle",
  format: "directory",
  root_artifact_sha256: SHA,
  graph: {
    schema: "JavaScriptApplicationGraph",
    graph_id: `jag_${"b".repeat(64)}`,
    root_node_ids: [],
    nodes: [
      {
        node_id: `jag_node_${"c".repeat(64)}`,
        kind: "javascript-asset",
        identity: { strategy: "canonical-path", path: "main.js" },
        observations: [],
      },
      ...findings.map(endpointNode),
    ],
    edges: [],
    coverage:
      coverage === "complete"
        ? { status: "complete", truncated: false, omitted_count: 0, limits: [] }
        : { status: "partial", truncated: false, omitted_count: 2, limits: [] },
    limitations: [],
  },
  limitations: [],
});

/** What analyze_javascript_application reports for scripts/fixtures/saas-surface/bundle/main.js. */
export const BUNDLE_FINDINGS = [
  { value: "/api/invoices?page=1", mechanisms: ["call:fetch"] },
  { value: "/api/invoices", mechanisms: ["call:axios.post"] },
  {
    value: "https://app.example.test/api/customers/42",
    mechanisms: ["call:fetch"],
  },
  {
    value: "https://app.example.test/api/invoices/archive",
    mechanisms: ["call:fetch"],
  },
  { value: "/api/reports/stream", mechanisms: ["call:EventSource"] },
  { value: "/live", mechanisms: ["call:WebSocket"] },
  { value: "/api/metrics", mechanisms: ["call:navigator.sendBeacon"] },
  {
    value: 'API_PREFIX + "/orders"',
    mechanisms: ["call:fetch"],
    partial: true,
  },
  {
    value: "invoices.title",
    mechanisms: ["call:translate.get"],
    candidate: true,
  },
  { value: "ListCustomers", mechanisms: ["graphql:query"] },
  { value: "RenameCustomer", mechanisms: ["graphql:mutation"] },
  { value: "/trpc", mechanisms: ["trpc:link:httpBatchLink"] },
  { value: "user.byId", mechanisms: ["trpc:procedure:query"] },
  { value: "user.rename", mechanisms: ["trpc:procedure:mutate"] },
  { value: "/invoices", mechanisms: ["property:path"], kind: "route" },
  { value: "/invoices/:id", mechanisms: ["property:path"], kind: "route" },
  { value: "/settings", mechanisms: ["property:path"], kind: "route" },
];

/** The bundle declarations the synthetic observations exercise completely. */
export const EXERCISED_VALUES = new Set([
  "/api/invoices?page=1",
  "/api/invoices",
  "https://app.example.test/api/customers/42",
  "https://app.example.test/api/invoices/archive",
  "/api/reports/stream",
  "ListCustomers",
  "/trpc",
  "user.byId",
  "/invoices",
  "/invoices/:id",
]);

export const input = (file, value) => ({ file, sha256: sha256(file), value });
export const fixtureInputs = (options = {}) => ({
  static: input("static-analysis.json", analysisOf(BUNDLE_FINDINGS)),
  observed: [
    input("api-surface.json", buildSurfaceApiSurface()),
    input("scenario-capture.json", buildSurfaceCapture()),
  ],
  origins: surfaceOrigins(),
  ...options,
});
export const statusesOf = (report) =>
  Object.fromEntries(
    report.surface.map((item) => [
      `${item.family} ${item.key}`,
      item.status + (item.reason === undefined ? "" : `:${item.reason}`),
    ]),
  );
export const experimentId = (family, key) =>
  `surface-${family}-${sha256(`${family}\u0000${key}`).slice(0, 12)}`;

/** The statuses every bundle declaration must reach against the synthetic observations. */
export function expectedBundleStatuses(report) {
  const nodeKeyed = (reason) =>
    `network ${report.surface.find((item) => item.reason === reason).key}`;
  return {
    "network * /api/invoices": "exact",
    "network POST /api/invoices": "exact",
    "network * https://app.example.test/api/customers/42": "exact",
    "network * https://app.example.test/api/invoices/archive": "exact",
    "network GET /api/reports/stream": "exact",
    "network * /live": "unknown:origin-not-exercised",
    "network POST /api/metrics": "unmatched",
    [nodeKeyed("target-unresolved")]: "unknown:target-unresolved",
    [nodeKeyed("candidate-endpoint")]: "unknown:candidate-endpoint",
    "trpc query user.byId": "exact",
    "trpc mutate user.rename": "unmatched",
    "graphql query ListCustomers": "exact",
    "graphql mutation RenameCustomer": "unmatched",
    "route /invoices": "exact",
    "route /invoices/:id": "templated",
    "route /settings": "unmatched",
  };
}
