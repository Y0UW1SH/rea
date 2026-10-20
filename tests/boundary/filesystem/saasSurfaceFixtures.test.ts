import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";

import {
  isCanonicalOrigin,
  parseOriginPairs,
  sortOriginPairs,
} from "../../../scripts/lib/saas-origin-pairs.mjs";
import { apiSurfaceFields } from "../../../src/domain/analysisView/webNetworkApiSurfaceView.js";
import { browserScenarioCaptureSchema } from "../../../src/domain/browserScenarioCapture.js";
import { commitBrowserScenarioNormalization } from "../../../src/domain/browserScenarioNormalization.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";

// The committed surface-coverage fixtures must stay what the real tools produce: the
// static analysis parses with the analyze_javascript_application result schema, the
// api-surface groups with the view's group schema, the capture with the scenario
// capture schema, and the origins with the comparison's pair normalization.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const fixtures = join(root, "scripts/fixtures/saas-surface");
const read = async (name: string): Promise<unknown> =>
  JSON.parse(await readFile(join(fixtures, name), "utf8"));

/** Every endpoint node the bundle declares, as kind, mechanism and value. */
const DECLARED = [
  "network call:EventSource /api/reports/stream",
  "network call:WebSocket /live",
  "network call:axios.post /api/invoices",
  "network call:fetch /api/invoices?page=1",
  'network call:fetch API_PREFIX + "/orders"',
  "network call:fetch https://app.example.test/api/customers/42",
  "network call:fetch https://app.example.test/api/invoices/archive",
  "network call:navigator.sendBeacon /api/metrics",
  "network call:translate.get invoices.title",
  "network graphql:mutation RenameCustomer",
  "network graphql:query ListCustomers",
  "network trpc:link:httpBatchLink /trpc",
  "network trpc:procedure:mutate user.rename",
  "network trpc:procedure:query user.byId",
  "route property:path /invoices",
  "route property:path /invoices/:id",
  "route property:path /settings",
];

it("keeps the static analysis a valid analyze_javascript_application result for the committed bundle", async () => {
  const analysis = javascriptApplicationAnalysisResultSchema.parse(
    await read("static-analysis.json"),
  );
  expect(analysis.input_path).toBe("scripts/fixtures/saas-surface/bundle");
  expect(analysis.format).toBe("directory");
  expect(analysis.graph.coverage.status).toBe("complete");
  expect(analysis.integrity_contradictions).toEqual([]);
  const bundle = await readFile(join(fixtures, "bundle/main.js"));
  expect(analysis.statistics.text_bytes_read).toBe(bundle.byteLength);
  expect(analysis.statistics.parsed_javascript_files).toBe(1);
  const endpoints = analysis.graph.nodes.filter(
    (node) => node.kind === "endpoint",
  );
  expect(
    endpoints
      .map((node) => {
        const { properties } = node.observations[0]!;
        return `${String(properties.endpoint_kind)} ${String(properties.mechanism)} ${String(properties.value)}`;
      })
      .sort(),
  ).toEqual(DECLARED);
  const candidates = endpoints.filter((node) =>
    node.observations.some(
      ({ properties }) => properties.interpretation === "candidate",
    ),
  );
  expect(candidates).toHaveLength(1);
  const partial = endpoints.filter((node) =>
    node.observations.some(
      ({ properties }) => properties.resolution === "partial",
    ),
  );
  expect(partial).toHaveLength(1);
  for (const node of endpoints)
    for (const observation of node.observations)
      expect(observation.evidence.location.available).toBe(true);
});

it("keeps the api-surface fixture within the api-surface group schema", async () => {
  const surface = (await read("api-surface.json")) as Record<string, unknown>;
  expect(surface.kind).toBe("api-surface");
  const groups = apiSurfaceFields.groups.parse(surface.groups);
  expect(groups).toHaveLength(9);
  const records = apiSurfaceFields.records.parse(surface.records);
  expect(records).toEqual({ examined: 10, total: 10, excluded: 0 });
  expect(
    apiSurfaceFields.excluded_records.parse(surface.excluded_records),
  ).toEqual([]);
  expect(
    apiSurfaceFields.templated_groups.parse(surface.templated_groups),
  ).toBe(groups.filter((group) => group.templated_segments.length > 0).length);
  const ordinals = groups
    .flatMap((group) => group.record_ordinals)
    .sort((a, b) => a - b);
  expect(ordinals).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

it("keeps the scenario capture a valid browser scenario capture with retained bodies", async () => {
  const capture = browserScenarioCaptureSchema.parse(
    await read("scenario-capture.json"),
  );
  expect(capture.steps.map((step) => step.step_id)).toEqual([
    "scenario_start",
    "open-invoices",
    "create-invoice",
    "open-help",
  ]);
  expect(capture.scenario.network_content.request_body).toBe(true);
  expect(capture.completeness.status).toBe("complete");
  expect(capture.events.dropped).toBe(0);
  expect(
    capture.events.items.filter((event) => event.kind === "request"),
  ).toHaveLength(10);
});

it("declares origins the scenario comparison would commit", async () => {
  const origins = (await read("origins.json")) as {
    declared_origins: string[];
    origin_pairs: { before_origin: string; after_origin: string }[];
  };
  expect(origins.declared_origins).toEqual(["https://app.example.test"]);
  expect(origins.declared_origins.every(isCanonicalOrigin)).toBe(true);
  const committed = commitBrowserScenarioNormalization({
    rules: [],
    origin_pairs: origins.origin_pairs,
  }).origin_pairs;
  expect(
    sortOriginPairs(parseOriginPairs(origins.origin_pairs, "origin_pairs")),
  ).toEqual(committed);
});

it("keeps the profile a copy of the generic planning template that satisfies the profile schema", async () => {
  const [profile, generic, schema] = await Promise.all([
    readFile(join(fixtures, "profile.json"), "utf8"),
    readFile(join(root, "scripts/fixtures/saas-profiles/generic.json"), "utf8"),
    read("../saas-profiles/profile.schema.json"),
  ]);
  expect(profile).toBe(generic);
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(
    schema as object,
  );
  expect(validate(JSON.parse(profile)), JSON.stringify(validate.errors)).toBe(
    true,
  );
});
