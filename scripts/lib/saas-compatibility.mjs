import { isDeepStrictEqual } from "node:util";
import { isSafeNumber } from "lossless-json";

// This companion evaluates caller-supplied captures. Evidence references are retained,
// never opened, fetched, executed, or treated as independently verified attestations.
const own = (value, key) => Object.hasOwn(value, key);
function object(value, keys, at) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error(`${at}: expected object`);
  if (keys && Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error(`${at}: unsupported field`);
}
function text(value, at) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${at}: expected nonempty string`);
}
function list(value, at, nonempty = false) {
  if (!Array.isArray(value) || (nonempty && !value.length))
    throw new Error(`${at}: expected ${nonempty ? "nonempty " : ""}array`);
}
function time(value, at) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${at}: expected nonnegative safe integer milliseconds`);
}
function refs(value, at) {
  list(value, at, true);
  value.forEach((item) => text(item, at));
}
const supportedNumber = (value) =>
  Number.isFinite(value) &&
  (!Number.isInteger(value) || Number.isSafeInteger(value));
const numericError = () =>
  new Error(
    "value: number loses information or exceeds the safe integer range; encode exact values as JSON strings",
  );

// Inspect original numeric tokens before JSON.parse's rounded Numbers can be
// mistaken for exact captured values. Keep native JSON object/key semantics.
export function parseCompatibilityJson(source) {
  return JSON.parse(source, (_key, value, context) => {
    if (
      typeof value === "number" &&
      (!supportedNumber(value) || !isSafeNumber(context.source))
    )
      throw numericError();
    return value;
  });
}
function json(value, depth = 0) {
  if (depth > 64)
    throw new Error("value: exceeds supported JSON nesting depth (64)");
  if (typeof value === "number") {
    if (!supportedNumber(value)) throw numericError();
    return;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (Array.isArray(value)) {
    value.forEach((item) => json(item, depth + 1));
    return;
  }
  object(value, null, "value");
  if (own(value, "$entity")) {
    object(value, ["$entity"], "entity reference");
    object(value.$entity, ["type", "id"], "entity reference");
    text(value.$entity.type, "entity type");
    text(value.$entity.id, "entity id");
  } else Object.values(value).forEach((item) => json(item, depth + 1));
}
const key = (...parts) => JSON.stringify(parts);
function validateContext(context) {
  object(context, null, "context");
  for (const entry of Object.values(context)) {
    object(entry, ["provenance", "value", "evidence"], "context entry");
    if (!["observed", "caller_declared", "unknown"].includes(entry.provenance))
      throw new Error("invalid context provenance");
    if (entry.provenance === "unknown") {
      if (own(entry, "value") || own(entry, "evidence"))
        throw new Error("unknown context must not assert a value");
    } else {
      if (!own(entry, "value")) throw new Error("context value missing");
      json(entry.value);
      if (entry.provenance === "observed")
        refs(entry.evidence, "context evidence");
      else if (own(entry, "evidence")) refs(entry.evidence, "context evidence");
    }
  }
}
function validateRun(run, side) {
  object(
    run,
    [
      "runId",
      "workspace",
      "collectedAt",
      "revision",
      "context",
      "observations",
      "windows",
    ],
    side,
  );
  text(run.runId, "runId");
  text(run.workspace, "workspace");
  text(run.revision, "revision");
  text(run.collectedAt, "collectedAt");
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(run.collectedAt) ||
    !Number.isFinite(Date.parse(run.collectedAt)) ||
    new Date(run.collectedAt).toISOString() !== run.collectedAt
  )
    throw new Error(
      "collectedAt: expected valid UTC ISO timestamp with milliseconds",
    );
  validateContext(run.context);
  list(run.windows, "windows");
  const windows = new Set();
  for (const window of run.windows) {
    object(
      window,
      ["observation", "coverage", "observedUntilMs", "evidence"],
      "window",
    );
    text(window.observation, "window observation");
    if (windows.has(window.observation))
      throw new Error("duplicate observation window");
    windows.add(window.observation);
    if (!["complete", "incomplete"].includes(window.coverage))
      throw new Error("invalid window coverage");
    time(window.observedUntilMs, "observedUntilMs");
    refs(window.evidence, "window evidence");
  }
  list(run.observations, "observations");
  const seen = new Set();
  for (const observation of run.observations) {
    object(
      observation,
      ["name", "kind", "elapsedMs", "value", "evidence"],
      "observation",
    );
    text(observation.name, "observation name");
    if (!["ui", "persisted_read"].includes(observation.kind))
      throw new Error("invalid observation kind");
    time(observation.elapsedMs, "elapsedMs");
    if (!own(observation, "value"))
      throw new Error("observation value missing");
    json(observation.value);
    refs(observation.evidence, "observation evidence");
    const identity = key(observation.name, observation.elapsedMs);
    if (seen.has(identity)) throw new Error("ambiguous same-time observations");
    seen.add(identity);
    const window = run.windows.find((w) => w.observation === observation.name);
    if (!window || observation.elapsedMs > window.observedUntilMs)
      throw new Error("observation outside recorded window");
  }
}
function validate(input) {
  object(
    input,
    [
      "version",
      "caseId",
      "scope",
      "unsupported",
      "contextKeys",
      "reference",
      "replacement",
      "entities",
      "checks",
    ],
    "case",
  );
  if (input.version !== 1) throw new Error("version: expected 1");
  text(input.caseId, "caseId");
  text(input.scope, "scope");
  list(input.unsupported, "unsupported");
  input.unsupported.forEach((x) => text(x, "unsupported"));
  refs(input.contextKeys, "contextKeys");
  if (new Set(input.contextKeys).size !== input.contextKeys.length)
    throw new Error("duplicate context key");
  list(input.checks, "checks", true);
  const names = new Set();
  for (const check of input.checks) {
    object(check, ["name", "observation", "persisted", "deadlineMs"], "check");
    text(check.name, "check name");
    text(check.observation, "observation");
    if (names.has(check.name)) throw new Error("duplicate check name");
    names.add(check.name);
    if (typeof check.persisted !== "boolean")
      throw new Error("persisted: expected boolean");
    time(check.deadlineMs, "deadlineMs");
    if (!check.deadlineMs)
      throw new Error("deadlineMs: expected positive duration");
  }
  for (const side of ["reference", "replacement"])
    validateRun(input[side], side);
  if (input.reference.runId === input.replacement.runId)
    throw new Error("reference and replacement run identities must differ");
  list(input.entities, "entities");
  const indices = { reference: new Map(), replacement: new Map() };
  const logical = new Set();
  for (const entity of input.entities) {
    object(
      entity,
      ["type", "logicalId", "reference", "replacement", "evidence"],
      "entity correspondence",
    );
    text(entity.type, "entity type");
    text(entity.logicalId, "logicalId");
    refs(entity.evidence, "entity evidence");
    const logicalKey = key(entity.type, entity.logicalId);
    if (logical.has(logicalKey)) throw new Error("duplicate logical entity");
    logical.add(logicalKey);
    for (const side of ["reference", "replacement"]) {
      const binding = entity[side];
      object(binding, ["runId", "workspace", "id"], "entity binding");
      text(binding.id, "entity id");
      if (
        binding.runId !== input[side].runId ||
        binding.workspace !== input[side].workspace
      )
        throw new Error("entity binding scope mismatch");
      const bindingKey = key(entity.type, binding.id);
      if (indices[side].has(bindingKey))
        throw new Error("non-bijective entity correspondence");
      indices[side].set(bindingKey, logicalKey);
    }
  }
  return indices;
}
function canonical(value, index) {
  if (Array.isArray(value))
    return ["array", value.map((v) => canonical(v, index))];
  if (value && typeof value === "object") {
    if (own(value, "$entity")) {
      const mapped = index.get(key(value.$entity.type, value.$entity.id));
      if (!mapped) throw new Error("unresolved_entity");
      return ["entity", mapped];
    }
    // Use entries instead of property assignment so __proto__ remains ordinary data.
    return [
      "object",
      Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, canonical(v, index)]),
      ),
    ];
  }
  return ["scalar", value];
}
function select(run, check) {
  const window = run.windows.find((w) => w.observation === check.observation);
  const candidates = run.observations.filter(
    (o) =>
      o.name === check.observation &&
      o.elapsedMs > 0 &&
      o.elapsedMs <= check.deadlineMs &&
      (!check.persisted || o.kind === "persisted_read"),
  );
  const observation = candidates.sort((a, b) => b.elapsedMs - a.elapsedMs)[0];
  if (!window || window.coverage === "incomplete")
    return {
      status: "unknown",
      reason: "observation_incomplete",
      evidence: window?.evidence ?? [],
      window: window ?? null,
    };
  if (observation)
    return {
      status: "observed",
      observation,
      evidence: observation.evidence,
      window,
    };
  if (window.observedUntilMs >= check.deadlineMs)
    return {
      status: "fail",
      reason: "deadline_exceeded",
      evidence: window.evidence,
      window,
    };
  return {
    status: "unknown",
    reason: "observation_incomplete",
    evidence: window.evidence,
    window,
  };
}
function runIdentity({ runId, workspace, collectedAt, revision }) {
  return { runId, workspace, collectedAt, revision };
}
export function evaluateCompatibility(input) {
  let indices;
  try {
    indices = validate(input);
  } catch (error) {
    return { version: 1, status: "invalid", reason: error.message };
  }
  const contextIssues = input.contextKeys.filter((name) => {
    const a = own(input.reference.context, name)
        ? input.reference.context[name]
        : undefined,
      b = own(input.replacement.context, name)
        ? input.replacement.context[name]
        : undefined;
    return (
      !a ||
      !b ||
      a.provenance === "unknown" ||
      b.provenance === "unknown" ||
      !isDeepStrictEqual(a.value, b.value)
    );
  });
  const checks = input.checks.map((check) => {
    const reference = select(input.reference, check),
      replacement = select(input.replacement, check);
    const result = {
      ...check,
      status: "unknown",
      reason: "context_unresolved",
      reference,
      replacement,
    };
    if (contextIssues.length) return result;
    if (reference.status !== "observed" || replacement.status !== "observed") {
      const problem =
        [reference, replacement].find((v) => v.status === "fail") ??
        [reference, replacement].find((v) => v.status === "unknown");
      return { ...result, status: problem.status, reason: problem.reason };
    }
    try {
      const equal = isDeepStrictEqual(
        canonical(reference.observation.value, indices.reference),
        canonical(replacement.observation.value, indices.replacement),
      );
      return {
        ...result,
        status: equal ? "pass" : "fail",
        reason: equal ? "observed_values_match" : "observed_values_differ",
      };
    } catch {
      return { ...result, reason: "unresolved_entity" };
    }
  });
  const status = checks.some((c) => c.status === "fail")
    ? "fail"
    : checks.some((c) => c.status === "unknown")
      ? "unknown"
      : "pass";
  return {
    version: 1,
    caseId: input.caseId,
    scope: input.scope,
    status,
    runs: {
      reference: runIdentity(input.reference),
      replacement: runIdentity(input.replacement),
    },
    contextKeys: input.contextKeys,
    contextIssues,
    contextAlignment: contextIssues.length
      ? "unknown"
      : input.contextKeys.some(
            (name) =>
              input.reference.context[name].provenance === "caller_declared" ||
              input.replacement.context[name].provenance === "caller_declared",
          )
        ? "conditional_on_caller_declarations"
        : "recorded_observations_match",
    context: {
      reference: input.reference.context,
      replacement: input.replacement.context,
    },
    entities: input.entities,
    checks,
    unsupported: input.unsupported,
    limitations: [
      "Offline evaluation of supplied evidence references; capture authenticity is not verified.",
      "Fresh persisted reads and observation-window completeness are asserted by the capture producer, not independently executed or verified by this evaluator.",
      "Agreement applies only to the named observations, context, and recorded conditions.",
    ],
  };
}
