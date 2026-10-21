import { parse } from "lossless-json";
import { scenarioCaptureRecords } from "./analysisView/scenarioCaptureRecords.js";
import { browserScenarioCaptureSchema } from "./browserScenarioCapture.js";
import { digestCanonicalValue } from "./canonicalDigest.js";
import { parseEvidence, type Evidence } from "./evidence.js";
import { isExactJsonNumber } from "./exactJsonNumber.js";
import { jsonValueSchema, type JsonValue } from "./jsonValue.js";
import type {
  SaasExperiment,
  SaasInvestigationPlan,
  SaasProbe,
} from "./saasInvestigation.js";

/** Full RFC 6901 object/array lookup, preserving absent versus JSON null. */
export const saasObservationAtPointer = (
  document: JsonValue,
  pointer: string,
): JsonValue | undefined => {
  if (pointer === "") return document;
  if (!pointer.startsWith("/") || /~(?:[^01]|$)/u.test(pointer))
    return undefined;
  let current: JsonValue | undefined = document;
  for (const segment of pointer.slice(1).split("/")) {
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.hasOwn(current, key)
    )
      return undefined;
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(key)) return undefined;
      current = current[Number(key)];
    } else current = current[key];
  }
  return current;
};

/** Select the untried experiment separating the most surviving hypothesis pairs. */
export const selectSaasExperiment = (
  plan: SaasInvestigationPlan,
  survivors: readonly string[],
  attempted: readonly string[],
): SaasExperiment | undefined => {
  let selected: SaasExperiment | undefined;
  let best = 0;
  for (const experiment of plan.experiments) {
    if (attempted.includes(experiment.id)) continue;
    const predictions = experiment.predictions.filter(({ hypothesis_id: id }) =>
      survivors.includes(id),
    );
    let separated = 0;
    for (const [i, a] of predictions.entries())
      for (const b of predictions.slice(i + 1))
        if (digestCanonicalValue(a.value) !== digestCanonicalValue(b.value))
          separated += 1;
    if (separated > best) {
      selected = experiment;
      best = separated;
    }
  }
  return selected;
};

export const survivingSaasHypotheses = (
  experiment: SaasExperiment,
  survivors: readonly string[],
  value: JsonValue,
): string[] => {
  const observed = digestCanonicalValue(value);
  return survivors.filter((id) =>
    experiment.predictions.some(
      (prediction) =>
        prediction.hypothesis_id === id &&
        digestCanonicalValue(prediction.value) === observed,
    ),
  );
};

type ProbeResult =
  | {
      readonly status: "observed";
      readonly document: JsonValue;
      readonly evidence_id: string;
    }
  | { readonly status: "unknown"; readonly reason: string };
const unknown = (reason: string): ProbeResult => ({
  status: "unknown",
  reason,
});

/** Missing, ambiguous, redacted or lossy data cannot satisfy a state/identity assertion. */
export const evaluateSaasProbe = (
  evidence: Evidence,
  probe: SaasProbe,
  actor: string,
  workspace: string,
): ProbeResult => {
  try {
    parseEvidence(evidence);
    if (
      evidence.operation !== "capture_browser_scenario" ||
      evidence.parameters.scenario_sha256 !==
        digestCanonicalValue(probe.scenario)
    )
      return unknown("Probe evidence belongs to a different scenario");
    const capture = browserScenarioCaptureSchema.parse(
      evidence.normalized_result,
    );
    if (
      capture.steps.length !== probe.scenario.actions.length + 1 ||
      capture.scenario.action_count !== probe.scenario.actions.length ||
      capture.steps.some(
        (step, index) =>
          step.status !== "completed" ||
          step.step_index !== index ||
          step.step_id !==
            (index === 0
              ? "scenario_start"
              : probe.scenario.actions[index - 1]?.step_id),
      ) ||
      capture.events.dropped !== 0 ||
      capture.events.omissions.by_kind.length !== 0 ||
      capture.events.omissions.network_transactions.length !== 0 ||
      capture.events.omissions.network_transaction_range !== null ||
      capture.completeness.truncated_sections.length !== 0 ||
      capture.completeness.missing_sections.some(
        (section) => section !== "events",
      )
    )
      return unknown("Probe capture is incomplete");
    // Aggregate event coverage also includes unrelated content and pre-existing
    // shared-context traffic. Establish only this selected complete response;
    // the original capture's gaps and limitations remain attached to Evidence.
    // The shared projection owns transaction identity. Refuse redaction before it
    // projects displayable bytes, which deliberately retain redaction markers.
    if (
      capture.events.items.some(
        (event) =>
          event.kind === "network-content" &&
          event.body.state === "captured" &&
          event.body.redacted,
      )
    )
      return unknown("Probe network content was redacted");
    const matches = scenarioCaptureRecords(capture, "manifest").records.filter(
      (record) => {
        const request = saasObservationAtPointer(record.reported, "/request");
        return (
          request !== null &&
          typeof request === "object" &&
          !Array.isArray(request) &&
          request.method === "GET" &&
          request.url === probe.response_url
        );
      },
    );
    if (matches.length !== 1)
      return unknown("Probe requires exactly one matching GET response");
    const response = saasObservationAtPointer(
      matches[0]!.reported,
      "/response",
    );
    if (
      response === null ||
      typeof response !== "object" ||
      Array.isArray(response) ||
      typeof response.status !== "number" ||
      response.status < 200 ||
      response.status >= 300
    )
      return unknown("Probe did not retain a successful response");
    const body = matches[0]!.binary_fields[0];
    if (body?.state !== "retained" || body.content_base64 === undefined)
      return unknown("Probe response body is unavailable");
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(Buffer.from(body.content_base64, "base64"));
    const document = jsonValueSchema.parse(
      parse(text, undefined, {
        parseNumber: (source) => {
          const value = Number(source);
          if (!isExactJsonNumber(value, source))
            throw new Error("Inexact JSON number");
          return value;
        },
      }),
    );
    if (
      saasObservationAtPointer(document, probe.actor_pointer) !== actor ||
      saasObservationAtPointer(document, probe.workspace_pointer) !== workspace
    )
      return unknown(
        "Observed actor or workspace does not match the investigation",
      );
    for (const assertion of probe.assertions) {
      const actual = saasObservationAtPointer(document, assertion.pointer);
      if (
        actual === undefined ||
        digestCanonicalValue(actual) !== digestCanonicalValue(assertion.equals)
      )
        return unknown(
          `State assertion was not established at ${assertion.pointer}`,
        );
    }
    return { status: "observed", document, evidence_id: evidence.evidence_id };
  } catch {
    return unknown(
      "Probe evidence is invalid, ambiguous, or its JSON cannot be decoded exactly",
    );
  }
};
