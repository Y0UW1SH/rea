import { expect, it } from "vitest";
import { GoBinaryService } from "./GoBinaryService.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import type { GoBinary } from "../../domain/go/goBinary.js";
import { ok } from "../../domain/result.js";

const identity = {
  id: "fixture-go",
  name: "Source-owned Go reader seam",
  version: "1",
};
const report: GoBinary = {
  artifact: { path: "/artifacts/program", sha256: "a".repeat(64), bytes: 1024 },
  format: "elf",
  architecture: "riscv64",
  bits: 64,
  byte_order: "little",
  build_info: null,
  limitations: ["Build information unavailable."],
};

it("rejects invalid paths and extra caller arguments before invoking the reader", async () => {
  let calls = 0;
  const service = new GoBinaryService({
    identity,
    inspect: () => {
      calls += 1;
      return Promise.resolve(ok(report));
    },
  });
  for (const input of [
    { path: "relative" },
    { path: "/artifacts/\0program" },
    { path: report.artifact.path, execute: true },
  ]) {
    const result = await service.inspect(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisInputError);
  }
  expect(calls).toBe(0);
});

it("preserves unsupported subject architectures and does not duplicate metadata", async () => {
  const service = new GoBinaryService({
    identity,
    inspect: () => Promise.resolve(ok(report)),
  });
  const result = await service.inspect({ path: report.artifact.path });
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value.subject).toMatchObject({
    architecture: null,
    local_path: report.artifact.path,
    digest: { sha256: report.artifact.sha256 },
  });
  expect(result.value.normalized_result).toEqual(report);
  expect(result.value.raw_result).toBeNull();
});

it("refuses reader identity changes and invalid original source ranges", async () => {
  const outside: GoBinary = {
    ...report,
    build_info: {
      header_offset: 1000,
      encoding: "inline",
      go_version: "go1.26.0",
      module_text: "",
      module_bytes_base64: "",
      version_location: { offset: 2000, bytes: 9 },
      module_location: { offset: 0, bytes: 0 },
      module: {
        path: null,
        main: null,
        dependencies: [],
        settings: [],
        unparsed_lines: [],
        complete: true,
      },
    },
  };
  for (const value of [
    { ...report, artifact: { ...report.artifact, path: "/artifacts/other" } },
    outside,
  ]) {
    const result = await new GoBinaryService({
      identity,
      inspect: () => Promise.resolve(ok(value)),
    }).inspect({ path: report.artifact.path });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisOutputError);
  }
});

it("honors cancellation before reading and after a completed observation", async () => {
  const controller = new AbortController();
  let calls = 0;
  const service = new GoBinaryService({
    identity,
    inspect: () => {
      calls += 1;
      controller.abort();
      return Promise.resolve(ok(report));
    },
  });
  const completed = await service.inspect(
    { path: report.artifact.path },
    { signal: controller.signal },
  );
  expect(completed.ok).toBe(false);
  if (!completed.ok)
    expect(completed.error).toBeInstanceOf(AnalysisCancelledError);
  const before = await service.inspect(
    { path: report.artifact.path },
    { signal: controller.signal },
  );
  expect(before.ok).toBe(false);
  if (!before.ok) expect(before.error).toBeInstanceOf(AnalysisCancelledError);
  expect(calls).toBe(1);
});
