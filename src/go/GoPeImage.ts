import {
  GoBinaryFormatFailure,
  GoBinaryReader,
  type GoBinaryContainer,
  type GoFileMapping,
} from "./GoBinaryContainer.js";

/** Read PE32/PE32+ native image mappings and the linker data section. */
export const readGoPeImage = (bytes: Buffer): GoBinaryContainer => {
  const reader = new GoBinaryReader(bytes, true);
  reader.range(0, 64, "DOS header");
  const pe = reader.u32(60);
  if (
    pe < 64 ||
    !reader
      .range(pe, 24, "PE signature and COFF header")
      .subarray(0, 4)
      .equals(Buffer.from("PE\0\0"))
  )
    throw new GoBinaryFormatFailure(
      "malformed",
      "PE signature is invalid or overlaps the DOS header",
    );
  const optional = pe + 24;
  const optionalSize = reader.u16(pe + 20);
  reader.range(optional, optionalSize, "PE optional header");
  const magic = reader.u16(optional);
  const bits = magic === 0x10b ? 32 : magic === 0x20b ? 64 : null;
  if (bits === null)
    throw new GoBinaryFormatFailure(
      "unsupported",
      "Only PE32 and PE32+ image optional headers are supported",
    );
  if (optionalSize < (bits === 64 ? 112 : 96))
    throw new GoBinaryFormatFailure(
      "malformed",
      "PE optional header is truncated",
    );
  const imageBase = reader.word(optional + (bits === 64 ? 24 : 28), bits);
  const count = reader.u16(pe + 6);
  const start = reader.table(
    BigInt(optional + optionalSize),
    count,
    40,
    "PE sections",
  );
  const mappings: GoFileMapping[] = [];
  let search: GoFileMapping | null = null;
  for (let index = 0; index < count; index++) {
    const entry = start + index * 40;
    const virtualSize = reader.u32(entry + 8);
    const virtualAddress = reader.u32(entry + 12);
    const size = reader.u32(entry + 16);
    const offset = reader.u32(entry + 20);
    const characteristics = reader.u32(entry + 36);
    const address = imageBase + BigInt(virtualAddress);
    if (address + BigInt(Math.max(size, virtualSize)) > 1n << BigInt(bits))
      throw new GoBinaryFormatFailure(
        "malformed",
        "PE section virtual address overflows its address width",
      );
    const mapping = {
      ...reader.fileRange(BigInt(offset), BigInt(size), "PE section"),
      address,
    };
    if (size !== 0) mappings.push(mapping);
    // Match debug/buildinfo's first initialized, readable, writable data section.
    if (
      search === null &&
      virtualAddress !== 0 &&
      size !== 0 &&
      (characteristics & ~0x00600000) >>> 0 === 0xc0000040
    ) {
      search = { ...mapping, size: Math.min(size, virtualSize) };
    }
  }
  const machine = reader.u16(pe + 4);
  const names = new Map([
    [0x014c, "386"],
    [0x8664, "amd64"],
    [0x01c0, "arm"],
    [0x01c2, "arm"],
    [0x01c4, "arm"],
    [0xaa64, "arm64"],
  ]);
  return {
    format: "pe",
    architecture: names.get(machine) ?? `pe-machine-${machine}`,
    bits,
    byte_order: "little",
    mappings,
    search,
  };
};
