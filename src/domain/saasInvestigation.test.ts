import { expect, test } from "vitest";
import { createHash } from "node:crypto";
import { sanitizeBrowserUrl } from "./browserObservation.js";
import {
  investigationEvidence,
  investigationPlan,
  investigationCapture,
  createBrowserScenarioEvidence,
} from "../../tests/fixtures/saasInvestigation.js";
import { saasInvestigationPlanSchema } from "./saasInvestigation.js";
import {
  evaluateSaasProbe,
  selectSaasExperiment,
  survivingSaasHypotheses,
  saasObservationAtPointer,
} from "./saasInvestigationEvaluation.js";

test.each(["foreign-response", "duplicate-request", "duplicate-response"])(
  "counts a second matching request even when its %s cannot be attributed",
  (kind) => {
    const probe =
      saasInvestigationPlanSchema.parse(investigationPlan()).experiments[0]!
        .before;
    const capture = investigationCapture(probe.scenario, {
      actor: "operator",
      workspace: "test-workspace",
      record: null,
    });
    const extra = structuredClone(capture.events.items);
    for (const event of extra) {
      event.sequence += 100;
      if ("transaction_id" in event) event.transaction_id = "ambiguous";
      if (event.kind === "network-content") event.source_event_sequence += 100;
    }
    if (kind === "foreign-response") {
      const response = extra.find((event) => event.kind === "response")!;
      response.url = sanitizeBrowserUrl("https://unrelated.example.test/state");
    } else {
      const duplicate = extra.find(
        (event) =>
          event.kind ===
          (kind === "duplicate-request" ? "request" : "response"),
      )!;
      extra.push({ ...duplicate, sequence: 999 });
    }
    capture.events.items.push(...extra);
    capture.events.retained = capture.events.items.length;
    const evidence = createBrowserScenarioEvidence(probe.scenario, capture, {
      id: "fixture",
      name: "fixture",
      version: "1",
    });
    expect(
      evaluateSaasProbe(evidence, probe, "operator", "test-workspace"),
    ).toMatchObject({ status: "unknown" });
  },
);

test.each([
  "foreign-response",
  "duplicate-json",
  "inexact-number",
  "invalid-utf8",
  "redacted",
  "duplicate-transaction",
])("does not infer an outcome from %s", (kind) => {
  const probe =
    saasInvestigationPlanSchema.parse(investigationPlan()).experiments[0]!
      .before;
  const capture = investigationCapture(probe.scenario, {
    actor: "operator",
    workspace: "test-workspace",
    record: null,
  });
  const response = capture.events.items.find(
    (event) => event.kind === "response",
  )!;
  if (response.kind !== "response") throw new Error("Fixture response missing");
  if (kind === "foreign-response")
    response.url = sanitizeBrowserUrl(
      "https://unrelated.example.test/state/first",
    );
  if (kind === "duplicate-transaction") {
    const extra = structuredClone(capture.events.items);
    for (const event of extra) {
      event.sequence += 100;
      if ("transaction_id" in event)
        event.transaction_id = "second-transaction";
      if (event.kind === "network-content") event.source_event_sequence += 100;
    }
    capture.events.items.push(...extra);
    capture.events.retained = capture.events.items.length;
  }
  const content = capture.events.items.find(
    (event) => event.kind === "network-content" && event.phase === "response",
  );
  if (content?.kind !== "network-content" || content.body.state !== "captured")
    throw new Error("Fixture body missing");
  if (kind === "redacted") content.body.redacted = true;
  if (["duplicate-json", "inexact-number", "invalid-utf8"].includes(kind)) {
    const raw =
      kind === "invalid-utf8"
        ? Buffer.from([0xff])
        : Buffer.from(
            kind === "duplicate-json"
              ? '{"actor":"foreign","actor":"operator","workspace":"test-workspace","record":null}'
              : '{"actor":"operator","workspace":"test-workspace","record":null,"value":9007199254740993}',
          );
    content.body = {
      ...content.body,
      content: raw.toString("base64"),
      bytes: raw.length,
      sha256: createHash("sha256").update(raw).digest("hex"),
    };
  }
  const evidence = createBrowserScenarioEvidence(probe.scenario, capture, {
    id: "fixture",
    name: "fixture",
    version: "1",
  });
  expect(
    evaluateSaasProbe(evidence, probe, "operator", "test-workspace").status,
  ).toBe("unknown");
});

