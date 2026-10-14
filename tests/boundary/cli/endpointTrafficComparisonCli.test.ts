import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { endpointTrafficComparisonResultSchema } from "../../../src/domain/javascript/javascriptEndpointTrafficComparisonSchemas.js";
import {
  ENDPOINT_TRAFFIC_ORIGIN as APP,
  endpointTrafficApplicationEvidence,
  endpointTrafficHar,
  inProcessHarCaptureService,
} from "../../fixtures/endpointTrafficComparison.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "compares portable static and HAR Evidence from a JSON file through the compiled CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-endpoint-traffic-cli-");
    const harPath = join(root, "session.har");
    await writeFile(harPath, JSON.stringify(endpointTrafficHar()));
    const inspected = await inProcessHarCaptureService().inspect({
      capture_path: harPath,
      format: "har",
    });
    if (!inspected.ok) throw inspected.error;
    const application = endpointTrafficApplicationEvidence();
    const run = async (input: unknown) => {
      const path = join(root, "request.json");
      await writeFile(path, JSON.stringify(input));
      return cli.run({
        arguments: ["compare-static-and-observed-endpoints", path, "--json"],
        environment: { REA_LOG_LEVEL: "silent" },
      });
    };

    const response = await run({
      static: application,
      observed: inspected.value,
      origins: [APP],
      limit: 2,
    });
    expect(response.exitCode, response.stdout).toBe(0);
    const evidence = parseEvidence(response.json);
    const result = endpointTrafficComparisonResultSchema.parse(
      evidence.normalized_result,
    );
    expect(result.collection).toBe("static-endpoints");
    expect(result.page).toEqual({
      offset: 0,
      limit: 2,
      total: 4,
      next_offset: 2,
    });
    expect(result.summary).toMatchObject({
      static_network_endpoints: 4,
      matched: 2,
      not_observed_in_capture: 1,
      observed_without_static_match: 1,
    });
    expect(result.items).toHaveLength(2);
    for (const value of ["query-secret", "fragment-secret"])
      expect(response.stdout).not.toContain(value);

    // A one-shot CLI process has no session ledger to resolve references from.
    const reference = await run({
      static: application,
      observed: {
        kind: "retained-evidence",
        evidence_id: inspected.value.evidence_id,
      },
    });
    expect(reference.exitCode).toBe(1);
    expect(reference.json).toMatchObject({
      details: { evidence_id: inspected.value.evidence_id, reason: "missing" },
    });
  },
);
