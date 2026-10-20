import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { admitReport } from "./saas-export-budget.mjs";
import {
  admitTransaction,
  compareCodePoints,
  openapiPath,
  serializeContract,
  sortCodePoints,
  validateContractManifest,
} from "./saas-api-contract-admission.mjs";
import {
  CONTRACT_LIMITATIONS,
  FIXED_UNKNOWNS,
  renderOpenApi,
  statusOrder,
} from "./saas-api-contract-render.mjs";
import {
  assembleTransactions,
  readScenarioCapture,
} from "./saas-scenario-capture.mjs";
import {
  createSchemaAccumulator,
  parseJsonForInference,
} from "./saas-json-schema-inference.mjs";

export { validateContractManifest } from "./saas-api-contract-admission.mjs";
export { verifyContract } from "./saas-api-contract-verify.mjs";

// Infer an OpenAPI 3.1 contract from capture_browser_scenario results. Header values are
// never read and secrets never emitted; everything inferred carries sample counts.

const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const plainObject = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

function parseBody(body, coverage) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body.buffer);
    return parseJsonForInference(text, {
      maxFields: 1024,
      maxArrayLength: 100_000,
      maxValues: 1_000_000,
    });
  } catch {
    coverage.unparseable_bodies += 1;
    return undefined;
  }
}

/** The origin with the most JSON transactions, then most transactions, then lowest code points. */
function selectPrimaryOrigin(records, declared) {
  if (declared) return declared[0];
  const counts = new Map();
  for (const { admission } of records) {
    if (admission.excluded) continue;
    const entry = counts.get(admission.origin) ?? { json: 0, total: 0 };
    entry.total += 1;
    if (admission.json) entry.json += 1;
    counts.set(admission.origin, entry);
  }
  const ranked = [...counts.entries()].sort(
    ([leftOrigin, left], [rightOrigin, right]) =>
      right.json - left.json ||
      right.total - left.total ||
      compareCodePoints(leftOrigin, rightOrigin),
  );
  if (ranked.length === 0 || ranked[0][1].json === 0)
    throw new Error(
      "captures: no admitted JSON transaction names a primary origin",
    );
  return ranked[0][0];
}

const newOperation = (transaction, admission, path) => ({
  method: transaction.method,
  path,
  template: admission.route.template,
  segments: new Map(),
  queryNames: new Set(),
  requestHeaderNames: new Set(),
  responseHeaderNames: new Set(),
  requestSchemas: new Map(),
  requestTruncated: 0,
  responses: new Map(),
  graphql: new Map(),
  samples: 0,
  evidence: [],
  evidenceTruncated: false,
});

function recordRequestLine(operation, record, limits) {
  const { capture, transaction, admission } = record;
  operation.samples += 1;
  if (operation.evidence.length < limits.maxEvidencePerOperation)
    operation.evidence.push({
      capture,
      transaction_id: transaction.transaction_id,
      step_id: transaction.step_id,
      status: transaction.status,
    });
  else operation.evidenceTruncated = true;
  for (const segment of admission.route.segments) {
    const entry = operation.segments.get(segment.segment_index) ?? {
      rule: segment.rule,
      values: new Set(),
    };
    entry.values.add(segment.value);
    operation.segments.set(segment.segment_index, entry);
  }
  for (const name of transaction.url.query_parameter_names ?? [])
    operation.queryNames.add(name);
  for (const name of transaction.header_names)
    operation.requestHeaderNames.add(name);
  for (const { name } of transaction.request.headers ?? [])
    operation.requestHeaderNames.add(name);
  for (const { name } of transaction.response.headers ?? [])
    operation.responseHeaderNames.add(name);
}

function recordBody(side, schemas, coverage, accumulator) {
  if (side.kind === "json") {
    const value = parseBody(side.body, coverage);
    if (value === undefined) return { value: undefined, truncated: false };
    const schema = schemas.get(side.essence) ?? accumulator();
    schema.add(value, { redacted: side.body.redacted });
    schemas.set(side.essence, schema);
    return { value, truncated: false };
  }
  if (side.kind === "truncated") {
    coverage.truncated += 1;
    return { value: undefined, truncated: true };
  }
  return { value: undefined, truncated: false };
}

function recordGraphql(operation, admission, request, response, accumulator) {
  if (!plainObject(request) || typeof request.query !== "string") return;
  const name =
    typeof request.operationName === "string" && request.operationName !== ""
      ? request.operationName
      : `sha256:${sha256(request.query).slice(0, 12)}`;
  const entry = operation.graphql.get(name) ?? {
    samples: 0,
    variables: accumulator(),
    data: accumulator(),
  };
  entry.samples += 1;
  if (Object.hasOwn(request, "variables"))
    entry.variables.add(request.variables, {
      redacted: admission.request.body.redacted,
    });
  if (plainObject(response) && Object.hasOwn(response, "data"))
    entry.data.add(response.data, {
      redacted: admission.response.body.redacted,
    });
  operation.graphql.set(name, entry);
}