test.each(["session", "undeclared-write"])(
  "refuses %s before opening a target",
  (kind) => {
    const plan = investigationPlan();
    if (kind === "session")
      plan.experiments[0]!.action.storage = {
        ...plan.experiments[0]!.action.storage,
        local_storage: [
          {
            origin: plan.allowed_origins[0]!,
            entries: [
              {
                name: "workspace",
                value: { source: "literal", value: "different" },
              },
            ],
          },
        ],
      };
    else {
      plan.experiments[0]!.mutates = false;
      plan.experiments[0]!.action.actions = [
        {
          step_id: "save",
          action: "click",
          locator: { kind: "css", selector: "button" },
          button: "left",
          click_count: 1,
        },
      ];
    }
    expect(saasInvestigationPlanSchema.safeParse(plan).success).toBe(false);
  },
);
test("uses a complete selected response while preserving unrelated event coverage gaps", () => {
  const probe =
    saasInvestigationPlanSchema.parse(investigationPlan()).experiments[0]!
      .before;
  const capture = investigationCapture(probe.scenario, {
    actor: "operator",
    workspace: "test-workspace",
    record: null,
  });
  capture.completeness = {
    status: "incomplete",
    equality_eligible: false,
    missing_sections: ["events"],
    truncated_sections: [],
  };
  capture.limitations.push(
    "GET request body was not exposed; selected response bytes are retained.",
  );
  const evidence = createBrowserScenarioEvidence(probe.scenario, capture, {
    id: "fixture",
    name: "fixture",
    version: "1",
  });
  expect(
    evaluateSaasProbe(evidence, probe, "operator", "test-workspace").status,
  ).toBe("observed");
  capture.events.dropped = 1;
  const omitted = createBrowserScenarioEvidence(probe.scenario, capture, {
    id: "fixture",
    name: "fixture",
    version: "1",
  });
  expect(
    evaluateSaasProbe(omitted, probe, "operator", "test-workspace").status,
  ).toBe("unknown");
});
test("addresses nested JSON values without prototype or invalid array-index fallbacks", () => {
  const value = { context: { actors: [{ "a/b": 5 }] } };
  expect(saasObservationAtPointer(value, "/context/actors/0/a~1b")).toBe(5);
  expect(saasObservationAtPointer(value, "/context/actors/00")).toBeUndefined();
  expect(saasObservationAtPointer(value, "/context/toString")).toBeUndefined();
});
test("chooses a second distinguishing experiment from the first observation", () => {
  const plan = saasInvestigationPlanSchema.parse(investigationPlan());
  const first = selectSaasExperiment(plan, ["a", "b", "c", "d"], []);
  expect(first?.id).toBe("first");
  const remaining = survivingSaasHypotheses(first!, ["a", "b", "c", "d"], 1);
  expect(remaining).toEqual(["a", "b"]);
  expect(selectSaasExperiment(plan, remaining, ["first"])?.id).toBe("second");
  expect(survivingSaasHypotheses(plan.experiments[1]!, remaining, 0)).toEqual([
    "a",
  ]);
  expect(survivingSaasHypotheses(first!, remaining, 100)).toEqual([]);
});

test.each(["duplicate", "prediction", "origin", "probe-action", "consent"])(
  "rejects invalid %s before execution",
  (kind) => {
    const plan = investigationPlan();
    if (kind === "duplicate") plan.experiments[1]!.id = "first";
    if (kind === "prediction") plan.experiments[0]!.predictions.pop();
    if (kind === "origin")
      plan.experiments[0]!.action.start_url.url = "https://other.example.test/";
    if (kind === "probe-action")
      plan.experiments[0]!.before.scenario.actions = [
        {
          action: "click",
          step_id: "click",
          locator: { kind: "css", selector: "button" },
          button: "left",
          click_count: 1,
        },
      ];
    if (kind === "consent") plan.allow_mutations = false;
    expect(saasInvestigationPlanSchema.safeParse(plan).success).toBe(false);
  },
);

test("extracts an attributed JSON response with actor, workspace and initial state guards", () => {
  const probe =
    saasInvestigationPlanSchema.parse(investigationPlan()).experiments[0]!
      .before;
  const evidence = investigationEvidence(probe.scenario, {
    actor: "operator",
    workspace: "test-workspace",
    record: null,
  });
  expect(
    evaluateSaasProbe(evidence, probe, "operator", "test-workspace"),
  ).toMatchObject({ status: "observed", document: { record: null } });
  expect(
    evaluateSaasProbe(evidence, probe, "someone-else", "test-workspace").status,
  ).toBe("unknown");
  expect(
    evaluateSaasProbe(evidence, probe, "operator", "wrong-workspace").status,
  ).toBe("unknown");
});

test("missing initial state cannot equal null and incomplete evidence cannot support a conclusion", () => {
  const probe =
    saasInvestigationPlanSchema.parse(investigationPlan()).experiments[0]!
      .before;
  const evidence = investigationEvidence(probe.scenario, {
    actor: "operator",
    workspace: "test-workspace",
  });
  expect(
    evaluateSaasProbe(evidence, probe, "operator", "test-workspace").status,
  ).toBe("unknown");
  const other = investigationEvidence(probe.scenario, {
    actor: "operator",
    workspace: "test-workspace",
    record: null,
  });
  (other.normalized_result as { events: { dropped: number } }).events.dropped =
    1;
  expect(
    evaluateSaasProbe(other, probe, "operator", "test-workspace").status,
  ).toBe("unknown");
});
