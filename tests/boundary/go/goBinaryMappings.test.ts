import { expect, it } from "vitest";
import { mappedFileOffset } from "../../../src/go/GoBinaryContainer.js";

const selected = { address: 100n, offset: 16, size: 64 };

it.each([
  { address: 132n, offset: 4, size: 4 },
  { address: 112n, offset: 4, size: 12 },
])(
  "rejects a contradictory alias overlapping only part of the selected bytes",
  (alias) => {
    expect(() => mappedFileOffset([selected, alias], 120n, 24)).toThrowError(
      /ambiguous/i,
    );
  },
);

it("accepts overlapping aliases that identify exactly the same file bytes", () => {
  expect(
    mappedFileOffset(
      [selected, { address: 132n, offset: 48, size: 4 }],
      120n,
      24,
    ),
  ).toBe(36);
});

it("does not confuse adjacent mappings with overlapping byte spans", () => {
  const adjacent = { address: 164n, offset: 80, size: 32 };
  expect(mappedFileOffset([selected, adjacent], 140n, 24)).toBe(56);
  expect(mappedFileOffset([selected, adjacent], 164n, 0)).toBe(80);
});
