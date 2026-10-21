import {
  browserScenarioSchema,
  type BrowserScenario,
} from "../../src/domain/browserScenario.js";
import { createBrowserScenarioEvidence } from "../../src/application/BrowserScenarioEvidence.js";
export { createBrowserScenarioEvidence } from "../../src/application/BrowserScenarioEvidence.js";
import {
  scenarioCaptureFixture,
  SCENARIO_ORIGIN,
} from "./browserScenarioCapture.js";

export const investigationScenario = (path = "/state") =>
  browserScenarioSchema.parse({
    browser: { mode: "launch", executable_path: process.execPath },
    start_url: { url: `${SCENARIO_ORIGIN}${path}` },
    actions: [
      { step_id: "settle", action: "wait_for_timeout", duration_ms: 1 },
    ],
    capture: {
      events: ["network"],
      network: { request_body: true, response_body: true },
    },
  });

export const investigationPlan = () => ({
  version: 1 as const,
  investigation_id: "rounding-study",
  question: "Which of the supplied calculation rules explains these cases?",
  study: { study_id: "study-1", scenario_id: "calculate" },
  actor_id: "operator",
  workspace_id: "test-workspace",
  allowed_origins: [SCENARIO_ORIGIN],
  allow_mutations: true,
  limits: {
    max_experiments: 3,
    max_actions: 30,
    max_run_ms: 30000,
    max_journal_bytes: 8 * 1024 * 1024,
  },
  hypotheses: ["a", "b", "c", "d"].map((id) => ({
    id,
    description: `Rule ${id}`,
  })),
  experiments: ["first", "second", "third"].map((id, index) => ({
    id,
    description: `Calculate ${id}`,
    mutates: true,
    before: {
      scenario: investigationScenario(`/state/${id}`),
      response_url: `${SCENARIO_ORIGIN}/state/${id}`,
      actor_pointer: "/actor",
      workspace_pointer: "/workspace",
      assertions: [{ pointer: "/record", equals: null }],
    },
    action: investigationScenario(`/act/${id}`),
    after: {
      scenario: investigationScenario(`/state/${id}`),
      response_url: `${SCENARIO_ORIGIN}/state/${id}`,
      actor_pointer: "/actor",
      workspace_pointer: "/workspace",
      assertions: [{ pointer: "/record", equals: `run-1-${id}` }],
    },
    outcome_pointer: "/value",
    predictions: ["a", "b", "c", "d"].map((hypothesis_id, h) => ({
      hypothesis_id,
      value: index === 0 ? (h < 2 ? 1 : 2) : index === 1 ? h % 2 : 0,
    })),
  })),
});

export const investigationCapture = (
  scenario: BrowserScenario,
  document: unknown,
) => {
  const capture = scenarioCaptureFixture(
    [
      {
        method: "GET",
        url: new URL(scenario.start_url.url).pathname,
        status: 200,
        body: JSON.stringify(document),
      },
    ],
    scenario.capture.network,
  );
  capture.scenario.action_count = scenario.actions.length;
  capture.scenario.event_families = scenario.capture.events;
  capture.scenario.limits = scenario.capture.limits;
  capture.steps = [
    { ...capture.steps[0]!, step_id: "scenario_start", action: "goto_start" },
    ...scenario.actions.map((action, index) => ({
      ...capture.steps[1]!,
      step_id: action.step_id,
      step_index: index + 1,
      action: action.action,
    })),
  ];
  return capture;
};

export const investigationEvidence = (
  scenario: BrowserScenario,
  document: unknown,
) =>
  createBrowserScenarioEvidence(
    scenario,
    investigationCapture(scenario, document),
    { id: "fixture", name: "Synthetic fixture", version: "1" },
  );
