import { describe, expect, it } from "vitest";

import {
  inferJsonShape,
  JsonShapeAccumulator,
  jsonShapeSchema,
  mergedJsonShapeSchema,
} from "./jsonShape.js";

const property = (name: string) => ({ kind: "property" as const, name });
const element = { kind: "array-element" as const };

describe("inferJsonShape", () => {
  it("retains paths and types without retaining JSON values", () => {
    const shape = inferJsonShape(
      JSON.stringify({
        token: "super-secret",
        users: [
          { id: 1, active: true },
          { id: "second-secret", active: false },
        ],
        optional: null,
      }),
    );

    expect(shape).toMatchObject({
      root_type: "object",
      properties: expect.arrayContaining([
        {
          path: [property("token")],
          types: ["string"],
          observations: 1,
        },
        {
          path: [property("users"), element, property("id")],
          types: ["number", "string"],
          observations: 2,
        },
        {
          path: [property("users"), element, property("active")],
          types: ["boolean"],
          observations: 2,
        },
      ]),
    });
    expect(JSON.stringify(shape)).not.toContain("super-secret");
    expect(JSON.stringify(shape)).not.toContain("second-secret");
  });

  it("distinguishes array elements from literal star properties and counts primitive types", () => {
    const shape = inferJsonShape('{"items":[{"*":1},[true,"x",null],2]}');
    expect(shape?.properties).toEqual(
      expect.arrayContaining([
        {
          path: [property("items"), element],
          types: ["array", "number", "object"],
          observations: 3,
        },
        {
          path: [property("items"), element, property("*")],
          types: ["number"],
          observations: 1,
        },
        {
          path: [property("items"), element, element],
          types: ["boolean", "null", "string"],
          observations: 3,
        },
      ]),
    );
  });

  it("rejects malformed JSON", () => {
    expect(inferJsonShape("not-json")).toBeNull();
  });

  it("orders mixed array and property descendants with parents first", () => {
    const shape = inferJsonShape('[{"z":1,"a":{"x":true}},[null],{"a":2}]');

    expect(shape?.properties.map(({ path }) => path)).toEqual([
      [element],
      [element, element],
      [element, property("a")],
      [element, property("a"), property("x")],
      [element, property("z")],
    ]);
    expect(shape?.properties[2]).toMatchObject({
      types: ["number", "object"],
      observations: 2,
    });
  });

  it("retains deep coverage and independently owned path segments", () => {
    const depth = 512;
    const shape = inferJsonShape("[".repeat(depth) + "1" + "]".repeat(depth));
    expect(shape).not.toBeNull();
    if (shape === null) return;

    expect(shape.node_count).toBe(depth + 1);
    expect(shape.max_depth_observed).toBe(depth);
    expect(shape.properties).toHaveLength(depth);
    expect(shape.properties.at(-1)).toEqual({
      path: Array.from({ length: depth }, () => element),
      types: ["number"],
      observations: 1,
    });
    expect(jsonShapeSchema.parse(shape)).toEqual(shape);
    expect(shape.properties[0]?.path[0]).not.toBe(shape.properties[1]?.path[0]);
  });
});