function recordTransaction(operation, record, manifest, coverage) {
  const { transaction, admission } = record;
  const accumulator = () =>
    createSchemaAccumulator({ maxSchemaNodes: manifest.limits.maxSchemaNodes });
  recordRequestLine(operation, record, manifest.limits);
  const statusKey =
    transaction.status === null ? "default" : String(transaction.status);
  const response = operation.responses.get(statusKey) ?? {
    count: 0,
    truncated: 0,
    schemas: new Map(),
  };
  response.count += 1;
  operation.responses.set(statusKey, response);
  const request = recordBody(
    admission.request,
    operation.requestSchemas,
    coverage,
    accumulator,
  );
  if (request.truncated) operation.requestTruncated += 1;
  const reply = recordBody(
    admission.response,
    response.schemas,
    coverage,
    accumulator,
  );
  if (reply.truncated) response.truncated += 1;
  if (transaction.method === "POST")
    recordGraphql(
      operation,
      admission,
      request.value,
      reply.value,
      accumulator,
    );
}

function buildModel(records, primary, manifest) {
  const operations = new Map();
  const coverage = {
    transactions: records.length,
    admitted: 0,
    excluded: {},
    truncated: 0,
    unparseable_bodies: 0,
  };
  const exclude = (reason) => {
    coverage.excluded[reason] = (coverage.excluded[reason] ?? 0) + 1;
  };
  for (const record of records) {
    const { transaction, admission } = record;
    if (admission.excluded) {
      exclude(admission.excluded);
      continue;
    }
    if (admission.origin !== primary) {
      exclude("other-origin");
      continue;
    }
    coverage.admitted += 1;
    const path = openapiPath(admission.route, admission.path);
    const key = `${transaction.method}\u0000${path}`;
    let operation = operations.get(key);
    if (operation === undefined) {
      operation = newOperation(transaction, admission, path);
      operations.set(key, operation);
    }
    recordTransaction(operation, record, manifest, coverage);
  }
  coverage.excluded = Object.fromEntries(
    sortCodePoints(Object.keys(coverage.excluded)).map((reason) => [
      reason,
      coverage.excluded[reason],
    ]),
  );
  return {
    operations: [...operations.values()].sort(
      (left, right) =>
        compareCodePoints(left.path, right.path) ||
        compareCodePoints(left.method, right.method),
    ),
    coverage,
  };
}

async function readCaptures(manifest, root, inputs) {
  const records = [];
  for (const [index, { file }] of manifest.captures.entries()) {
    const read = await readScenarioCapture(
      root,
      file,
      manifest.limits.maxBytes,
    );
    const selection = read.capture.scenario.network_content;
    if (!selection.request_body && !selection.response_body)
      throw new Error(
        `${file}: capture retains no network content (request_body and response_body are both false)`,
      );
    const transactions = assembleTransactions(read.capture, {
      maxTransactions: manifest.limits.maxTransactions,
    });
    inputs.push({
      file,
      bytes: read.bytes,
      sha256: read.sha256,
      transactions: transactions.length,
    });
    for (const transaction of transactions)
      records.push({
        capture: index,
        transaction,
        admission: admitTransaction(transaction, {
          resourceTypes: manifest.resource_types,
          maxBodyBytes: manifest.limits.maxBodyBytes,
        }),
      });
  }
  return records;
}

/** Infer the contract for one manifest; `invalid` keeps the inputs read so far. */
export async function inferContract(manifest, root) {
  const inputs = [];
  let normalized;
  try {
    normalized = validateContractManifest(manifest);
    const records = await readCaptures(normalized, root, inputs);
    const primary = selectPrimaryOrigin(records, normalized.origins);
    const model = buildModel(records, primary, normalized);
    const openapi = renderOpenApi(model, normalized, inputs, primary);
    const report = {
      version: 1,
      status: "produced",
      name: normalized.name,
      primary_origin: primary,
      inputs,
      coverage: model.coverage,
      operations: model.operations.map((operation) => ({
        method: operation.method,
        path: operation.path,
        api_surface_template: operation.template,
        samples: operation.samples,
        statuses: [...operation.responses.keys()].sort(statusOrder),
      })),
      unknowns: FIXED_UNKNOWNS,
      resource_types: normalized.resource_types,
      options: normalized.options,
      limits: normalized.limits,
      limitations: CONTRACT_LIMITATIONS,
      openapi_sha256: sha256(serializeContract(openapi)),
    };
    return admitReport({ status: "produced", openapi, report });
  } catch (error) {
    return {
      status: "invalid",
      report: {
        version: 1,
        status: "invalid",
        ...(normalized ? { name: normalized.name } : {}),
        inputs,
        reason:
          error instanceof Error ? error.message : "Contract inference failed",
      },
    };
  }
}

/** Write openapi.json and contract-report.json into a directory that must not exist yet. */
export async function writeContract(directory, result) {
  if (result.status !== "produced")
    throw new Error("writeContract: only a produced contract can be written");
  await mkdir(directory);
  const openapi = join(directory, "openapi.json");
  const report = join(directory, "contract-report.json");
  await writeFile(openapi, serializeContract(result.openapi));
  await writeFile(report, serializeContract(result.report));
  return { openapi, report };
}
