import { z } from "zod";

import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";

const jsonValueTypeSchema = z.enum([
  "object",
  "array",
  "string",
  "number",
  "boolean",
  "null",
]);
type JsonValueType = z.infer<typeof jsonValueTypeSchema>;

const jsonShapePathSegmentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("property"), name: z.string() }),
  z.object({ kind: z.literal("array-element") }),
]);
type JsonShapePathSegment = z.infer<typeof jsonShapePathSegmentSchema>;

const jsonShapePropertiesSchema = z.array(
  z.object({
    path: z.array(jsonShapePathSegmentSchema).min(1),
    types: z.array(jsonValueTypeSchema).min(1),
    observations: z.number().int().min(1),
  }),
);

/** Value-free structural summary of one approved JSON payload. */
export const jsonShapeSchema = z.object({
  root_type: jsonValueTypeSchema,
  node_count: z.number().int().min(1),
  max_depth_observed: z.number().int().min(0),
  properties: jsonShapePropertiesSchema,
});
export type JsonShape = z.infer<typeof jsonShapeSchema>;

/**
 * Value-free structural summary merged across JSON payloads. Path observations
 * count matching nodes across every payload; root types list each observed root.
 */
export const mergedJsonShapeSchema = z.object({
  root_types: z.array(jsonValueTypeSchema).min(1),
  node_count: z.number().int().min(1),
  max_depth_observed: z.number().int().min(0),
  properties: jsonShapePropertiesSchema,
});
export type MergedJsonShape = z.infer<typeof mergedJsonShapeSchema>;

const arrayElementKey = Symbol("array-element");

interface ShapeNode {
  readonly path: JsonShapePathSegment[];
  readonly types: Set<JsonValueType>;
  observations: number;
  children?: Map<string | typeof arrayElementKey, ShapeNode>;
}

/**
 * Shared bound on distinct retained shape paths. Accumulators that share one
 * budget charge each newly retained path once; nodes under paths that no longer
 * fit are counted in `omittedNodes` and never retained.
 */
export interface JsonShapePathBudget {
  remainingPaths: number;
  omittedNodes: number;
}

/**
 * Merge value-free shapes of approved JSON payloads. Each payload is parsed and
 * its values discarded after iterative inference; one accumulator per
 * structural path is shared by all payloads and matching array rows.
 */
export class JsonShapeAccumulator {
  readonly #root: ShapeNode = { path: [], types: new Set(), observations: 0 };
  readonly #budget: JsonShapePathBudget | undefined;
  #nodeCount = 0;
  #maxDepthObserved = 0;

  /** Without a budget every parsed path is retained, as for single payloads. */
  constructor(budget?: JsonShapePathBudget) {
    this.#budget = budget;
  }

  /** Add one JSON text; malformed JSON returns false and changes nothing. */
  add(text: string): boolean {
    let root: unknown;
    try {
      root = JSON.parse(text);
    } catch (cause: unknown) {
      // Invalid JSON is represented by the false return.
      void cause;
      return false;
    }
    const pending: Array<{
      readonly value: unknown;
      readonly shape: ShapeNode | undefined;
    }> = [{ value: root, shape: this.#root }];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) break;
      if (current.shape === undefined) {
        this.#countOmitted(current.value, pending);
        continue;
      }
      this.#nodeCount += 1;
      this.#maxDepthObserved = Math.max(
        this.#maxDepthObserved,
        current.shape.path.length,
      );
      current.shape.types.add(jsonValueType(current.value));
      current.shape.observations += 1;
      if (Array.isArray(current.value)) {
        if (current.value.length === 0) continue;
        const shape = this.#childShape(current.shape, arrayElementKey);
        for (let index = current.value.length - 1; index >= 0; index -= 1)
          pending.push({ value: current.value[index], shape });
        continue;
      }
      if (!isRecord(current.value)) continue;
      const allEntries = Object.entries(current.value);
      for (let index = allEntries.length - 1; index >= 0; index -= 1) {
        const entry = allEntries[index];
        if (entry === undefined) continue;
        const [name, value] = entry;
        pending.push({ value, shape: this.#childShape(current.shape, name) });
      }
    }
    return true;
  }

  /** Count one unretained node and queue its children, still without values. */
  #countOmitted(
    value: unknown,
    pending: Array<{
      readonly value: unknown;
      readonly shape: ShapeNode | undefined;
    }>,
  ): void {
    if (this.#budget !== undefined) this.#budget.omittedNodes += 1;
    const children = Array.isArray(value)
      ? value
      : isRecord(value)
        ? Object.values(value)
        : [];
    for (const child of children)
      pending.push({ value: child, shape: undefined });
  }

  #childShape(
    parent: ShapeNode,
    key: string | typeof arrayElementKey,
  ): ShapeNode | undefined {
    if (parent.children?.has(key) === true || this.#budget === undefined)
      return childShape(parent, key);
    if (this.#budget.remainingPaths <= 0) return undefined;
    this.#budget.remainingPaths -= 1;
    return childShape(parent, key);
  }

  /** Canonical merged shape, or null before any valid payload. */
  snapshot(): MergedJsonShape | null {
    if (this.#root.observations === 0) return null;
    return {
      root_types: [...this.#root.types].sort(),
      node_count: this.#nodeCount,
      max_depth_observed: this.#maxDepthObserved,
      properties: canonicalProperties(this.#root),
    };
  }
}

/** Parse approved JSON and immediately discard values after iterative shape inference. */
export const inferJsonShape = (text: string): JsonShape | null => {
  const accumulator = new JsonShapeAccumulator();
  if (!accumulator.add(text)) return null;
  const shape = accumulator.snapshot();
  const rootType = shape?.root_types[0];
  if (shape === null || rootType === undefined) return null;
  return {
    root_type: rootType,
    node_count: shape.node_count,
    max_depth_observed: shape.max_depth_observed,
    properties: shape.properties,
  };
};

// Each structural path owns one accumulator, shared by all matching array rows.
const childShape = (
  parent: ShapeNode,
  key: string | typeof arrayElementKey,
): ShapeNode => {
  const children = (parent.children ??= new Map());
  const existing = children.get(key);
  if (existing !== undefined) return existing;
  const node: ShapeNode = {
    path: [
      ...parent.path,
      typeof key === "string"
        ? { kind: "property", name: key }
        : { kind: "array-element" },
    ],
    types: new Set(),
    observations: 0,
  };
  children.set(key, node);
  return node;
};

// Preorder over sorted siblings gives canonical paths without repeatedly
// comparing their shared prefixes. Each returned path owns its segments.
const canonicalProperties = (root: ShapeNode): JsonShape["properties"] => {
  const properties: JsonShape["properties"] = [];
  const shapes = orderedChildren(root);
  while (shapes.length > 0) {
    const shape = shapes.pop();
    if (shape === undefined) break;
    properties.push({
      path: shape.path.map((segment) => ({ ...segment })),
      types: [...shape.types].sort(),
      observations: shape.observations,
    });
    for (const child of orderedChildren(shape)) shapes.push(child);
  }
  return properties;
};

const jsonValueType = (value: unknown): JsonValueType => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "object";
  }
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Reverse sibling order for the traversal stack; array elements sort first. */
const orderedChildren = (node: ShapeNode): ShapeNode[] =>
  [...(node.children ?? [])]
    .sort(([left], [right]) =>
      left === right
        ? 0
        : left === arrayElementKey
          ? 1
          : right === arrayElementKey
            ? -1
            : compareUnicodeCodePoints(right, left),
    )
    .map(([, child]) => child);