describe("JSON shape completeness and ordering", () => {
  it("preserves raw property names and code-point ordering independently of key insertion order", () => {
    for (const reverse of [false, true]) {
      const object = (number: number, value: unknown) => {
        const entries = [
          ["é/~", number],
          ["e\u0301/~", value],
          ["e\u0341/~", true],
          ["A", false],
          ["_", false],
          ["a", false],
          ["z", false],
          ["\u{10000}", false],
          ["\uE000", false],
        ];
        return Object.fromEntries(reverse ? entries.reverse() : entries);
      };
      const shape = inferJsonShape(
        JSON.stringify({ nested: [object(1, null), object(2, [null])] }),
      );

      expect(shape).toEqual({
        root_type: "object",
        node_count: 23,
        max_depth_observed: 4,
        properties: [
          {
            path: [property("nested")],
            types: ["array"],
            observations: 1,
          },
          {
            path: [property("nested"), element],
            types: ["object"],
            observations: 2,
          },
          {
            path: [property("nested"), element, property("A")],
            types: ["boolean"],
            observations: 2,
          },
          {
            path: [property("nested"), element, property("_")],
            types: ["boolean"],
            observations: 2,
          },
          {
            path: [property("nested"), element, property("a")],
            types: ["boolean"],
            observations: 2,
          },
          {
            path: [property("nested"), element, property("e\u0301/~")],
            types: ["array", "null"],
            observations: 2,
          },
          {
            path: [property("nested"), element, property("e\u0301/~"), element],
            types: ["null"],
            observations: 1,
          },
          {
            path: [property("nested"), element, property("e\u0341/~")],
            types: ["boolean"],
            observations: 2,
          },
          {
            path: [property("nested"), element, property("z")],
            types: ["boolean"],
            observations: 2,
          },
          {
            path: [property("nested"), element, property("é/~")],
            types: ["number"],
            observations: 2,
          },
          {
            path: [property("nested"), element, property("\uE000")],
            types: ["boolean"],
            observations: 2,
          },
          {
            path: [property("nested"), element, property("\u{10000}")],
            types: ["boolean"],
            observations: 2,
          },
        ],
      });
    }
  });

  it("retains every parsed property beyond the former shape-node limit", () => {
    const content = Object.fromEntries(
      Array.from({ length: 5_001 }, (_, index) => [`field_${index}`, index]),
    );
    const shape = inferJsonShape(JSON.stringify(content));

    expect(shape?.properties).toHaveLength(5_001);
    expect(shape?.node_count).toBe(5_002);
    expect(shape?.properties).toContainEqual({
      path: [property("field_5000")],
      types: ["number"],
      observations: 1,
    });
  });
});

describe("JsonShapeAccumulator", () => {
  it("merges payload shapes with per-path observations and every root type", () => {
    const accumulator = new JsonShapeAccumulator();
    expect(accumulator.snapshot()).toBeNull();
    expect(accumulator.add('{"a":1,"nested":{"x":"first-secret"}}')).toBe(true);
    expect(accumulator.add("not-json-secret")).toBe(false);
    expect(accumulator.add('{"a":"second-secret","b":[true]}')).toBe(true);
    expect(accumulator.add("[null]")).toBe(true);
    const merged = accumulator.snapshot();

    expect(merged).toEqual({
      root_types: ["array", "object"],
      node_count: 10,
      max_depth_observed: 2,
      properties: [
        { path: [element], types: ["null"], observations: 1 },
        { path: [property("a")], types: ["number", "string"], observations: 2 },
        { path: [property("b")], types: ["array"], observations: 1 },
        {
          path: [property("b"), element],
          types: ["boolean"],
          observations: 1,
        },
        { path: [property("nested")], types: ["object"], observations: 1 },
        {
          path: [property("nested"), property("x")],
          types: ["string"],
          observations: 1,
        },
      ],
    });
    expect(mergedJsonShapeSchema.parse(merged)).toEqual(merged);
    expect(JSON.stringify(merged)).not.toMatch(/secret/u);
  });

  it("keeps single-payload inference identical to one accumulated payload", () => {
    const text = '{"z":[1,{"y":null}],"a":true}';
    const accumulator = new JsonShapeAccumulator();
    accumulator.add(text);
    const single = inferJsonShape(text);
    const merged = accumulator.snapshot();

    if (single === null || merged === null)
      throw new Error("Valid JSON produced no shape");
    expect(Object.keys(single)).toEqual([
      "root_type",
      "node_count",
      "max_depth_observed",
      "properties",
    ]);
    const { root_type: rootType, ...singleFacts } = single;
    const { root_types: rootTypes, ...mergedFacts } = merged;
    expect(mergedFacts).toEqual(singleFacts);
    expect(rootTypes).toEqual([rootType]);
  });
});
