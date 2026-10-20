import { sortCodePoints } from "./saas-ordering.mjs";

// Render the inferred model as OpenAPI 3.1. Every statement beyond observed request
// lines is marked inferred and cites the transactions it came from.

/** Quoted from src/domain/browserNetworkEvidence.ts so reports carry the same caveat. */
export const PLAYWRIGHT_RESPONSE_BODY_PROVENANCE_LIMITATION =
  "Captured response-body bytes are the result of Playwright's Response.body() API. Playwright may satisfy that API with a credentialed follow-up load of the request URL when CDP has no body, so transaction and event links do not verify that retained bytes came from the original network transaction.";
export const CONTRACT_LIMITATIONS = [
  PLAYWRIGHT_RESPONSE_BODY_PROVENANCE_LIMITATION,
  "Required properties, formats and enum candidates reflect the observed samples only; absent samples prove nothing, and enum candidates are observed literal values offered as candidates, never emitted as enum.",
  "Only the four exact api-surface segment formats (numeric, uuid, hex, iso-date) are templated; the opt-in manifest rules (after-uid-literal, opaque-token, sibling-variance) are not applied.",
  "Bodies above the capture's retained size limit or the manifest maxBodyBytes contribute no schema and are counted as truncated; non-JSON bodies (including protobuf, gRPC-web and binary tRPC) exclude their transaction; pagination envelopes are not modeled.",
  "GraphQL is grouped only for POST bodies whose JSON has a string query, by operationName or a query digest; batched operation arrays and GraphQL over GET are not grouped, and tRPC or protobuf bodies are not decoded.",
  "Failed and unfinished requests are counted per operation under x-rea-failures and never modeled as responses; integer versus number follows the original JSON lexeme, not the producer's declared type; header names are recorded but header values are never read.",
  "One primary origin per contract; declare secondary API or WebSocket origins in separate runs. Redaction covers declared secrets and credential header families only, so keep contracts inferred from real captures private.",
];
export const FIXED_UNKNOWNS = [
  "authorization-model",
  "response-semantics",
  "state-transition",
];
const PARAMETER_PATTERNS = {
  numeric: "^[0-9]+$",
  uuid: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
  hex: "^[0-9a-fA-F]{32,}$",
  "iso-date": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$",
};

/** Numeric statuses ascending. */
export const statusOrder = (left, right) => Number(left) - Number(right);
const contentOf = (schemas, options) =>
  Object.fromEntries(
    sortCodePoints(schemas.keys()).map((essence) => [
      essence,
      { schema: schemas.get(essence).finish(options) },
    ]),
  );

function renderParameters(operation) {
  return [
    ...[...operation.segments.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, { rule, values }]) => ({
        name: `${rule}_${index}`,
        in: "path",
        required: true,
        schema: { type: "string", pattern: PARAMETER_PATTERNS[rule] },
        "x-rea-rule": rule,
        "x-rea-distinct-values": values.size,
      })),
    ...sortCodePoints(operation.queryNames).map((name) => ({
      name,
      in: "query",
      required: false,
      schema: {},
      "x-rea-basis": "observed-name",
    })),
  ];
}

function renderResponses(operation, options) {
  const statuses = [...operation.responses.keys()].sort(statusOrder);
  return Object.fromEntries(
    statuses.map((status) => {
      const entry = operation.responses.get(status);
      return [
        status,
        {
          description: `Observed ${entry.count} time(s)`,
          "x-rea-samples": entry.count,
          ...(entry.schemas.size > 0
            ? { content: contentOf(entry.schemas, options) }
            : {}),
          ...(entry.truncated > 0
            ? { "x-rea-body-truncated": entry.truncated }
            : {}),
          ...(entry.empty > 0 ? { "x-rea-empty-bodies": entry.empty } : {}),
        },
      ];
    }),
  );
}

function renderGraphql(operation, options) {
  return Object.fromEntries(
    sortCodePoints(operation.graphql.keys()).map((name) => {
      const entry = operation.graphql.get(name);
      return [
        name,
        {
          samples: entry.samples,
          ...(entry.variables.samples > 0
            ? { variables: entry.variables.finish(options) }
            : {}),
          ...(entry.data.samples > 0
            ? { data: entry.data.finish(options) }
            : {}),
        },
      ];
    }),
  );
}

function renderEvidence(operation, inputs) {
  return {
    samples: operation.samples,
    captures: [...operation.captureIndices]
      .sort((left, right) => left - right)
      .map((index) => ({
        file: inputs[index].file,
        sha256: inputs[index].sha256,
      })),
    transactions: operation.evidence,
    evidence_truncated: operation.evidenceTruncated,
  };
}

function renderOperation(operation, manifest, inputs) {
  const { options } = manifest;
  const statuses = [...operation.responses.keys()];
  const errorObserved = statuses.some((status) => Number(status) >= 400);
  return {
    "x-rea-api-surface-template": operation.template,
    parameters: renderParameters(operation),
    ...(operation.requestSchemas.size > 0
      ? {
          requestBody: {
            content: contentOf(operation.requestSchemas, options),
          },
        }
      : {}),
    ...(operation.requestTruncated > 0
      ? { "x-rea-request-body-truncated": operation.requestTruncated }
      : {}),
    responses: renderResponses(operation, options),
    ...(operation.failures > 0
      ? {
          "x-rea-failures": {
            count: operation.failures,
            reasons: sortCodePoints(operation.failureReasons),
          },
        }
      : {}),
    "x-rea-request-header-names": sortCodePoints(operation.requestHeaderNames),
    "x-rea-response-header-names": sortCodePoints(
      operation.responseHeaderNames,
    ),
    ...(operation.graphql.size > 0
      ? { "x-rea-graphql-operations": renderGraphql(operation, options) }
      : {}),
    "x-rea-evidence": renderEvidence(operation, inputs),
    "x-rea-unknowns": [
      ...FIXED_UNKNOWNS,
      ...(errorObserved ? [] : ["error-responses-unobserved"]),
    ],
  };
}

/** The complete OpenAPI document for one inferred model. */
export function renderOpenApi(model, manifest, inputs, primary, limitations) {
  const paths = {};
  for (const operation of model.operations) {
    paths[operation.path] ??= {};
    paths[operation.path][operation.method.toLowerCase()] = renderOperation(
      operation,
      manifest,
      inputs,
    );
  }
  return {
    openapi: "3.1.0",
    info: {
      title: manifest.name,
      version: "0.0.0-inferred",
      description:
        "Inferred from REA browser scenario captures; every statement beyond the observed request lines is marked inferred with its evidence.",
    },
    jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
    servers: [{ url: primary }],
    paths,
    "x-rea-contract": {
      version: 1,
      generator: "scripts/saas-api-contract.mjs",
      captures: inputs.map(({ file, sha256, completeness }) => ({
        file,
        sha256,
        completeness,
      })),
      resource_types: manifest.resource_types,
      options: manifest.options,
      limits: manifest.limits,
      unknowns: FIXED_UNKNOWNS,
      limitations,
    },
  };
}
