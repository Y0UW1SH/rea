import { describe, expect, it } from "vitest";
import {
  analysisViewCaptureEvidence,
  environmentManifestCaptureFixture,
} from "../../../tests/fixtures/analysisView.js";
import { environmentServeSource } from "../../../tests/fixtures/environmentServe.js";
import { inspectAnalysisView } from "../analysisView/AnalysisViewService.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { replayEnvironmentTool } from "./environmentReplay.js";

const entry = (body: string | undefined, reply: string, query = "") => ({
  request: {
    method: "POST",
    url: `https://app.test/graphql${query}`,
    ...(body === undefined
      ? {}
      : { postData: { mimeType: "application/json", text: body } }),
  },
  response: {
    status: 200,
    content: { mimeType: "application/json", text: reply },
  },
});
const sourceFor = (entries: JsonValue[]) => {
  const capture = analysisViewCaptureEvidence(
    environmentManifestCaptureFixture(entries),
  );
  const manifest = inspectAnalysisView({
    source: { kind: "inline", evidence: capture },
    view: { kind: "environment-manifest" },
  });
  if (!manifest.ok) throw manifest.error;
  return environmentServeSource({ manifest: manifest.value, capture });
};
const call = (
  entries: JsonValue[],
  args: Record<string, unknown>,
  mode: "archive" | "strict" = "strict",
) => {
  const source = sourceFor(entries);
  const tool = source.manifest.tools[0];
  if (tool === undefined) throw new Error("Missing fixture tool");
  return replayEnvironmentTool(source, tool, args, mode);
};
const query = (first: number) => ({
  operationName: "ListCustomers",
  query: "query ListCustomers($first: Int) { customers(first: $first) { id } }",
  variables: { first },
});

describe("strict environment replay", () => {
  it("refuses bodies with unknown media type and responses beyond the replay bound", () => {
    const recorded = entry(JSON.stringify(query(1)), "{}");
    const unknownMime = {
      ...recorded,
      request: {
        ...recorded.request,
        postData: { mimeType: "", text: JSON.stringify(query(1)) },
      },
    };
    expect(call([unknownMime], { body: query(1) }).ok).toBe(false);
    expect(
      call([entry(JSON.stringify(query(1)), "x".repeat(256 * 1024 + 1))], {
        body: query(1),
      }).ok,
    ).toBe(false);
  });

  it("keeps query/body aliases distinct", () => {
    expect(
      call([entry(JSON.stringify(query(1)), "{}", "?body=workspace")], {
        body: "workspace",
        request_body: query(1),
      }).ok,
    ).toBe(true);
  });
  it("selects GraphQL responses by the complete request object, including variables", () => {
    const entries = [
      entry(JSON.stringify(query(1)), '{"data":{"id":1}}'),
      entry(JSON.stringify(query(2)), '{"data":{"id":2}}'),
    ];
    const result = call(entries, {
      body: {
        variables: { first: 2 },
        query: query(2).query,
        operationName: "ListCustomers",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw result.error;
    expect(result.value).toMatchObject({
      body: { data: { id: 2 } },
      replay: {
        record_ordinal: 1,
        mode: "strict",
        match_scope: "path-query-json-body",
      },
    });
    const missing = call(entries, { body: query(3) });
    expect(missing.ok).toBe(false);
    if (missing.ok) throw new Error("Unexpected match");
    expect(projectAnalysisError(missing.error).message).toMatch(
      /unmodeled request/iu,
    );
    const archive = call(entries, { body: query(3) }, "archive");
    expect(archive.ok && archive.value.replay.record_ordinal).toBe(0);
  });

  it("refuses missing request evidence, missing body arguments and conflicting recorded responses", () => {
    expect(call([entry(undefined, "{}")], {}).ok).toBe(false);
    expect(call([entry(JSON.stringify(query(1)), "{}")], {}).ok).toBe(false);
    expect(
      call(
        [
          entry(JSON.stringify(query(1)), '{"a":1}'),
          entry(JSON.stringify(query(1)), '{"a":2}'),
        ],
        { body: query(1) },
      ).ok,
    ).toBe(false);
    expect(
      call(
        [
          entry(JSON.stringify(query(1)), '{"a":1}'),
          entry(JSON.stringify(query(1)), '{"a":1}'),
        ],
        { body: query(1) },
      ).ok,
    ).toBe(true);
  });

  it("requires the full recorded query and rejects duplicate query values the tool cannot express", () => {
    const recorded = entry(JSON.stringify(query(1)), "{}", "?workspace=a");
    expect(call([recorded], { body: query(1) }).ok).toBe(false);
    expect(call([recorded], { body: query(1), workspace: "b" }).ok).toBe(false);
    expect(call([recorded], { body: query(1), workspace: "a" }).ok).toBe(true);
    expect(
      call(
        [entry(JSON.stringify(query(1)), "{}", "?workspace=a&workspace=a")],
        { body: query(1), workspace: "a" },
      ).ok,
    ).toBe(false);
  });

  it("does not collapse unrepresentable request numbers or reinterpret absent bodies as empty objects", () => {
    expect(
      call([entry('{"id":9007199254740993}', "{}")], {
        body: { id: 9007199254740992 },
      }).ok,
    ).toBe(false);
    const empty = entry(undefined, "{}");
    const knownEmpty = { ...empty, request: { ...empty.request, bodySize: 0 } };
    expect(call([knownEmpty], {}).ok).toBe(true);
    expect(call([knownEmpty], { body: {} }).ok).toBe(false);
  });
});
