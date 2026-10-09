/** Distinguish corrupt recognized binaries from containers outside parser coverage. */
export class GoBinaryFormatFailure extends Error {
  constructor(
    readonly kind: "malformed" | "unsupported",
    message: string,
  ) {
    super(message);
    this.name = "GoBinaryFormatFailure";
  }
}

/** Resource boundary exceeded while decoding metadata or native container structure. */
export class GoBinaryResourceFailure extends Error {
  constructor(
    readonly boundary: "build-info" | "structure",
    readonly maximum_bytes: number,
    message: string,
  ) {
    super(message);
    this.name = "GoBinaryResourceFailure";
  }
}

/** One file-backed virtual range; addresses stay exact until mapped to file offsets. */
export interface GoFileMapping {
  readonly address: bigint;
  readonly offset: number;
  readonly size: number;
}

/** Native container facts and its producer-defined build-info search area. */
export interface GoBinaryContainer {
  readonly format: "elf" | "pe" | "macho";
  readonly architecture: string;
  readonly bits: 32 | 64;
  readonly byte_order: "little" | "big";
  readonly mappings: readonly GoFileMapping[];
  readonly search: GoFileMapping | null;
}

/** Reader that checks every structural range before decoding numeric fields. */
export class GoBinaryReader {
  constructor(
    readonly bytes: Buffer,
    readonly little: boolean,
  ) {}

  range(offset: number, size: number, label: string): Buffer {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      offset < 0 ||
      size < 0 ||
      offset > this.bytes.length ||
      size > this.bytes.length - offset
    )
      throw new GoBinaryFormatFailure(
        "malformed",
        `${label} range is truncated or outside the file`,
      );
    return this.bytes.subarray(offset, offset + size);
  }

  u16(offset: number): number {
    const value = this.range(offset, 2, "16-bit field");
    return this.little ? value.readUInt16LE() : value.readUInt16BE();
  }

  u32(offset: number): number {
    const value = this.range(offset, 4, "32-bit field");
    return this.little ? value.readUInt32LE() : value.readUInt32BE();
  }

  word(offset: number, bits: 32 | 64): bigint {
    if (bits === 32) return BigInt(this.u32(offset));
    const value = this.range(offset, 8, "64-bit field");
    return this.little ? value.readBigUInt64LE() : value.readBigUInt64BE();
  }

  fileRange(offset: bigint, size: bigint, label: string): GoFileMapping {
    if (
      offset > BigInt(this.bytes.length) ||
      size > BigInt(this.bytes.length) - offset
    )
      throw new GoBinaryFormatFailure(
        "malformed",
        `${label} range is outside the file`,
      );
    const result = { address: 0n, offset: Number(offset), size: Number(size) };
    this.range(result.offset, result.size, label);
    return result;
  }

  table(offset: bigint, count: number, width: number, label: string): number {
    const size = BigInt(count) * BigInt(width);
    if (size > 16n * 1024n * 1024n)
      throw new GoBinaryResourceFailure(
        "structure",
        16 * 1024 * 1024,
        `${label} exceeds the 16 MiB structural decoding budget`,
      );
    return this.fileRange(offset, size, label).offset;
  }
}

/** Map a virtual span without losing precision or selecting an ambiguous alias. */
export const mappedFileOffset = (
  mappings: readonly GoFileMapping[],
  address: bigint,
  size: number,
): number => {
  let found: number | undefined;
  for (const mapping of mappings) {
    const delta = address - mapping.address;
    if (
      delta < 0n ||
      delta > BigInt(mapping.size) ||
      BigInt(size) > BigInt(mapping.size) - delta
    )
      continue;
    const offset = mapping.offset + Number(delta);
    if (found !== undefined && found !== offset)
      throw new GoBinaryFormatFailure(
        "malformed",
        "Virtual address has ambiguous file mappings",
      );
    found = offset;
  }
  if (found === undefined)
    throw new GoBinaryFormatFailure(
      "malformed",
      "Virtual address or string range is not file mapped",
    );
  return found;
};

/** Decode metadata text without replacing invalid bytes or stripping an initial BOM. */
export const goUtf8 = (bytes: Buffer, label: string): string => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch (cause) {
    throw new GoBinaryFormatFailure(
      "malformed",
      `${label} contains malformed UTF-8: ${String(cause)}`,
    );
  }
};
