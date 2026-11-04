import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildContractFixture } from "./lib/saas-api-contract-fixture.mjs";
import {
  validateStudyManifest,
  serializeStudyManifest,
  readStudyManifest,
  checkStudyEvidence,
} from "./lib/saas-study.mjs";

const example = new URL(
  "./fixtures/saas-study/invoice-study.json",
  import.meta.url,
);
const fixture = async () => JSON.parse(await readFile(example, "utf8"));
const stage = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "rea-study-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};
const captureStudy = async (t) => {
  const dir = await stage(t);
  const study = await fixture();
  const capture = structuredClone(buildContractFixture("reference-a"));
  const bytes = Buffer.from(JSON.stringify(capture));
  await writeFile(join(dir, "capture.json"), bytes);
  // Declared actions name real capture steps so the happy path is reachable.
  const [, opened, created] = capture.steps.map((step) => step.step_id);
  const scenario = study.scenarios[0];
  scenario.actions[0].stepId = opened;
  scenario.actions[1].stepId = created;
  scenario.expectedObservations[0].stepId = opened;
  study.evidence.captures.push({
    captureId: "manager-read",
    actorId: "manager",
    contextId: "manager-context",
    scenarioId: "invoice",
    file: "capture.json",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  study.evidence.observations.push({
    observationId: "invoice-read",
    captureId: "manager-read",
    stepId: capture.steps[capture.events.items[0].step_index].step_id,
    eventSequence: capture.events.items[0].sequence,
  });
  return { dir, study, capture };
};

test("study round-trips actor identities, authority, unknown revision and unsupported operations", async (t) => {
  const study = await fixture();
  const valid = validateStudyManifest(study);
  assert.equal(valid.status, "valid", JSON.stringify(valid.issues));
  assert.deepEqual(valid.study, study);
  study.actors[0].role = "changed-after-validation";
  assert.equal(valid.study.actors[0].role, "manager");
  const text = serializeStudyManifest(valid.study);
  const dir = await stage(t);
  await writeFile(join(dir, "study.json"), text);
  const loaded = await readStudyManifest(dir, "study.json");
  assert.equal(loaded.status, "valid");
  assert.deepEqual(loaded.study, valid.study);
  assert.equal(
    loaded.source.sha256,
    createHash("sha256").update(text).digest("hex"),
  );
  assert.equal(serializeStudyManifest(JSON.parse(text)), text);
  const unobserved = await checkStudyEvidence(loaded.study, dir);
  assert.equal(unobserved.status, "unknown");
  assert.deepEqual(unobserved.unsupportedOperations, ["invoice.delete"]);
  assert.equal(unobserved.coverageStatus, "unknown");
});

test("study rejects ambiguous identities, unresolved references and widened authority", async () => {
  for (const change of [
    (s) => s.actors.push(structuredClone(s.actors[0])),
    (s) => {
      s.actors[1].sessionId = s.actors[0].sessionId;
    },
    (s) => {
      s.scenarios[0].actorIds.push("absent");
    },
    (s) => {
      s.scenarios[0].actions[0].actorId = "absent";
    },
    (s) => {
      s.scenarios[0].actions.push(structuredClone(s.scenarios[0].actions[0]));
    },
    (s) => {
      s.authority.origins.push("https://foreign.example.test");
    },
    (s) => {
      s.target.origins[0] += "/path";
    },
    (s) => {
      s.target.origins[0] = "https://name:password@example.test";
    },
    (s) => {
      s.revision = {
        status: "observed",
        value: "v1",
        evidenceIds: ["missing"],
      };
    },
    (s) => {
      s.limits.deadlineMs = 0;
    },
    (s) => {
      s.limits.maxConcurrency = 1.5;
    },
    (s) => {
      s.version = 2;
    },
    (s) => {
      s.actors[0].cookies = ["secret"];
    },
    (s) => {
      s.authority.authorization = "secret";
    },
    (s) => {
      s.scenarios[0].actions[0].password = "secret";
    },
  ]) {
    const study = await fixture();
    change(study);
    assert.equal(
      validateStudyManifest(study).status,
      "invalid",
      change.toString(),
    );
    assert.throws(() => serializeStudyManifest(study));
  }
});

test("study checks retained capture identity and observation coordinates without asserting behavioral coverage", async (t) => {
  const { dir, study } = await captureStudy(t);
  const result = await checkStudyEvidence(study, dir);
  assert.equal(result.status, "verified", JSON.stringify(result));
  assert.equal(result.captures[0].captureId, "manager-read");
  assert.equal(result.captures[0].actorId, "manager");
  assert.equal(result.captures[0].identityBasis, "caller-declared");
  assert.equal(result.observations[0].status, "verified");
  assert.equal(result.coverageStatus, "unknown");
});

test("two actors keep distinct capture provenance through serialization and asynchronous checking", async (t) => {
  const { dir, study } = await captureStudy(t);
  const clerk = buildContractFixture("reference-b");
  const content = JSON.stringify(clerk);
  await writeFile(join(dir, "clerk.json"), content);
  study.evidence.captures.push({
    captureId: "clerk-read",
    actorId: "clerk",
    contextId: "clerk-context",
    scenarioId: "invoice",
    file: "clerk.json",
    bytes: Buffer.byteLength(content),
    sha256: createHash("sha256").update(content).digest("hex"),
  });
  study.evidence.observations.push({
    observationId: "clerk-observation",
    captureId: "clerk-read",
    stepId: clerk.steps[1].step_id,
  });
  const reloaded = JSON.parse(serializeStudyManifest(study));
  const pending = checkStudyEvidence(reloaded, dir);
  reloaded.evidence.captures[1].actorId = "manager";
  reloaded.evidence.captures[1].sha256 = "0".repeat(64);
  const result = await pending;
  assert.equal(result.status, "verified", JSON.stringify(result));
  assert.deepEqual(
    result.captures.map((entry) => entry.actorId),
    ["manager", "clerk"],
  );
  assert.equal(result.captures[1].sha256, study.evidence.captures[1].sha256);
});

test("each actor capture verifies with only its own actor's declared action steps", async (t) => {
  const { dir, study, capture } = await captureStudy(t);
  const original = await fixture();
  study.scenarios[0].actions = original.scenarios[0].actions;
  study.scenarios[0].expectedObservations =
    original.scenarios[0].expectedObservations;
  const retain = async (file, data, stepId) => {
    data.steps[2].step_id = stepId;
    const content = JSON.stringify(data);
    await writeFile(join(dir, file), content);
    return {
      bytes: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  };
  // The manager session holds only manager-update; the clerk's only clerk-update.
  Object.assign(
    study.evidence.captures[0],
    await retain("capture.json", capture, "manager-update"),
  );
  study.evidence.observations[0].stepId =
    capture.steps[capture.events.items[0].step_index].step_id;
  study.evidence.captures.push({
    captureId: "clerk-read",
    actorId: "clerk",
    contextId: "clerk-context",
    scenarioId: "invoice",
    file: "clerk.json",
    ...(await retain(
      "clerk.json",
      structuredClone(buildContractFixture("reference-b")),
      "clerk-update",
    )),
  });
  const result = await checkStudyEvidence(study, dir);
  assert.equal(result.status, "verified", JSON.stringify(result));
  assert.ok(result.captures.every((entry) => !entry.missingActionStepIds));
});

test("study retains unknown missing evidence and detects digest, size and observation contradictions", async (t) => {
  const { dir, study } = await captureStudy(t);
  const absent = structuredClone(study);
  absent.evidence.captures[0].file = "absent.json";
  assert.equal((await checkStudyEvidence(absent, dir)).status, "unknown");
  for (const change of [
    (s) => {
      s.evidence.captures[0].sha256 = "a".repeat(64);
    },
    (s) => {
      s.evidence.captures[0].bytes += 1;
    },
    (s) => {
      s.evidence.observations[0].stepId = "missing-step";
    },
    (s) => {
      s.evidence.observations[0].eventSequence = 999999;
    },
  ]) {
    const changed = structuredClone(study);
    change(changed);
    assert.equal(
      (await checkStudyEvidence(changed, dir)).status,
      "fail",
      change.toString(),
    );
  }
});

test("incomplete and malformed captures cannot establish verified evidence", async (t) => {
  const { dir, study, capture } = await captureStudy(t);
  capture.completeness.status = "incomplete";
  capture.events.dropped = 2;
  const content = JSON.stringify(capture);
  await writeFile(join(dir, "capture.json"), content);
  study.evidence.captures[0].bytes = Buffer.byteLength(content);
  study.evidence.captures[0].sha256 = createHash("sha256")
    .update(content)
    .digest("hex");
  assert.equal((await checkStudyEvidence(study, dir)).status, "unknown");
  await writeFile(join(dir, "capture.json"), Buffer.from([0xff, 0xfe]));
  study.evidence.captures[0].bytes = 2;
  study.evidence.captures[0].sha256 = createHash("sha256")
    .update(Buffer.from([0xff, 0xfe]))
    .digest("hex");
  assert.equal((await checkStudyEvidence(study, dir)).status, "fail");
});

test("a rehashed capture whose own action count exceeds its steps remains unknown", async (t) => {
  const { dir, study, capture } = await captureStudy(t);
  capture.scenario.action_count += 1;
  const content = JSON.stringify(capture);
  await writeFile(join(dir, "capture.json"), content);
  study.evidence.captures[0].bytes = Buffer.byteLength(content);
  study.evidence.captures[0].sha256 = createHash("sha256")
    .update(content)
    .digest("hex");
  assert.equal((await checkStudyEvidence(study, dir)).status, "unknown");
});

test("a capture lacking one of its own actor's declared action steps remains unknown and names only the missing labels", async (t) => {
  const { dir, study } = await captureStudy(t);
  const declared = study.scenarios[0].actions;
  for (const stepId of ["x1", "x2"])
    declared.push({
      stepId,
      actorId: "manager",
      operationId: "invoice.update",
    });
  const result = await checkStudyEvidence(study, dir);
  assert.equal(result.status, "unknown", JSON.stringify(result));
  assert.equal(result.captures[0].status, "unknown");
  assert.deepEqual(result.captures[0].missingActionStepIds, ["x1", "x2"]);
  assert.equal(
    result.captures[0].reason,
    "capture lacks declared action steps",
  );
  // Observation coordinates are still checked independently of the plan.
  assert.equal(result.observations[0].status, "verified");
});

test("rehashed content with missing, wrong-phase, late or wrong-transaction source provenance fails", async (t) => {
  const { dir, study, capture } = await captureStudy(t);
  for (const change of [
    (c, event) => {
      event.source_event_sequence = 99999;
    },
    (c, event) => {
      event.source_event_sequence = c.events.items.find(
        (source) =>
          source.kind === "response" &&
          source.transaction_id === event.transaction_id,
      ).sequence;
    },
    (c, event) => {
      event.source_event_sequence = event.sequence;
    },
    (c, event) => {
      event.source_event_sequence = c.events.items.find(
        (source) =>
          source.kind === "request" &&
          source.transaction_id !== event.transaction_id,
      ).sequence;
    },
  ]) {
    const changed = structuredClone(capture);
    const event = changed.events.items.find(
      (entry) => entry.kind === "network-content" && entry.phase === "request",
    );
    change(changed, event);
    const content = JSON.stringify(changed);
    await writeFile(join(dir, "capture.json"), content);
    study.evidence.captures[0].bytes = Buffer.byteLength(content);
    study.evidence.captures[0].sha256 = createHash("sha256")
      .update(content)
      .digest("hex");
    assert.equal(
      (await checkStudyEvidence(study, dir)).status,
      "fail",
      change.toString(),
    );
  }
});

test("study rejects cross-actor context reuse, duplicate capture paths and invalid evidence references", async (t) => {
  const { study } = await captureStudy(t);
  for (const change of [
    (s) => {
      s.evidence.observations[0].captureId = "absent";
    },
    (s) => {
      s.evidence.captures[0].actorId = "absent";
    },
    (s) => {
      s.evidence.captures[0].scenarioId = "absent";
    },
    (s) => {
      s.evidence.captures[0].file = "../outside.json";
    },
    (s) => {
      s.evidence.captures[0].file = "C:\\outside.json";
    },
    (s) => {
      s.evidence.captures.push({
        ...s.evidence.captures[0],
        captureId: "copy",
      });
    },
    (s) => {
      s.evidence.captures.push({
        ...s.evidence.captures[0],
        captureId: "copy",
        actorId: "clerk",
        file: "clerk.json",
      });
    },
    (s) => {
      s.limits.maxEvidenceBytes = 1;
    },
  ]) {
    const changed = structuredClone(study);
    change(changed);
    assert.equal(
      validateStudyManifest(changed).status,
      "invalid",
      change.toString(),
    );
  }
});

test("bounded strict manifest reader rejects duplicate keys, oversized input, malformed UTF-8 and escaping paths", async (t) => {
  const dir = await stage(t);
  for (const [name, data] of [
    ["duplicate.json", '{"version":1,"version":1}'],
    ["large.json", " ".repeat(1024 * 1024 + 1)],
    ["utf8.json", Buffer.from([0xff])],
  ]) {
    await writeFile(join(dir, name), data);
    assert.equal((await readStudyManifest(dir, name)).status, "invalid");
  }
  await symlink(fileURLToPath(example), join(dir, "escape.json"));
  assert.equal((await readStudyManifest(dir, "escape.json")).status, "invalid");
  assert.equal(
    (await readStudyManifest(dir, "../outside.json")).status,
    "invalid",
  );
});

test("CLI validates without executing actions and makes missing evidence nonzero when explicitly checked", () => {
  const script = fileURLToPath(new URL("./saas-study.mjs", import.meta.url));
  const run = (args) =>
    spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
  const valid = run(["validate", fileURLToPath(example)]);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).status, "valid");
  const unknown = run(["validate", fileURLToPath(example), "--check-evidence"]);
  assert.equal(unknown.status, 2, unknown.stderr);
  assert.equal(JSON.parse(unknown.stdout).evidence.status, "unknown");
  assert.equal(run(["capture", fileURLToPath(example)]).status, 2);
  assert.equal(
    run([
      "validate",
      fileURLToPath(example),
      "--check-evidence",
      "--check-evidence",
    ]).status,
    2,
  );
});

test("CLI exits nonzero when a bound capture lacks a declared action step", async (t) => {
  const { dir, study } = await captureStudy(t);
  const script = fileURLToPath(new URL("./saas-study.mjs", import.meta.url));
  const run = async (manifest) => {
    await writeFile(join(dir, "study.json"), JSON.stringify(manifest));
    return spawnSync(
      process.execPath,
      [script, "validate", join(dir, "study.json"), "--check-evidence"],
      { encoding: "utf8" },
    );
  };
  const verified = await run(study);
  assert.equal(verified.status, 0, verified.stdout);
  assert.equal(JSON.parse(verified.stdout).evidence.status, "verified");
  // The reviewed failure: the original plan labels plus extras none of which were captured.
  const original = await fixture();
  study.scenarios[0].actions = [
    ...original.scenarios[0].actions,
    ...["x1", "x2", "x3"].map((stepId) => ({
      stepId,
      actorId: "manager",
      operationId: "invoice.update",
    })),
  ];
  study.scenarios[0].expectedObservations =
    original.scenarios[0].expectedObservations;
  const missing = await run(study);
  assert.equal(missing.status, 2, missing.stdout);
  const evidence = JSON.parse(missing.stdout).evidence;
  assert.equal(evidence.status, "unknown");
  // clerk-update belongs to the clerk session, not this manager capture.
  assert.deepEqual(evidence.captures[0].missingActionStepIds, [
    "manager-update",
    "x1",
    "x2",
    "x3",
  ]);
});
