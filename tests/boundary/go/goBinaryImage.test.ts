import { expect, it } from "vitest";
import { readGoBinaryImage } from "../../../src/go/GoBinaryImage.js";
import {
  createGoBinaryFixture,
  GO_MODULE_TEXT,
} from "../../fixtures/go/image.js";

it.each([
  ["elf", 32, "little"],
  ["elf", 32, "big"],
  ["elf", 64, "little"],
  ["elf", 64, "big"],
  ["pe", 32, "little"],
  ["pe", 64, "little"],
  ["macho", 32, "little"],
  ["macho", 32, "big"],
  ["macho", 64, "little"],
  ["macho", 64, "big"],
] as const)(
  "reads %s %d-bit %s inline build metadata",
  (format, bits, byteOrder) => {
    const fixture = createGoBinaryFixture({ format, bits, byteOrder });
    expect(readGoBinaryImage(fixture.bytes)).toMatchObject({
      format,
      bits,
      byte_order: byteOrder,
      build_info: {
        header_offset: fixture.headerOffset,
        encoding: "inline",
        go_version: "go1.26.0",
        module_text: GO_MODULE_TEXT,
        module_bytes_base64: fixture.moduleBytes.toString("base64"),
        version_location: { offset: fixture.versionOffset, bytes: 8 },
        module_location: {
          offset: fixture.moduleOffset,
          bytes: fixture.moduleBytes.length,
        },
      },
    });
  },
);

it.each(["elf", "pe", "macho"] as const)(
  "follows mapped pointers in legacy %s metadata",
  (format) => {
    const fixture = createGoBinaryFixture({
      format,
      encoding: "pointer",
      goVersion: "go1.17",
    });
    expect(readGoBinaryImage(fixture.bytes).build_info).toMatchObject({
      encoding: "pointer",
      go_version: "go1.17",
      module_text: GO_MODULE_TEXT,
      version_location: { offset: fixture.versionOffset, bytes: 6 },
    });
  },
);

it.each(["elf", "macho"] as const)(
  "finds sectionless %s metadata in its writable data mapping",
  (format) => {
    const fixture = createGoBinaryFixture({ format, sectionless: true });
    expect(readGoBinaryImage(fixture.bytes).build_info?.go_version).toBe(
      "go1.26.0",
    );
  },
);

it("does not treat a code/overlay decoy or unaligned marker as Go metadata", () => {
  const absent = createGoBinaryFixture({ omitBuildInfo: true });
  const decoy = createGoBinaryFixture();
  decoy.bytes
    .subarray(decoy.headerOffset, decoy.headerOffset + 512)
    .copy(absent.bytes, 3072);
  expect(readGoBinaryImage(absent.bytes).build_info).toBeNull();
  const unaligned = createGoBinaryFixture({
    sectionless: true,
    omitBuildInfo: true,
  });
  decoy.bytes
    .subarray(decoy.headerOffset, decoy.headerOffset + 512)
    .copy(unaligned.bytes, 1025);
  expect(readGoBinaryImage(unaligned.bytes).build_info).toBeNull();
});

it("refuses mapped pointer lengths outside the file instead of rounding 64-bit addresses", () => {
  const fixture = createGoBinaryFixture({ encoding: "pointer" });
  fixture.bytes.writeBigUInt64LE(0x20000000000001n, 1536);
  expect(() => readGoBinaryImage(fixture.bytes)).toThrowError(
    /mapped|address/i,
  );
  const length = createGoBinaryFixture({ encoding: "pointer" });
  length.bytes.writeBigUInt64LE(0xffffffffffffffffn, 1544);
  expect(() => readGoBinaryImage(length.bytes)).toThrowError(/limit|length/i);
});

it("refuses overlong or truncated varints before decoding or allocating strings", () => {
  const fixture = createGoBinaryFixture();
  fixture.bytes.fill(
    0xff,
    fixture.headerOffset + 32,
    fixture.headerOffset + 42,
  );
  expect(() => readGoBinaryImage(fixture.bytes)).toThrowError(/varint/i);
  const truncated = createGoBinaryFixture();
  truncated.bytes.writeBigUInt64LE(33n, 256 + 64 * 2 + 32);
  truncated.bytes[truncated.headerOffset + 32] = 0x80;
  expect(() => readGoBinaryImage(truncated.bytes)).toThrowError(
    /truncated|range|varint/i,
  );
});

it("refuses invalid module framing and malformed UTF-8 without replacement decoding", () => {
  const fixture = createGoBinaryFixture();
  fixture.bytes[fixture.moduleOffset] = 0;
  expect(() => readGoBinaryImage(fixture.bytes)).toThrowError(/framing/i);
  const invalid = createGoBinaryFixture();
  invalid.bytes[invalid.versionOffset] = 0xff;
  expect(() => readGoBinaryImage(invalid.bytes)).toThrowError(/UTF-8/i);
  const bom = createGoBinaryFixture({
    goVersion: "\ufeffgo1.26.0",
    moduleText: "\ufeffpath\tx\n",
  });
  expect(readGoBinaryImage(bom.bytes).build_info).toMatchObject({
    go_version: "\ufeffgo1.26.0",
    module_text: "\ufeffpath\tx\n",
  });
});

