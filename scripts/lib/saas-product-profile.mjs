import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
const schema = JSON.parse(
  readFileSync(
    new URL("../fixtures/saas-profiles/profile.schema.json", import.meta.url),
    "utf8",
  ),
);
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
export function inspectProductProfile(input) {
  if (!validate(input))
    return { status: "invalid", issues: structuredClone(validate.errors) };
  const workflowIds = new Set(input.workflows.map(({ id }) => id));
  const experimentIds = new Set(input.experiments.map(({ id }) => id));
  if (
    workflowIds.size !== input.workflows.length ||
    experimentIds.size !== input.experiments.length ||
    input.experiments.some(({ workflowId }) => !workflowIds.has(workflowId))
  )
    return {
      status: "invalid",
      issues: ["Duplicate identities or unresolved experiment workflow."],
    };
  const coverage = Object.fromEntries(
    ["planned", "recorded", "verified", "unknown"].map((status) => [
      status,
      input.workflows.filter((w) => w.status === status).length,
    ]),
  );
  return {
    status: "valid_plan",
    profileId: input.profileId,
    setup: input.setup,
    unknownSetup: Object.entries(input.setup)
      .filter(([, fact]) => fact.provenance === "unknown")
      .map(([name]) => name),
    observationMethods: input.observationMethods,
    coverage,
    workflows: input.workflows,
    externalDependencies: input.externalDependencies,
    nextExperiments: input.experiments.filter(
      ({ status }) => status === "planned",
    ),
    limitations: [
      "Coverage and access are caller-declared; evidence references are not authenticated.",
      "This profile inspector performs no vendor interaction and grants no permission for live external effects.",
      "Workflow counts describe only this explicit list, not a percentage of the vendor product.",
    ],
  };
}
