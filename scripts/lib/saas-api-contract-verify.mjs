import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { admitReport } from "./saas-export-budget.mjs";
import {
  decodeExportText,
  readBoundedExport,
} from "./saas-export-comparison.mjs";
import {
  originCorrespondence,
  parseOriginPairs,
  sortOriginPairs,
} from "./saas-origin-pairs.mjs";
import { compareCodePoints } from "./saas-ordering.mjs";
import {
  assembleTransactions,
  readScenarioCapture,
} from "./saas-scenario-capture.mjs";
import {
  admitTransaction,
  openapiPath,
} from "./saas-api-contract-admission.mjs";
import { captureCompleteness } from "./saas-api-contract.mjs";

// Validate a replacement's captured bodies against an inferred contract. Findings carry
// schema coordinates (instance path, keyword) and transaction identity, never body values.

export const VERIFY_LIMITATIONS = [
  "Conformance of the captured request and response bodies to the inferred schemas is checked; business equivalence, authorization and ordering are not.",
  "Transactions whose bodies were truncated, empty or absent where the contract recorded a body are matched by request line and status only and counted as unverified bodies.",
  "Origin pairs are directional (contract origin to replacement origin); undeclared origins are excluded, never guessed.",
  "A request line the contract lacks is an unmatched_operation finding only when it carries a JSON body; without body evidence it is counted under excluded.unmatched-without-body.",
  "A pass covers the matched operations only: unexercised_operations lists contract operations the replacement capture never reached, and an incomplete or truncated capture keeps the result unknown.",
];
const CONTRACT_FILE_BYTES = 16 * 1024 * 1024;

function stripExtensions(schema) {
  if (Array.isArray(schema)) return schema.map(stripExtensions);
  if (schema === null || typeof schema !== "object") return schema;
  const stripped = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key.startsWith("x-")) continue;
    stripped[key] =
      key === "properties" && value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value).map(([name, child]) => [
              name,
              stripExtensions(child),
            ]),
          )
        : stripExtensions(value);
  }
  return stripped;
}

function object(value, at) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error(`${at}: expected object`);
}

/** Read a contract the companion wrote; its digest link is checked before parsing. */
async function readContract(directory) {
  const openapiSource = await readBoundedExport(
    directory,
    "openapi.json",
    CONTRACT_FILE_BYTES,
  );
  const reportSource = await readBoundedExport(
    directory,
    "contract-report.json",
    CONTRACT_FILE_BYTES,
  );
  const report = JSON.parse(decodeExportText(reportSource));
  object(report, "contract-report.json");
  if (report.openapi_sha256 !== openapiSource.sha256)
    throw new Error(
      "contract: openapi.json does not match the digest recorded in contract-report.json",
    );
  const openapi = JSON.parse(decodeExportText(openapiSource));
  object(openapi, "openapi.json");
  object(openapi.paths, "openapi.json: paths");
  const settings = openapi["x-rea-contract"];
  object(settings, "openapi.json: x-rea-contract");
  object(settings.limits, "openapi.json: x-rea-contract.limits");
  if (
    !Array.isArray(settings.resource_types) ||
    settings.resource_types.length === 0
  )
    throw new Error(
      "openapi.json: x-rea-contract.resource_types expected nonempty array",
    );
  const origin = openapi.servers?.[0]?.url;
  if (typeof origin !== "string" || origin.length === 0)
    throw new Error("openapi.json: servers[0].url expected");
  for (const key of ["maxBytes", "maxTransactions", "maxBodyBytes"])
    if (!Number.isSafeInteger(settings.limits[key]) || settings.limits[key] < 1)
      throw new Error(
        `openapi.json: x-rea-contract.limits.${key} expected positive integer`,
      );
  return { openapi, origin, settings, sha256: openapiSource.sha256 };
}

const findingOrder = (left, right) =>
  compareCodePoints(left.kind, right.kind) ||
  compareCodePoints(left.path, right.path) ||
  compareCodePoints(left.method, right.method) ||
  compareCodePoints(left.side ?? "", right.side ?? "") ||
  compareCodePoints(left.instance_path ?? "", right.instance_path ?? "") ||
  compareCodePoints(left.keyword ?? "", right.keyword ?? "") ||
  compareCodePoints(left.transaction_id, right.transaction_id);

function createChecker() {
  const ajv = new Ajv2020({
    strict: true,
    strictTypes: false,
    allErrors: true,
  });
  addFormats(ajv);
  const compiled = new Map();
  const state = {
    findings: [],
    excluded: {},
    matched: 0,
    exercised: new Set(),
    verifiedBodies: 0,
    verifiedResponseBodies: 0,
    unverifiedBodies: 0,
  };
  const validatorFor = (schema) => {
    let validator = compiled.get(schema);
    if (validator === undefined) {
      validator = ajv.compile(stripExtensions(schema));
      compiled.set(schema, validator);
    }
    return validator;
  };
  const validateJson = (side, schema, where) => {
    let value;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(side.body.buffer),
      );
    } catch {
      state.findings.push({
        ...where,
        kind: "structural",
        keyword: "json",
        instance_path: "",
        message: "body is not valid UTF-8 JSON",
      });
      return;
    }
    state.verifiedBodies += 1;
    if (where.side === "response") state.verifiedResponseBodies += 1;
    const validator = validatorFor(schema);
    if (validator(value)) return;
    for (const error of validator.errors ?? [])
      state.findings.push({
        ...where,
        kind: error.keyword === "required" ? "presence" : "structural",
        keyword: error.keyword,
        instance_path: error.instancePath,
        message: error.message ?? error.keyword,
      });
  };
  /** `content` is the contract's media-type map for this side and status, if any. */
  const checkBody = (side, content, where) => {
    const expected = content !== undefined && content !== null;
    if (side.kind === "json") {
      const schema = content?.[side.essence]?.schema;
      if (schema !== undefined) validateJson(side, schema, where);
      else if (expected)
        state.findings.push({
          ...where,
          kind: "structural",
          keyword: "mediaType",
          instance_path: "",
          message: `body media type ${side.essence} is not among the contract media types ${Object.keys(content).join(", ")}`,
        });
      else state.unverifiedBodies += 1;
      return;
    }
    if (side.kind === "non-json") {
      if (expected)
        state.findings.push({
          ...where,
          kind: "structural",
          keyword: "mediaType",
          instance_path: "",
          message: `body media type ${side.essence ?? "unknown"} where the contract recorded JSON (${Object.keys(content).join(", ")})`,
        });
      return;
    }
    if (expected) state.unverifiedBodies += 1;
  };
  return { state, checkBody };
}

