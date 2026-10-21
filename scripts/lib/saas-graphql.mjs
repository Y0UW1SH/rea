import { createHash } from "node:crypto";
import { isSafeNumber } from "lossless-json";
import { NumberLexeme } from "./saas-json-schema-inference.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const plain = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Inference preserves raw numbers; APQ version must still be exactly one. */
const versionOne = (version) =>
  version === 1 ||
  (version instanceof NumberLexeme &&
    isSafeNumber(version.lexeme) &&
    Number(version.lexeme) === 1);

/** Recognize an envelope without claiming that its operation identity is usable. */
export const isGraphqlRequest = (request) =>
  plain(request) &&
  (typeof request.query === "string" ||
    (plain(request.extensions) &&
      Object.hasOwn(request.extensions, "persistedQuery")));

/** Retained document identity. Hash the exact text; do not guess semantic equivalence. */
export function graphqlDocumentIdentity(request) {
  if (!plain(request)) return null;
  const query =
    typeof request.query === "string" && request.query.length > 0
      ? request.query
      : null;
  const persisted = request.extensions?.persistedQuery;
  const hash =
    versionOne(persisted?.version) &&
    typeof persisted.sha256Hash === "string" &&
    /^[a-fA-F0-9]{64}$/u.test(persisted.sha256Hash)
      ? persisted.sha256Hash.toLowerCase()
      : null;
  return {
    document_sha256: query === null ? null : digest(query),
    persisted_query_sha256: hash,
  };
}

/** Selection within one HTTP operation: operationName plus document or APQ identity. */
export function graphqlRequestIdentity(request, endpointPath) {
  const identity = graphqlDocumentIdentity(request);
  if (identity === null) return null;
  const name = request.operationName ?? null;
  if (
    name !== null &&
    (typeof name !== "string" || !/^[_A-Za-z][_0-9A-Za-z]*$/u.test(name))
  )
    return null;
  const document = identity.document_sha256 ?? identity.persisted_query_sha256;
  if (
    document === null ||
    (identity.document_sha256 !== null &&
      identity.persisted_query_sha256 !== null &&
      identity.document_sha256 !== identity.persisted_query_sha256)
  )
    return null;
  return {
    key: `sha256:${digest(JSON.stringify([endpointPath, name, document]))}`,
    endpoint_path: endpointPath,
    operation_name: name,
    document_sha256: document,
  };
}
