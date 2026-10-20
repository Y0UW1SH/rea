import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import {
  groupShapeKey,
  routeKey,
  staticShapeKey,
} from "../../../scripts/lib/saas-surface-matching.mjs";
import { segmentRule } from "../../../src/domain/analysisView/webNetworkRouteTemplates.js";
import { compositeKey } from "../../../src/domain/unicodeCodePointOrder.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const script = join(root, "scripts/saas-surface-coverage.mjs");
const fixtures = join(root, "scripts/fixtures/saas-surface");
const fixture = (name: string) => join(fixtures, name);
const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";

interface SurfaceReport {
  readonly status: string;
  readonly gaps: number;
  readonly declared: Record<string, number>;
  readonly surface: readonly {
    readonly family: string;
    readonly status: string;
  }[];
  readonly experiments: readonly {
    readonly id: string;
    readonly workflowId: string;
  }[];
  readonly experimentPriorities: readonly {
    readonly id: string;
    readonly rank: number;
  }[];
  readonly profileUpdate: {
    readonly added: readonly string[];
    readonly profile: { readonly experiments: readonly unknown[] };
  };
  readonly limitations: readonly string[];
}

it("verifies the surface coverage companion suites", () => {
  for (const suite of [
    "scripts/saas-surface-matching.test.mjs",
    "scripts/saas-surface-coverage.test.mjs",
    "scripts/saas-surface-comparison.test.mjs",
    "scripts/saas-surface-planning.test.mjs",
  ]) {
    const output = execFileSync(
      process.execPath,
      ["--test", join(root, suite)],
      { cwd: root, encoding: "utf8", timeout: 180_000 },
    );
    expect(output).toContain("fail 0");
  }
}, 240_000);

describe("companion route-shape keys stay identical to their TypeScript owners", () => {
  it("keys static paths and api-surface groups with the segment rules as composite tuples", () => {
    for (const path of [
      "/",
      "/api/invoices",
      "/users/8812",
      `/a/${UUID}/b/${"a".repeat(32)}/c/2026-10-20`,
      "/x//y/",
      "/2026-02-30/7",
      "/trailing/",
      "/graphql",
      "/trpc/user.byId,user.list",
    ]) {
      const expected = compositeKey(
        path
          .slice(1)
          .split("/")
          .map((segment) => {
            const rule = segmentRule(segment);
            return rule === null ? [0, segment] : [1, rule];
          }),
      );
      expect(staticShapeKey(path)).toBe(expected);
      expect(routeKey("https://app.example.test", expected)).toBe(
        compositeKey(["https://app.example.test", expected]),
      );
    }
    expect(
      groupShapeKey({
        path_template: "/users/{numeric}",
        templated_segments: [{ segment_index: 1, rule: "numeric" }],
      }),
    ).toBe(staticShapeKey("/users/8812"));
    expect(
      groupShapeKey({ path_template: "/users/me", templated_segments: [] }),
    ).not.toBe(staticShapeKey("/users/8812"));
  });
});

it("plans schema-conformant experiments from the committed fixtures through the public CLI", () => {
  const result = spawnSync(
    process.execPath,
    [
      script,
      "--static",
      fixture("static-analysis.json"),
      "--observed",
      fixture("api-surface.json"),
      "--observed",
      fixture("scenario-capture.json"),
      "--origins",
      fixture("origins.json"),
      "--profile",
      fixture("profile.json"),
      "--workflow-id",
      "first-workflow",
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  expect(result.status, result.stderr).toBe(1);
  const report = JSON.parse(result.stdout) as SurfaceReport;
  expect(report.status).toBe("complete");
  expect(report.declared).toEqual({
    network: 9,
    trpc: 2,
    graphql: 2,
    route: 3,
  });
  expect(report.gaps).toBe(7);
  expect(report.experiments).toHaveLength(7);
  expect(report.experimentPriorities.map(({ rank }) => rank)).toEqual([
    1, 2, 3, 4, 5, 6, 7,
  ]);
  expect(report.profileUpdate.added).toHaveLength(7);
  const schema = JSON.parse(
    readFileSync(
      join(root, "scripts/fixtures/saas-profiles/profile.schema.json"),
      "utf8",
    ),
  ) as object;
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(
    schema,
  );
  expect(
    validate(report.profileUpdate.profile),
    JSON.stringify(validate.errors),
  ).toBe(true);
  const generic = JSON.parse(
    readFileSync(join(fixtures, "profile.json"), "utf8"),
  ) as { experiments: unknown[] };
  for (const experiment of report.experiments)
    expect(
      validate({ ...generic, experiments: [experiment] }),
      JSON.stringify(validate.errors),
    ).toBe(true);
  expect(
    report.limitations.some((line) => line.includes("missing or hidden code")),
  ).toBe(true);
  expect(result.stdout).not.toContain("missing code");
});
