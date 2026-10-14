import { describe, expect, it } from "vitest";

import { isJsonText } from "./jsonTextSyntax.js";

const parses = (text: string): boolean => {
  try {
    JSON.parse(text);
    return true;
  } catch (cause: unknown) {
    void cause;
    return false;
  }
};

/** Deterministic generator so failures reproduce from the reported input. */
const random = (seed: number) => () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
};

const ALPHABET = [
  "{",
  "}",
  "[",
  "]",
  ",",
  ":",
  '"',
  "\\",
  "u",
  "0",
  "1",
  "9",
  "-",
  "+",
  ".",
  "e",
  "E",
  "a",
  "f",
  "t",
  "n",
  "true",
  "false",
  "null",
  " ",
  "\t",
  "\n",
  "\r",
  "\u000b",
  "\u0000",
  "\u001f",
  " ",
  "\ud800",
  "/",
  "b",
  "x",
];

describe("isJsonText", () => {
  it("accepts exactly what JSON.parse accepts for representative texts", () => {
    for (const text of [
      "",
      " ",
      "0",
      "-0",
      "01",
      "-",
      "1.",
      ".1",
      "1e",
      "1e+",
      "1E-2",
      "1.5e10",
      "-12.30e+04",
      "true",
      "tru",
      "trueX",
      "null ",
      " \t\n\r[] ",
      "[1,]",
      "[,1]",
      "[1 2]",
      "{}",
      '{"a":1}',
      '{"a":1,}',
      '{"a"}',
      "{a:1}",
      '{"a":1 "b":2}',
      '{"a":{"b":[1,{"c":null}]}}',
      '"\\u00e9\\n\\"\\/\\b\\f\\r\\t\\\\"',
      '"\\u12g4"',
      '"\\x"',
      '"tab\there"',
      '"\ud800"',
      '"unterminated',
      "[DONE]",
      "[".repeat(10_000) + "]".repeat(10_000),
      "[".repeat(10_000),
      "1 1",
      " 1",
      "﻿1",
    ])
      expect(isJsonText(text), JSON.stringify(text)).toBe(parses(text));
  });

  it("matches JSON.parse on generated and mutated inputs", () => {
    const next = random(0x5eed);
    const valid = [
      '{"choices":[{"delta":{"content":"x"},"index":0}],"id":"a"}',
      '[1,-2.5e3,true,false,null,"s",{"k":[]}]',
      '"\\u0041\\n"',
    ];
    for (let iteration = 0; iteration < 20_000; iteration += 1) {
      let text: string;
      if (iteration % 2 === 0) {
        const length = Math.floor(next() * 12);
        text = Array.from(
          { length },
          () => ALPHABET[Math.floor(next() * ALPHABET.length)],
        ).join("");
      } else {
        const base = valid[iteration % valid.length] ?? "";
        const at = Math.floor(next() * (base.length + 1));
        const insert = ALPHABET[Math.floor(next() * ALPHABET.length)] ?? "";
        text =
          next() < 0.5
            ? base.slice(0, at) + insert + base.slice(at)
            : base.slice(0, at) + base.slice(at + 1);
      }
      expect(isJsonText(text), JSON.stringify(text)).toBe(parses(text));
    }
  });

  it("checks deep nesting iteratively without a recursion limit", () => {
    const depth = 200_000;
    expect(isJsonText("[".repeat(depth) + "]".repeat(depth))).toBe(true);
    expect(isJsonText('{"a":'.repeat(depth) + "1" + "}".repeat(depth))).toBe(
      true,
    );
    expect(isJsonText("[".repeat(depth) + "]".repeat(depth - 1))).toBe(false);
  });
});
