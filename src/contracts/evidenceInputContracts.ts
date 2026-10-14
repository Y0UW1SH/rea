import { z } from "zod";
import { evidenceSchema } from "../domain/evidence.js";
import { prefixedDigestSchema } from "../domain/digests.js";

/** Exact reference to Evidence already retained by the current session. */
export const retainedEvidenceReferenceSchema = z.strictObject({
  kind: z.literal("retained-evidence"),
  evidence_id: prefixedDigestSchema("ev"),
});

/** Portable inline Evidence or an exact, session-scoped reference. */
export const evidenceInputSchema = z.union([
  evidenceSchema,
  retainedEvidenceReferenceSchema,
]);

/** Evidence input after parsing the advertised boundary contract. */
export type EvidenceInput = z.output<typeof evidenceInputSchema>;

// The application admits this value against its projection budget before
// authenticated parsing. SDK and CLI envelope parsing borrow the caller's value
// rather than clone it, while advertising the owning Evidence contract.
const borrowedInlineEvidenceSchema = z.unknown().nonoptional();
borrowedInlineEvidenceSchema._zod.processJSONSchema =
  evidenceSchema._zod.processJSONSchema;

/** An exact same-session reference, or inline Evidence borrowed for application admission. */
export const admittedEvidenceInputSchema = z.union([
  retainedEvidenceReferenceSchema,
  borrowedInlineEvidenceSchema,
]);
