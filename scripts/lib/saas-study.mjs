import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { admitPolicy } from "./saas-export-budget.mjs";
import {
  decodeExportText,
  parseExportJson,
  readBoundedExport,
} from "./saas-export-comparison.mjs";
import { isCanonicalOrigin } from "./saas-origin-pairs.mjs";
import { verifyStudyCaptures } from "./saas-study-evidence.mjs";

const schema = JSON.parse(
  readFileSync(
    new URL("../fixtures/saas-study/study.schema.json", import.meta.url),
    "utf8",
  ),
);
const ajv = new Ajv2020({
  strict: true,
  allErrors: false,
  ownProperties: true,
});
ajv.addFormat(
  "saas-origin",
  (value) => isCanonicalOrigin(value) && /^https?:/u.test(value),
);
ajv.addFormat(
  "saas-relative-file",
  (value) =>
    value.length > 0 &&
    !/[\\:\u0000-\u001f]/u.test(value) &&
    !value.startsWith("/") &&
    value
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== ".."),
);
const validate = ajv.compile(schema);

const invalid = (message) => ({ status: "invalid", issues: [message] });
const message = (error) =>
  error instanceof Error ? error.message : "Study validation failed";
function requireReference(condition, at) {
  if (!condition) throw new Error(`${at}: unresolved or conflicting identity`);
}
function indexBy(values, key, at) {
  const index = new Map();
  for (const value of values) {
    if (index.has(value[key])) throw new Error(`${at}: duplicate ${key}`);
    index.set(value[key], value);
  }
  return index;
}

// Schema and cross references are checked synchronously before any read. Only a
// private JSON snapshot crosses the asynchronous boundary; credentials have no fields.
export function validateStudyManifest(input) {
  try {
    if (!validate(input)) {
      const error = validate.errors[0];
      return invalid(`${error.instancePath || "/"}: ${error.keyword}`);
    }
    admitPolicy(input);
    const study = structuredClone(input);
    const actors = indexBy(study.actors, "actorId", "actors");
    indexBy(study.actors, "sessionId", "actors");
    const scenarios = indexBy(study.scenarios, "scenarioId", "scenarios");
    const captures = indexBy(study.evidence.captures, "captureId", "captures");
    indexBy(study.evidence.captures, "file", "captures");
    const observations = indexBy(
      study.evidence.observations,
      "observationId",
      "observations",
    );
    for (const origin of study.authority.origins)
      requireReference(
        study.target.origins.includes(origin),
        "authority.origins",
      );
    for (const scenario of study.scenarios) {
      for (const actorId of scenario.actorIds)
        requireReference(actors.has(actorId), "scenario.actorIds");
      const steps = indexBy(scenario.actions, "stepId", "scenario.actions");
      indexBy(
        scenario.expectedObservations,
        "expectationId",
        "scenario.expectedObservations",
      );
      for (const action of scenario.actions)
        requireReference(
          scenario.actorIds.includes(action.actorId),
          "action.actorId",
        );
      for (const expected of scenario.expectedObservations)
        requireReference(steps.has(expected.stepId), "expectation.stepId");
      if (scenario.initialState.status === "observed")
        for (const id of scenario.initialState.evidenceIds) {
          const observation = observations.get(id);
          requireReference(
            observation !== undefined &&
              captures.get(observation.captureId)?.scenarioId ===
                scenario.scenarioId,
            "initialState.evidenceIds",
          );
        }
    }
    if (study.revision.status === "observed")
      for (const id of study.revision.evidenceIds)
        requireReference(observations.has(id), "revision.evidenceIds");
    const contexts = new Map();
    let retainedBytes = 0;
    for (const capture of study.evidence.captures) {
      requireReference(actors.has(capture.actorId), "capture.actorId");
      requireReference(
        scenarios.get(capture.scenarioId)?.actorIds.includes(capture.actorId),
        "capture.scenarioId",
      );
      const owner = contexts.get(capture.contextId);
      requireReference(
        owner === undefined || owner === capture.actorId,
        "capture.contextId",
      );
      contexts.set(capture.contextId, capture.actorId);
      retainedBytes += capture.bytes;
    }
    if (retainedBytes > study.limits.maxEvidenceBytes)
      throw new Error("evidence: exceeds maxEvidenceBytes");
    for (const observation of study.evidence.observations)
      requireReference(
        captures.has(observation.captureId),
        "observation.captureId",
      );
    return { status: "valid", study };
  } catch (error) {
    return invalid(message(error));
  }
}

// Canonicalize keys only. Array order, including action order, is significant.
function ordered(value) {
  if (Array.isArray(value)) return value.map(ordered);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, ordered(value[key])]),
  );
}
export function serializeStudyManifest(input) {
  const checked = validateStudyManifest(input);
  if (checked.status !== "valid") throw new Error(checked.issues.join("; "));
  // Compact serialization stays within the same 1 MiB budget as the reader.
  return JSON.stringify(ordered(checked.study));
}
export async function readStudyManifest(root, file) {
  try {
    const source = await readBoundedExport(root, file, 1024 * 1024);
    const checked = validateStudyManifest(
      parseExportJson(decodeExportText(source)),
    );
    return {
      ...checked,
      source: { file, bytes: source.bytes, sha256: source.sha256 },
    };
  } catch (error) {
    return invalid(message(error));
  }
}
export async function checkStudyEvidence(input, root) {
  const checked = validateStudyManifest(input);
  if (checked.status !== "valid") return checked;
  return verifyStudyCaptures(checked.study, root);
}
