import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import {
  CONTRACT_FIXTURE_VARIANTS,
  buildContractFixture,
} from "../../../scripts/lib/saas-api-contract-fixture.mjs";
import {
  originCorrespondence,
  parseOriginPairs,
  sortOriginPairs,
} from "../../../scripts/lib/saas-origin-pairs.mjs";
import {
  recordedPath,
  routeTemplate,
  segmentRule,
} from "../../../scripts/lib/saas-route-templates.mjs";
import { mediaTypeEssence } from "../../../scripts/lib/saas-api-contract-admission.mjs";
import {
  mediaTypeEssence as ownerMediaTypeEssence,
  scanRouteTemplate,
  segmentRule as ownerSegmentRule,
} from "../../../src/domain/analysisView/webNetworkRouteTemplates.js";
import { browserScenarioCaptureSchema } from "../../../src/domain/browserScenarioCapture.js";
import { commitBrowserScenarioNormalization } from "../../../src/domain/browserScenarioNormalization.js";
import { projectScenarioOrigins } from "../../../src/domain/browserScenarioOriginCorrespondence.js";
import { parseRecordedTransportUrl } from "../../../src/domain/recordedTransportUrl.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const script = join(root, "scripts/saas-api-contract.mjs");
const fixtures = join(root, "scripts/fixtures/saas-api-contract");
const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const HEX = "a".repeat(32);
const temporary: string[] = [];
afterAll(async () => {
  await Promise.all(
    temporary.map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

it("verifies the API contract companion suites", () => {
  for (const suite of [
    "scripts/saas-api-contract-helpers.test.mjs",
    "scripts/saas-api-contract.test.mjs",
    "scripts/saas-api-contract-verify.test.mjs",
  ]) {
    const output = execFileSync(
      process.execPath,
      ["--test", join(root, suite)],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 120_000,
      },
    );
    expect(output).toContain("fail 0");
  }
}, 150_000);

describe("companion mirrors stay identical to their TypeScript owners", () => {
  it("templates recorded paths with the api-surface segment rules", () => {
    for (const value of [
      "9810",
      UUID,
      UUID.toUpperCase(),
      HEX,
      HEX.toUpperCase(),
      "a".repeat(31),
      "2026-10-20",
      "2026-02-30",
      "2024-02-29",
      "2023-02-29",
      "invoices",
      "",
      "v2",
      "0",
    ])
      expect(segmentRule(value)).toBe(ownerSegmentRule(value));
    for (const reported of [
      "application/json",
      " Application/JSON ; charset=utf-8",
      "\tapplication/problem+json\t",
      "text/html;charset=UTF-8",
      "application/json ",
      " application/json",
      "",
      "json",
      "application/",
      "a/b c",
    ])
      expect(mediaTypeEssence(reported), JSON.stringify(reported)).toBe(
        ownerMediaTypeEssence(reported),
      );
    for (const path of [
      "/",
      "/api/invoices",
      "/api/invoices/9810",
      `/a/${UUID}/b/${HEX}/c/2026-10-20`,
      "/x//y/",
      "/2026-02-30/7",
      "/trailing/",
      "/graphql",
    ]) {
      const owner = scanRouteTemplate(path, () => true);
      expect(owner).not.toBeNull();
      expect(routeTemplate(path)).toEqual({
        template: owner!.template,
        rules: owner!.rules,
        segments: owner!.segments,
      });
    }
  });

  it("extracts raw recorded paths like parseRecordedTransportUrl", () => {
    for (const value of [
      "https://app.example.test/api/x?y=1#f",
      "https://app.example.test",
      "https://app.example.test?x=1",
      "https://user:pw@a.test:8443/x",
      "https://a.test/a/../b",
      "https://a.test/a/./b/",
      "HTTPS://A.TEST/X",
      "ws://stream.test:5000/live",
      "/relative/path",
      "not a url",
      "https://a.test\\x",
      "https://a.test/x\\y",
      " https://a.test/x",
      "https://a.test:8443",
      "https://a.te\tst/x",
      "https://[2001:db8::1]:8443/v1/items",
      "https://@a.test/x",
      "git+ssh://a.test/repo",
      "custom://host\\path",
      "https://a.test/%2F/x",
    ]) {
      const owner = parseRecordedTransportUrl(value);
      const expected =
        owner.path === null || owner.origin === null
          ? null
          : { origin: owner.origin, path: owner.path };
      expect(recordedPath(value), value).toEqual(expected);
    }
  });

  it("orders and projects origin pairs like the scenario comparison", () => {
    const declared = [
      {
        before_origin: "https://app.example.test",
        after_origin: "http://localhost:4300",
      },
      {
        before_origin: "https://api.example.test",
        after_origin: "http://localhost:4301",
      },
    ];
    const committed = commitBrowserScenarioNormalization({
      rules: [],
      origin_pairs: declared,
    }).origin_pairs;
    const sorted = sortOriginPairs(parseOriginPairs(declared, "origin_pairs"));
    expect(sorted).toEqual(committed);
    const { token } = originCorrespondence(sorted);
    const reference = browserScenarioCaptureSchema.parse(
      buildContractFixture("reference-a"),
    );
    const replacement = browserScenarioCaptureSchema.parse(
      buildContractFixture("replacement"),
    );
    const foreign = browserScenarioCaptureSchema.parse({
      ...reference,
      scenario: { ...reference.scenario, start_origin: "https://other.test" },
    });
    for (const [capture, side] of [
      [reference, "before"],
      [replacement, "after"],
      [reference, "after"],
      [foreign, "before"],
    ] as const)
      expect(
        projectScenarioOrigins(capture, committed!, side).scenario.start_origin,
      ).toBe(token(capture.scenario.start_origin, side));
    expect(originCorrespondence([]).token("https://x.test", "before")).toBe(
      projectScenarioOrigins(reference, [], "before").scenario.start_origin ===
        reference.scenario.start_origin
        ? "https://x.test"
        : "unexpected",
    );
  });
});

it("keeps every committed fixture a valid browser scenario capture", async () => {
  for (const variant of CONTRACT_FIXTURE_VARIANTS) {
    expect(() =>
      browserScenarioCaptureSchema.parse(buildContractFixture(variant)),
    ).not.toThrow();
    const committed = JSON.parse(
      await readFile(join(fixtures, `${variant}.json`), "utf8"),
    );
    expect(() => browserScenarioCaptureSchema.parse(committed)).not.toThrow();
  }
});

it("infers and verifies the synthetic contract through the public companion CLI", async () => {
  const directory = await mkdtemp(join(tmpdir(), "rea-contract-wrapper-"));
  temporary.push(directory);
  const out = join(directory, "contract");
  const inferred = JSON.parse(
    execFileSync(
      process.execPath,
      [script, "infer", join(fixtures, "manifest.json"), "--out", out],
      { encoding: "utf8", timeout: 60_000 },
    ),
  ) as { status: string; openapi_sha256: string };
  expect(inferred.status).toBe("produced");
  const openapi = JSON.parse(
    await readFile(join(out, "openapi.json"), "utf8"),
  ) as {
    openapi: string;
    paths: Record<string, unknown>;
  };
  expect(openapi.openapi).toBe("3.1.0");
  expect(Object.keys(openapi.paths)).toContain("/api/invoices/{numeric_2}");
  const verified = JSON.parse(
    execFileSync(
      process.execPath,
      [
        script,
        "verify",
        out,
        join(fixtures, "replacement.json"),
        "--origin-map",
        "https://app.example.test=http://localhost:4300",
      ],
      { encoding: "utf8", timeout: 60_000 },
    ),
  ) as { status: string; matched: number };
  expect(verified).toMatchObject({ status: "pass", matched: 8 });
}, 120_000);