function verifyTransaction(transaction, loaded, token, target, checker) {
  const { state, checkBody } = checker;
  const admission = admitTransaction(transaction, {
    resourceTypes: loaded.settings.resource_types,
    maxBodyBytes: loaded.settings.limits.maxBodyBytes,
  });
  const exclude = (reason) => {
    state.excluded[reason] = (state.excluded[reason] ?? 0) + 1;
  };
  if (admission.excluded) {
    exclude(admission.excluded);
    return;
  }
  if (token(admission.origin, "after") !== target) {
    exclude("other-origin");
    return;
  }
  const path = openapiPath(admission.route, admission.path);
  const where = {
    method: transaction.method,
    path,
    status: transaction.status,
    transaction_id: transaction.transaction_id,
    step_id: transaction.step_id,
  };
  const operation =
    loaded.openapi.paths[path]?.[transaction.method.toLowerCase()];
  if (operation === null || typeof operation !== "object") {
    // Extra JSON traffic is a finding. Without JSON evidence the request line alone
    // cannot distinguish an asset from an API call, so it is counted, not judged.
    if (admission.json)
      state.findings.push({ ...where, kind: "unmatched_operation" });
    else
      exclude(admission.nonJson ? "non-json-body" : "unmatched-without-body");
    return;
  }
  state.matched += 1;
  state.exercised.add(`${transaction.method}\u0000${path}`);
  checkBody(admission.request, operation.requestBody?.content, {
    ...where,
    side: "request",
  });
  if (transaction.status === null) {
    state.findings.push({
      ...where,
      kind: "failed_request",
      message: transaction.failure ?? "request unfinished",
    });
    return;
  }
  const response = operation.responses?.[String(transaction.status)];
  if (response === undefined) {
    state.findings.push({ ...where, kind: "unobserved_status" });
    return;
  }
  checkBody(admission.response, response.content, {
    ...where,
    side: "response",
  });
}

const unexercisedOperations = (openapi, exercised) =>
  Object.entries(openapi.paths)
    .flatMap(([path, item]) =>
      Object.keys(item ?? {}).map((method) => ({
        method: method.toUpperCase(),
        path,
      })),
    )
    .filter(({ method, path }) => !exercised.has(`${method}\u0000${path}`))
    .sort(
      (left, right) =>
        compareCodePoints(left.path, right.path) ||
        compareCodePoints(left.method, right.method),
    );

/** Verify one replacement capture against a written contract directory. */
export async function verifyContract(
  contractDirectory,
  captureRoot,
  captureFile,
  { originPairs = [] } = {},
) {
  let contract = null;
  let capture = null;
  try {
    const pairs = sortOriginPairs(
      parseOriginPairs(originPairs, "origin_pairs"),
    );
    const loaded = await readContract(contractDirectory);
    contract = { openapi_sha256: loaded.sha256, origin: loaded.origin };
    const read = await readScenarioCapture(
      captureRoot,
      captureFile,
      loaded.settings.limits.maxBytes,
    );
    const completeness = captureCompleteness(read.capture);
    capture = {
      file: captureFile,
      bytes: read.bytes,
      sha256: read.sha256,
      completeness,
    };
    const transactions = assembleTransactions(read.capture, {
      maxTransactions: loaded.settings.limits.maxTransactions,
    });
    const { token } = originCorrespondence(pairs);
    const target = token(loaded.origin, "before");
    const checker = createChecker();
    for (const transaction of transactions)
      verifyTransaction(transaction, loaded, token, target, checker);
    const { state } = checker;
    state.findings.sort(findingOrder);
    const complete =
      completeness.status === "complete" && completeness.dropped === 0;
    const status =
      state.findings.length > 0
        ? "fail"
        : state.matched === 0 || state.verifiedResponseBodies === 0 || !complete
          ? "unknown"
          : "pass";
    return admitReport({
      version: 1,
      status,
      contract,
      capture,
      origin_pairs: pairs,
      transactions: transactions.length,
      matched: state.matched,
      excluded: Object.fromEntries(
        Object.keys(state.excluded)
          .sort(compareCodePoints)
          .map((reason) => [reason, state.excluded[reason]]),
      ),
      verified_bodies: state.verifiedBodies,
      verified_response_bodies: state.verifiedResponseBodies,
      unverified_bodies: state.unverifiedBodies,
      unexercised_operations: unexercisedOperations(
        loaded.openapi,
        state.exercised,
      ),
      findings: state.findings,
      limitations: VERIFY_LIMITATIONS,
    });
  } catch (error) {
    return {
      version: 1,
      status: "invalid",
      ...(contract === null ? {} : { contract }),
      ...(capture === null ? {} : { capture }),
      reason:
        error instanceof Error ? error.message : "Contract verification failed",
    };
  }
}