it("rejects future encodings and invalid pointer widths explicitly", () => {
  const flags = createGoBinaryFixture();
  flags.bytes[flags.headerOffset + 15] = 0x82;
  expect(() => readGoBinaryImage(flags.bytes)).toThrowError(/flags/i);
  const width = createGoBinaryFixture();
  width.bytes[width.headerOffset + 14] = 16;
  expect(() => readGoBinaryImage(width.bytes)).toThrowError(/pointer/i);
});

it("ignores the endian flag for pointer-free strings in a big-endian image", () => {
  const fixture = createGoBinaryFixture({ byteOrder: "big" });
  fixture.bytes[fixture.headerOffset + 15] = 2;
  expect(readGoBinaryImage(fixture.bytes).build_info?.go_version).toBe(
    "go1.26.0",
  );
});

it("distinguishes unsupported containers from malformed recognized images", () => {
  expect(() =>
    readGoBinaryImage(Buffer.from([0xca, 0xfe, 0xba, 0xbe])),
  ).toThrowError(/universal|fat/i);
  expect(() => readGoBinaryImage(Buffer.from("\x7fELF"))).toThrowError(
    /truncated/i,
  );
  const pe = createGoBinaryFixture({ format: "pe" });
  pe.bytes.writeUInt32LE(0xfffffff0, 60);
  expect(() => readGoBinaryImage(pe.bytes)).toThrowError(/range|truncated/i);
});

it("rejects ELF header tables overlapping the native header", () => {
  const fixture = createGoBinaryFixture({ sectionless: true });
  fixture.bytes.writeBigUInt64LE(0n, 32);
  expect(() => readGoBinaryImage(fixture.bytes)).toThrowError(
    /header|overlap/i,
  );
  const declaredSize = createGoBinaryFixture();
  declaredSize.bytes.writeUInt16LE(8192, 52);
  expect(() => readGoBinaryImage(declaredSize.bytes)).toThrowError(
    /truncated|range/i,
  );
});

it("rejects contradictory aliases when a metadata address maps to different file bytes", () => {
  const fixture = createGoBinaryFixture();
  fixture.bytes.writeUInt16LE(2, 56);
  fixture.bytes.writeUInt32LE(1, 184);
  fixture.bytes.writeUInt32LE(6, 188);
  fixture.bytes.writeBigUInt64LE(16n, 192);
  fixture.bytes.writeBigUInt64LE(0x10000n, 200);
  fixture.bytes.writeBigUInt64LE(4080n, 216);
  fixture.bytes.writeBigUInt64LE(4080n, 224);
  expect(() => readGoBinaryImage(fixture.bytes)).toThrowError(/ambiguous/i);
});

it.each(["pe", "elf"] as const)(
  "ignores a marker extending past the selected %s data boundary",
  (format) => {
    const fixture = createGoBinaryFixture({ format, omitBuildInfo: true });
    if (format === "pe") fixture.bytes.writeUInt32LE(2040, 264 + 8);
    else fixture.bytes.writeBigUInt64LE(2040n, 256 + 64 * 2 + 32);
    Buffer.from("ff20476f206275696c64696e663a", "hex").copy(
      fixture.bytes,
      3056,
    );
    expect(readGoBinaryImage(fixture.bytes).build_info).toBeNull();
  },
);

it.each([0n, 3n])(
  "rejects reserved extended ELF section counts containing %s",
  (count) => {
    const fixture = createGoBinaryFixture();
    fixture.bytes.writeUInt16LE(0, 60);
    fixture.bytes.writeBigUInt64LE(count, 256 + 32);
    expect(() => readGoBinaryImage(fixture.bytes)).toThrowError(
      /extended|section count/i,
    );
  },
);

it.each(["names", "programs"] as const)(
  "rejects extended ELF %s values below their reserved ranges",
  (field) => {
    const fixture = createGoBinaryFixture();
    fixture.bytes.writeUInt16LE(0xffff, field === "names" ? 62 : 56);
    fixture.bytes.writeUInt32LE(1, 256 + (field === "names" ? 40 : 44));
    expect(() => readGoBinaryImage(fixture.bytes)).toThrowError(/extended/i);
  },
);

it("requires SHT_NULL for the initial section carrying extended ELF numbering", () => {
  const bytes = extendedElfFixture();
  bytes.writeUInt32LE(1, 4096 + 4);
  expect(() => readGoBinaryImage(bytes)).toThrowError(
    /initial|section zero|SHT_NULL/i,
  );
});

it("reads a valid 65,536-entry ELF section table with an extended name-table index", () => {
  const bytes = extendedElfFixture();
  expect(readGoBinaryImage(bytes).build_info).toMatchObject({
    go_version: "go1.26.0",
    module_text: GO_MODULE_TEXT,
  });
});

const extendedElfFixture = (): Buffer => {
  const fixture = createGoBinaryFixture();
  const tableOffset = 4096;
  const count = 65536;
  const bytes = Buffer.alloc(tableOffset + count * 64);
  fixture.bytes.copy(bytes);
  bytes.writeBigUInt64LE(BigInt(tableOffset), 40);
  bytes.writeUInt16LE(0, 60);
  bytes.writeUInt16LE(0xffff, 62);
  bytes.writeBigUInt64LE(BigInt(count), tableOffset + 32);
  bytes.writeUInt32LE(count - 1, tableOffset + 40);
  fixture.bytes.subarray(384, 448).copy(bytes, tableOffset + 64);
  fixture.bytes.subarray(320, 384).copy(bytes, tableOffset + (count - 1) * 64);
  return bytes;
};
