import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { buildContractFixture } from "../../../scripts/lib/saas-api-contract-fixture.mjs";
import {
  assertStudyCaptureProvenance,
  captureIsComplete,
} from "../../../scripts/lib/saas-capture-completeness.mjs";
import { browserScenarioCaptureSchema } from "../../../src/domain/browserScenarioCapture.js";

it("validates offline studies through the companion suites", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const result = execFileSync(
    process.execPath,
    ["--test", "scripts/saas-study.test.mjs"],
    { cwd: root, encoding: "utf8", timeout: 60_000 },
  );
  expect(result).toContain("fail 0");
}, 90_000);

it("preserves the domain owner's source-event and action-accounting invariants", () => {
  const good = browserScenarioCaptureSchema.parse(
    buildContractFixture("reference-a"),
  );
  expect(browserScenarioCaptureSchema.safeParse(good).success).toBe(true);
  expect(() => assertStudyCaptureProvenance(good)).not.toThrow();
  expect(captureIsComplete(good)).toBe(true);
  const missingAction = structuredClone(good);
  missingAction.scenario.action_count += 1;
  expect(browserScenarioCaptureSchema.safeParse(missingAction).success).toBe(
    false,
  );
  expect(captureIsComplete(missingAction)).toBe(false);
  const content = good.events.items.find(
    (event) => event.kind === "network-content",
  );
  if (content === undefined) throw new Error("Fixture has no content event");
  for (const sequence of [99999, content.sequence]) {
    const broken = structuredClone(good);
    const event = broken.events.items.find(
      (item) => item.kind === "network-content",
    );
    if (event?.kind !== "network-content")
      throw new Error("Fixture has no content event");
    event.source_event_sequence = sequence;
    expect(browserScenarioCaptureSchema.safeParse(broken).success).toBe(false);
    expect(() => assertStudyCaptureProvenance(broken)).toThrow();
  }
});
