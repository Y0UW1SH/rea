import { writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { GoBinaryProvider } from "../../../src/go/GoBinaryProvider.js";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../../src/domain/analysisErrorCore.js";
import { createGoBinaryFixture } from "../../fixtures/go/image.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("preserves the actual build-info byte guard as a resource failure", async () => {
  const fixture = createGoBinaryFixture();
  fixture.bytes.set([0x81, 0x80, 0x40], fixture.headerOffset + 32);
  const root = await createTestTempDirectory("rea-go-resource-");
  const path = join(root, "oversized-metadata.elf");
  await writeFile(path, fixture.bytes);
  const result = await new GoBinaryProvider().inspect({ path });
  expect(result.ok).toBe(false);
  if (result.ok)
    throw new Error("Oversized embedded metadata must not succeed");
  expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
  if (!(result.error instanceof AnalysisResourceConstraintError))
    throw result.error;
  expect(result.error.reason).toContain(path);
  expect(result.error.reportedLimits).toEqual({
    boundary: "build-info",
    maximum_bytes: 1024 * 1024,
  });
});

it.skipIf(process.platform === "win32")(
  "rejects a symlink without replacing its selected file identity",
  async () => {
    const root = await createTestTempDirectory("rea-go-symlink-");
    const selected = join(root, "selected");
    const original = join(root, "original.elf");
    await writeFile(original, createGoBinaryFixture().bytes);
    await symlink(original, selected);
    const result = await new GoBinaryProvider().inspect({ path: selected });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisInputError);
  },
);
