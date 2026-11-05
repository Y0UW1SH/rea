import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { evaluateCompatibility } from "./saas-compatibility.mjs";
import {
  referenceApp,
  replacementApp,
  readReference,
  readReplacement,
} from "./saas-compatibility-lab-apps.mjs";

const appRevision = `sha256:${createHash("sha256")
  .update(
    readFileSync(new URL("./saas-compatibility-lab-apps.mjs", import.meta.url)),
  )
  .digest("hex")}`;

const mutations = [
  "none",
  "wrong_amount",
  "wrong_relationship",
  "no_persistence",
  "duplicate_retry",
];
function inputs(workflow, supplied) {
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied))
    throw new Error("input must be an object");
  const defaults =
    workflow === "accounting"
      ? { customer: "Synthetic Customer A", total: 10000, payment: 4000 }
      : {
          product: "Synthetic Widget A",
          stock: 10,
          quantity: 3,
          returned: 1,
          unitPrice: 1200,
        };
  if (Object.keys(supplied).some((k) => !Object.hasOwn(defaults, k)))
    throw new Error("unsupported input field");
  const value = { ...defaults, ...supplied };
  for (const [key, v] of Object.entries(value)) {
    if (["customer", "product"].includes(key)) {
      if (typeof v !== "string" || !v.trim() || v.length > 200)
        throw new Error("label must contain 1–200 characters");
    } else if (!Number.isSafeInteger(v) || v <= 0)
      throw new Error(`${key} must be a positive safe integer`);
  }
  validateBounds(workflow, value);
  return value;
}
function validateBounds(workflow, value) {
  if (
    workflow === "accounting" &&
    (value.payment > value.total ||
      !Number.isSafeInteger(value.payment * 2 + 2))
  )
    throw new Error("invalid payment bounds");
  if (
    workflow === "retail" &&
    (value.returned > value.quantity ||
      value.quantity > value.stock ||
      !Number.isSafeInteger(value.stock + value.returned * 2) ||
      !Number.isSafeInteger(value.quantity * value.unitPrice + 2) ||
      !Number.isSafeInteger(value.returned * value.unitPrice * 2 + 2))
  )
    throw new Error("invalid retail bounds");
}
const entity = (type, id) => ({ $entity: { type, id } });
function captureRun({
  id,
  side,
  workflow,
  observed,
  elapsedMs,
  ref,
  partyType,
  documentType,
}) {
  const { party, document, effectDocuments, ...values } = observed.state;
  return {
    runId: `${id}-${side}`,
    workspace: `synthetic-${side}`,
    collectedAt: new Date().toISOString(),
    revision: appRevision,
    context: {
      workflow: { provenance: "caller_declared", value: workflow },
      currency: { provenance: "caller_declared", value: "CAD-minor-units" },
    },
    observations: [
      {
        name: "saved-state",
        kind: "persisted_read",
        elapsedMs,
        value: {
          ...values,
          party: entity(partyType, party),
          document: entity(documentType, document),
          effectDocuments: effectDocuments.map((d) => entity(documentType, d)),
        },
        evidence: [ref],
      },
    ],
    windows: [
      {
        observation: "saved-state",
        coverage: "complete",
        observedUntilMs: elapsedMs,
        evidence: [ref],
      },
    ],
  };
}
export function runLabCase({
  workflow = "accounting",
  mutation = "none",
  input = {},
} = {}) {
  if (!["accounting", "retail"].includes(workflow))
    throw new Error("unsupported workflow");
  if (!mutations.includes(mutation)) throw new Error("unsupported mutation");
  const selected = inputs(workflow, input);
  const id = randomUUID();
  const directory = mkdtempSync(join(tmpdir(), "rea-saas-lab-"));
  const partyType = workflow === "accounting" ? "customer" : "product";
  const documentType = workflow === "accounting" ? "invoice" : "sale";
  const evidence = {};
  const executions = {};
  const runs = {};
  try {
    for (const side of ["reference", "replacement"]) {
      const path = join(directory, `${side}.json`);
      const start = performance.now();
      executions[side] =
        side === "reference"
          ? referenceApp(path, workflow, selected)
          : replacementApp(path, workflow, selected, mutation);
      const observed =
        side === "reference"
          ? readReference(path, workflow)
          : readReplacement(path, workflow);
      const elapsedMs = Math.max(1, Math.ceil(performance.now() - start));
      const ref = `lab:${id}:${side}:reopened-state`;
      evidence[ref] = {
        source: "synthetic-local-file-reopened",
        input: selected,
        receipts: executions[side].receipts,
        bindings: executions[side].ids,
        persisted: observed.raw,
      };
      runs[side] = captureRun({
        id,
        side,
        workflow,
        observed,
        elapsedMs,
        ref,
        partyType,
        documentType,
      });
    }
    const testCase = {
      version: 1,
      caseId: `synthetic-${workflow}-${mutation}-${id}`,
      scope: `Synthetic ${workflow} operation followed by identical request retry and reopened persisted read.`,
      unsupported: [
        "Live vendor behavior",
        "Browser capture",
        "Permissions and concurrency",
        "Process crash durability",
        "External services",
      ],
      contextKeys: ["workflow", "currency"],
      ...runs,
      entities: ["party", "other", "document"].map((name) => ({
        type: name === "document" ? documentType : partyType,
        logicalId: name,
        ...Object.fromEntries(
          ["reference", "replacement"].map((side) => [
            side,
            {
              runId: runs[side].runId,
              workspace: runs[side].workspace,
              id: executions[side].ids[name],
            },
          ]),
        ),
        evidence: Object.keys(evidence),
      })),
      checks: [
        {
          name: "saved business outcome and retry effects",
          observation: "saved-state",
          persisted: true,
          deadlineMs: 10000,
        },
      ],
    };
    return {
      workflow,
      mutation,
      input: selected,
      case: testCase,
      report: evaluateCompatibility(testCase),
      evidence,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
export function runLab() {
  const results = ["accounting", "retail"].flatMap((workflow) =>
    mutations.map((mutation) => runLabCase({ workflow, mutation })),
  );
  results.push(
    runLabCase({
      workflow: "accounting",
      input: { customer: "Synthetic Customer Z", total: 19317, payment: 6419 },
    }),
  );
  results.push(
    runLabCase({
      workflow: "retail",
      input: {
        product: "Synthetic Widget Z",
        stock: 19,
        quantity: 7,
        returned: 3,
        unitPrice: 217,
      },
    }),
  );
  return {
    version: 1,
    kind: "synthetic-workflow-lab",
    status: results.every(
      (r) => r.report.status === (r.mutation === "none" ? "pass" : "fail"),
    )
      ? "pass"
      : "fail",
    limitations: [
      "These are synthetic test applications, not vendor implementations or verified SaaS replacements.",
      "Only single-document, sequential workflows and same-process retries are exercised; no crash/restart or concurrency guarantees are established.",
      "Temporary files are removed and their reopened snapshots retained inline.",
    ],
    results,
  };
}
