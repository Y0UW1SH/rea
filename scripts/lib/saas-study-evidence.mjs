import {
  readScenarioCapture,
  assembleTransactions,
} from "./saas-scenario-capture.mjs";
import { captureCompleteness } from "./saas-api-contract.mjs";
import {
  captureIsComplete,
  assertStudyCaptureProvenance,
} from "./saas-capture-completeness.mjs";

function observationResults(capture, refs, complete) {
  const steps = new Map(
    capture.steps.map((step) => [step.step_id, step.step_index]),
  );
  if (steps.size !== capture.steps.length)
    throw new Error("duplicate capture step identity");
  const events = new Map(
    capture.events.items.map((event) => [event.sequence, event]),
  );
  return refs.map((ref) => {
    const index = steps.get(ref.stepId);
    const event =
      ref.eventSequence === undefined
        ? undefined
        : events.get(ref.eventSequence);
    const found =
      index !== undefined &&
      (ref.eventSequence === undefined || event?.step_index === index);
    return {
      observationId: ref.observationId,
      captureId: ref.captureId,
      status: found ? "verified" : complete ? "fail" : "unknown",
      ...(!found
        ? { reason: "observation coordinates not present in capture" }
        : {}),
    };
  });
}

// Declared actions are plan labels for existing capture steps. A capture that lacks
// one did not exercise the plan; like other incomplete accounting it stays unknown
// rather than contradicting retained bytes. Only manifest labels are reported.
function missingActionSteps(capture, scenario) {
  const present = new Set(capture.steps.map((step) => step.step_id));
  return scenario.actions
    .map((action) => action.stepId)
    .filter((stepId) => !present.has(stepId));
}

function captureVerdict(complete, missing) {
  const listed = missing.length > 0 ? { missingActionStepIds: missing } : {};
  if (!complete)
    return {
      status: "unknown",
      reason: "capture declarations do not establish completeness",
      ...listed,
    };
  if (missing.length > 0)
    return {
      status: "unknown",
      reason: "capture lacks declared action steps",
      ...listed,
    };
  return { status: "verified" };
}

// Existing normalized_result captures remain the evidence format. A digest proves
// retained byte identity, never actor identity, authorization or business behavior.
export async function verifyStudyCaptures(study, root) {
  const captures = [];
  const observations = [];
  const scenarios = new Map(
    study.scenarios.map((scenario) => [scenario.scenarioId, scenario]),
  );
  const byCapture = new Map();
  for (const observation of study.evidence.observations) {
    const entries = byCapture.get(observation.captureId) ?? [];
    entries.push(observation);
    byCapture.set(observation.captureId, entries);
  }
  for (const selected of study.evidence.captures) {
    const entry = {
      captureId: selected.captureId,
      actorId: selected.actorId,
      contextId: selected.contextId,
      scenarioId: selected.scenarioId,
      identityBasis: "caller-declared",
      file: selected.file,
      status: "unknown",
    };
    const refs = byCapture.get(selected.captureId) ?? [];
    try {
      // The reader bounds actual bytes even if declared sizes are dishonest.
      const read = await readScenarioCapture(
        root,
        selected.file,
        selected.bytes,
      );
      entry.sha256 = read.sha256;
      entry.bytes = read.bytes;
      if (read.sha256 !== selected.sha256 || read.bytes !== selected.bytes)
        throw new Error("capture bytes or SHA-256 disagree with the manifest");
      assertStudyCaptureProvenance(read.capture);
      assembleTransactions(read.capture, {
        maxTransactions: study.limits.maxRequests,
      });
      const completeness = captureCompleteness(read.capture);
      const complete = captureIsComplete(read.capture);
      Object.assign(
        entry,
        captureVerdict(
          complete,
          missingActionSteps(read.capture, scenarios.get(selected.scenarioId)),
        ),
      );
      entry.completeness = completeness;
      observations.push(...observationResults(read.capture, refs, complete));
    } catch (error) {
      entry.status = error?.code === "ENOENT" ? "unknown" : "fail";
      // Do not echo captured text or filesystem error paths into the report.
      entry.reason =
        error?.code === "ENOENT"
          ? "capture unavailable"
          : "capture integrity or format check failed";
      for (const ref of refs)
        observations.push({
          observationId: ref.observationId,
          captureId: ref.captureId,
          status: entry.status,
          reason: entry.reason,
        });
    }
    captures.push(entry);
  }
  const statuses = [...captures, ...observations].map((entry) => entry.status);
  return {
    version: 1,
    studyId: study.studyId,
    status: statuses.includes("fail")
      ? "fail"
      : statuses.length === 0 || statuses.includes("unknown")
        ? "unknown"
        : "verified",
    captures,
    observations,
    coverageStatus: "unknown",
    unsupportedOperations: study.coveragePolicy.unsupportedOperations,
    limitations: [
      "Verified means retained bytes and observation coordinates were checked, not behavioral equivalence or required coverage.",
      "Actor, context, workspace and authority bindings are caller-declared; captures do not authenticate them.",
      "This offline inspector executes no scenario and enforces no live request, mutation or rate policy.",
      "Paths are bounded beneath the selected root; this is not a hostile-filesystem sandbox.",
    ],
  };
}
