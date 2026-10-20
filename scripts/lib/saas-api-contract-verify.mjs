import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { admitReport } from "./saas-export-budget.mjs";
import {
  decodeExportText,
  parseExportJson,
  readBoundedExport,
} from "./saas-export-comparison.mjs";
import {
  originCorrespondence,
  parseOriginPairs,
  sortOriginPairs,
} from "./saas-origin-pairs.mjs";
import {
  assembleTransactions,
  readScenarioCapture,
} from "./saas-scenario-capture.mjs";
import {
  admitTransaction,
  compareCodePoints,
  openapiPath,
} from "./saas-api-contract-admission.mjs";

// Validate a replacement's captured bodies against an inferred contract. Findings carry
// schema coordinates (instance path, keyword) and transaction identity, never body values.

export const VERIFY_LIMITATIONS = [
  "Conformance of the captured request and response bodies to the inferred schemas is checked; business equivalence, authorization and ordering are not.",
  "Transactions whose bodies were truncated or absent are matched by request line and status only and counted as unverified bodies.",
  "Origin pairs are directional (contract origin to replacement origin); undeclared origins are excluded, never guessed.",
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
  const parse = (source) =>
    parseExportJson(decodeExportText(source), 100_000, 1_000_000, 10_000_000);
  const report = parse(reportSource);
  object(report, "contract-report.json");
  if (report.openapi_sha256 !== openapiSource.sha256)
    throw new Error(
      "contract: openapi.json does not match the digest recorded in contract-report.json",
    );
  const openapi = parse(openapiSource);
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
    verifiedBodies: 0,
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
  const checkBody = (side, content, where) => {
    if (side.kind === "truncated") {
      state.unverifiedBodies += 1;
      return;
    }
    if (side.kind !== "json") return;
    const schema = content?.[side.essence]?.schema;
    if (schema === undefined) {
      state.unverifiedBodies += 1;
      return;
    }
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
  return { state, checkBody };
}

function verifyTransaction(transaction, loaded, token, target, checker) {
  const { state, checkBody } = checker;
  const admission = admitTransaction(transaction, {
    resourceTypes: loaded.settings.resource_types,
    maxBodyBytes: loaded.settings.limits.maxBodyBytes,
  });
  const reason = admission.excluded
    ? admission.excluded
    : token(admission.origin, "after") !== target
      ? "other-origin"
      : null;
  if (reason !== null) {
    state.excluded[reason] = (state.excluded[reason] ?? 0) + 1;
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
    state.findings.push({ ...where, kind: "unmatched_operation" });
    return;
  }
  state.matched += 1;
  const statusKey =
    transaction.status === null ? "default" : String(transaction.status);
  const response = operation.responses?.[statusKey];
  if (transaction.status !== null && response === undefined)
    state.findings.push({ ...where, kind: "unobserved_status" });
  checkBody(admission.request, operation.requestBody?.content, {
    ...where,
    side: "request",
  });
  checkBody(admission.response, response?.content, {
    ...where,
    side: "response",
  });
}

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
    capture = { file: captureFile, bytes: read.bytes, sha256: read.sha256 };
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
    const status =
      state.findings.length > 0
        ? "fail"
        : state.matched === 0 || state.verifiedBodies === 0
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
      unverified_bodies: state.unverifiedBodies,
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
