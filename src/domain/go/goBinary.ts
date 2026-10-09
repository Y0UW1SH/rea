import { z } from "zod";
import { digestSchema } from "../digests.js";
import { localPathStringSchema } from "../localPath.js";
import { CANONICAL_BASE64_PATTERN } from "../stringPatterns.js";

const sourceRangeSchema = z.strictObject({
  offset: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
});
const moduleIdentitySchema = z.strictObject({
  path: z.string(),
  version: z.string(),
  sum: z.string().nullable(),
});

/** Module identities retain development versions, local replacements and missing sums verbatim. */
export const goModuleSchema = moduleIdentitySchema.extend({
  replacement: moduleIdentitySchema.nullable(),
});

/** Parsed records alongside every unrecognized module-text line. */
export const goModuleMetadataSchema = z.strictObject({
  path: z.string().nullable(),
  main: goModuleSchema.nullable(),
  dependencies: z.array(goModuleSchema),
  settings: z.array(z.strictObject({ key: z.string(), value: z.string() })),
  unparsed_lines: z.array(z.string()),
  complete: z.boolean(),
});

/** One exact local artifact, independent of any active disassembler target. */
export const inspectGoBinaryInputSchema = z.strictObject({
  path: localPathStringSchema.describe(
    "Absolute filesystem path to the selected executable or library",
  ),
});

/** Compiler-written build information and its original file-backed source ranges. */
export const goBuildInfoSchema = z.strictObject({
  header_offset: z.number().int().nonnegative(),
  encoding: z.enum(["inline", "pointer"]),
  go_version: z.string(),
  module_text: z.string(),
  module_bytes_base64: z.string().regex(CANONICAL_BASE64_PATTERN),
  version_location: sourceRangeSchema,
  module_location: sourceRangeSchema,
  module: goModuleMetadataSchema,
});

/** Complete bounded build-metadata observation; absence does not identify a binary as non-Go. */
export const goBinarySchema = z
  .strictObject({
    artifact: z.strictObject({
      path: localPathStringSchema,
      sha256: digestSchema,
      bytes: z.number().int().nonnegative(),
    }),
    format: z.enum(["elf", "pe", "macho"]),
    architecture: z.string(),
    bits: z.union([z.literal(32), z.literal(64)]),
    byte_order: z.enum(["little", "big"]),
    build_info: goBuildInfoSchema.nullable(),
    limitations: z.array(z.string()),
  })
  .superRefine((report, context) => {
    const info = report.build_info;
    if (info === null) return;
    if (info.header_offset > report.artifact.bytes - 32)
      context.addIssue({
        code: "custom",
        path: ["build_info", "header_offset"],
        message: "Build-info header is outside the selected artifact.",
      });
    for (const field of ["version_location", "module_location"] as const) {
      const range = info[field];
      if (
        range.offset > report.artifact.bytes ||
        range.bytes > report.artifact.bytes - range.offset
      )
        context.addIssue({
          code: "custom",
          path: ["build_info", field],
          message: "Build-info source range is outside the selected artifact.",
        });
    }
    const padding = info.module_bytes_base64.endsWith("==")
      ? 2
      : info.module_bytes_base64.endsWith("=")
        ? 1
        : 0;
    if (
      (info.module_bytes_base64.length / 4) * 3 - padding !==
      info.module_location.bytes
    )
      context.addIssue({
        code: "custom",
        path: ["build_info", "module_bytes_base64"],
        message:
          "Encoded module bytes do not match their reported source length.",
      });
  });

export type GoModule = z.infer<typeof goModuleSchema>;
export type GoModuleMetadata = z.infer<typeof goModuleMetadataSchema>;
export type GoBinary = z.infer<typeof goBinarySchema>;
export type InspectGoBinaryInput = z.infer<typeof inspectGoBinaryInputSchema>;
