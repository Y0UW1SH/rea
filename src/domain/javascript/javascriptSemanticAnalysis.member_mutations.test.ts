import { describe, expect, it } from "vitest";

import { analyzeJavaScriptSemantics } from "./javascriptSemanticAnalysis.js";
import { onlyCallable } from "./javascriptSemanticAnalysis.fixture.js";

const resultValue = (body: string) =>
  onlyCallable(
    analyzeJavaScriptSemantics(`export function result() { ${body} }`),
    "result",
  ).returnSites[0]?.value;

const mutations = [
  'const shared = { mode: "initial" }; const options = { [key]: shared }; options.foo.mode = "updated"; return shared.mode;',
  'const shared = { mode: "initial" }; const original = [shared]; const copy = [...original]; copy[0].mode = "updated"; return shared.mode;',
  'const original = { nested: { mode: "initial" } }; const copy = { ...original }; copy.nested.mode = "updated"; return original.nested.mode;',
  'const shared = { mode: "initial" }; const options = flag ? shared : { mode: "other" }; options.mode = "updated"; return shared.mode;',
  'const child = { mode: "initial" }; const options = { layer: { child } }; options.layer.child.mode = "updated"; return child.mode;',
  'const options = { mode: "initial" }; options.mode = "updated"; return options.mode;',
  "const options = { count: 1 }; options.count += 1; return options.count;",
  "const options = { count: 1 }; options.count++; return options.count;",
  'const options = { mode: "initial" }; delete options.mode; return options.mode;',
  'const options = ["initial"]; options[0] = "updated"; return options[0];',
  'const options = { nested: { mode: "initial" } }; options.nested.mode = "updated"; return options.nested.mode;',
  'const options = { mode: "initial" }; const alias = options; alias.mode = "updated"; return options.mode;',
  'const options = { nested: { mode: "initial" } }; const { nested } = options; nested.mode = "updated"; return options.nested.mode;',
  'const nested = { mode: "initial" }; const options = { nested }; options.nested.mode = "updated"; return nested.mode;',
  'const options = { mode: "initial" }; [options.mode] = ["updated"]; return options.mode;',
  'const options = { mode: "initial" }; for (options.mode of ["updated"]) {} return options.mode;',
  'const options = { mode: "initial" }; const key = getKey(); options[key] = "updated"; return options.mode;',
];

describe("JavaScript semantic values after explicit property mutations", () => {
  it.each(mutations)("keeps the mutated value unknown: %s", (body) => {
    expect(resultValue(body)?.status).toBe("unknown");
  });

  it("keeps an unrelated shadowed object literal known", () => {
    expect(
      resultValue(`
      const options = { mode: "initial" };
      { const options = { mode: "inner" }; options.mode = "updated"; }
      return options.mode;
    `),
    ).toEqual({ status: "literal", value: "initial" });
  });

  it("keeps scalar slots in a spread source known after a copy slot write", () => {
    expect(
      resultValue(`
      const original = { mode: "initial" };
      const copy = { ...original };
      copy.mode = "updated";
      return original.mode;
    `),
    ).toEqual({ status: "literal", value: "initial" });
  });

  it("keeps conditional object branches unknown after a property write", () => {
    expect(
      resultValue(`
      const options = flag ? { mode: "initial" } : { mode: "other" };
      options.mode = "updated";
      return options.mode;
    `)?.status,
    ).toBe("unknown");
  });

  it("keeps a copied primitive initializer known", () => {
    expect(
      resultValue(`
      const mode = "initial";
      const options = { mode };
      options.mode = "updated";
      return mode;
    `),
    ).toEqual({ status: "literal", value: "initial" });
  });

  it("retains ordinary immutable object and array projection", () => {
    expect(
      resultValue(
        'const options = { mode: ["initial"] }; return options.mode[0];',
      ),
    ).toEqual({ status: "literal", value: "initial" });
  });
});

describe("JavaScript semantic values after mutable references escape", () => {
  it("preserves copied scalar slots while invalidating shared children of an escaped object spread", () => {
    expect(
      resultValue(`
      const source = { kind: "record", child: { value: 1 } };
      const copy = { ...source };
      mutate(copy);
      return source;
    `),
    ).toMatchObject({
      status: "object",
      properties: [
        { name: "child", value: { status: "unknown" }, presence: "present" },
        { name: "kind", value: { status: "literal", value: "record" } },
      ],
    });
  });

  it("invalidates shared array children without invalidating copied primitives", () => {
    expect(
      resultValue(`
      const child = { value: 1 };
      const source = [child, "TOKEN"];
      const copy = [...source];
      mutate(copy);
      return { token: source[1], value: child.value };
    `),
    ).toMatchObject({
      status: "object",
      properties: [
        { name: "token", value: { status: "literal", value: "TOKEN" } },
        { name: "value", value: { status: "unknown" } },
      ],
    });
  });

  it("keeps primitive spread arguments known", () => {
    expect(
      resultValue(
        'const values = ["TOKEN"]; consume(...values); return values[0];',
      ),
    ).toEqual({ status: "literal", value: "TOKEN" });
  });

  it("does not treat a member constructor as a call with its container as receiver", () => {
    expect(
      resultValue(`
      const namespace = { token: "TOKEN", Factory: class {} };
      new namespace.Factory();
      return namespace.token;
    `),
    ).toEqual({ status: "literal", value: "TOKEN" });
  });

  it("does not reuse an initializer projection cached before call mutations were collected", () => {
    expect(
      resultValue(`
      const source = { value: 1 };
      function observe() { consume(copy); }
      mutate(source);
      const copy = source.value;
      return copy;
    `)?.status,
    ).toBe("unknown");
  });

  it.each([
    "mutate(source as unknown);",
    "mutate((0, source));",
    "let alias; mutate(alias = source);",
    "mutate(flag ? source : {});",
    "let alias = source; mutate(alias ||= {});",
    "let alias = source; mutate(alias ??= {});",
  ])("follows a reference through %s", (invocation) => {
    expect(
      resultValue(`
      const source = { value: 1 };
      ${invocation}
      return source.value;
    `)?.status,
    ).toBe("unknown");
  });
});

describe("JavaScript escaped references through async and destructuring syntax", () => {
  it("follows an awaited object argument", () => {
    const ir = analyzeJavaScriptSemantics(`export async function result() {
      const source = { value: 1 };
      mutate(await source);
      return source.value;
    }`);
    expect(onlyCallable(ir, "result").returnSites[0]?.value.status).toBe(
      "unknown",
    );
  });

  it.each([
    "const { ...copy } = source; mutate(copy);",
    "const { ...copy } = source; mutate(copy.child);",
    "const [ ...copy ] = [source.child]; mutate(copy);",
    "const [ first, ...copy ] = [null, source.child]; mutate(copy[0]);",
    "const [ ...[copy] ] = [source.child]; mutate(copy);",
    "const [ ...[copy = source.child] ] = []; mutate(copy);",
    "const { value = source.child } = {}; mutate(value);",
    "const [ value = source.child ] = []; mutate(value);",
  ])("follows shared references through %s", (invocation) => {
    expect(
      resultValue(`
      const source = { kind: "record", child: { value: 1 } };
      ${invocation}
      return source;
    `),
    ).toMatchObject({
      status: "object",
      properties: [
        { name: "child", value: { status: "unknown" }, presence: "present" },
        { name: "kind", value: { status: "literal", value: "record" } },
      ],
    });
  });

  it("keeps an unused default reference unchanged when destructuring a defined value", () => {
    expect(
      resultValue(`
      const source = { value: "TOKEN" };
      const { value = source } = { value: 1 };
      mutate(value);
      return source.value;
    `),
    ).toEqual({ status: "literal", value: "TOKEN" });
  });

  it("keeps an unused nested default reference unchanged", () => {
    expect(
      resultValue(`
      const unused = { value: "TOKEN" };
      const { box: { value = unused } = { value: 1 } } = {};
      mutate(value);
      return unused.value;
    `),
    ).toEqual({ status: "literal", value: "TOKEN" });
  });

  it("reconsiders a destructuring fallback after later collection finds an escape", () => {
    expect(
      resultValue(`
      const fallback = { value: 1 };
      const source = { child: { value: 2 } };
      function observe() { mutate(copy); }
      remove(source);
      const { child: copy = fallback } = source;
      mutate(copy);
      return fallback.value;
    `)?.status,
    ).toBe("unknown");
  });

  it("follows a fallback write when the original projection appeared primitive", () => {
    expect(
      resultValue(`
      const fallback = { value: 1 };
      const source = { child: 1 };
      function observe() { copy.value = 2; }
      remove(source);
      const { child: copy = fallback } = source;
      observe();
      return fallback.value;
    `)?.status,
    ).toBe("unknown");
  });

  it("keeps fresh rest-copy slot writes from changing the original", () => {
    expect(
      resultValue(`
      const source = { child: { value: "TOKEN" } };
      const { ...copy } = source;
      copy.child = {};
      return source.child.value;
    `),
    ).toEqual({ status: "literal", value: "TOKEN" });
  });

  it("follows writes to shared children of rest copies", () => {
    expect(
      resultValue(`
      const source = { kind: "record", child: { value: 1 } };
      const { ...copy } = source;
      copy.child.value = 2;
      return { kind: source.kind, value: source.child.value };
    `),
    ).toMatchObject({
      status: "object",
      properties: [
        { name: "kind", value: { status: "literal", value: "record" } },
        { name: "value", value: { status: "unknown" } },
      ],
    });
  });

  it("finishes repeated alias branches without expanding identical escape paths", () => {
    const declarations = Array.from({ length: 24 }, (_, index) => {
      const name = `alias${String(index + 1)}`;
      const previous = `alias${String(index)}`;
      return `let ${name} = ${previous}; ${name} = ${previous};`;
    }).join("\n");
    expect(
      resultValue(`
      let alias0 = { value: 1 };
      ${declarations}
      mutate(alias24);
      return alias0.value;
    `)?.status,
    ).toBe("unknown");
  });
});

const unchangedProperties = [
  'const source = { token: "TOKEN", count: 1 }; source.count = 2; return source.token;',
  'const source = { token: "TOKEN", count: 1 }; const alias = source; alias.count++; return source.token;',
  'const source = { token: "TOKEN", count: 1 }; delete source.count; return source.token;',
  'const source = { nested: { token: "TOKEN", count: 1 } }; source.nested.count = 2; return source.nested.token;',
  'const source = { nested: { token: "TOKEN", count: 1 } }; const { nested } = source; nested.count = 2; return source.nested.token;',
  'const child = { token: "TOKEN", count: 1 }; const source = { child }; source.child.count = 2; return child.token;',
  'const source = ["TOKEN", 1]; source[1] = 2; return source[0];',
  'const source = ["TOKEN"]; source.extra = 2; return source[0];',
  'const source = ["TOKEN"]; source["01"] = 2; return source[0];',
  'const source = ["TOKEN"]; source[1000000000] = 2; return source[0];',
  'const child = { token: "TOKEN", count: 1 }; const source = [child]; source[0].count = 2; return child.token;',
  'const source = { token: "TOKEN" }; source.added = 2; return source.token;',
  'const source = { token: "TOKEN", count: 1, other: 1 }; source.count = 2; source.other = 2; return source.token;',
  'const left = { token: "TOKEN", count: 1 }; const right = { count: 1 }; const source = { left, right }; source.right.count = 2; return left.count + ":" + left.token;',
];

describe("JavaScript semantic values for properties unaffected by a mutation", () => {
  it.each(unchangedProperties)("retains an unaffected property: %s", (body) => {
    expect(resultValue(body)).toEqual({
      status: "literal",
      value: body.includes("left.count") ? "1:TOKEN" : "TOKEN",
    });
  });

  it("keeps the changed slot unknown alongside an unchanged literal slot", () => {
    expect(
      resultValue(
        'const source = { token: "TOKEN", count: 1 }; source.count = 2; return source.count;',
      )?.status,
    ).toBe("unknown");
  });
});

describe("property mutations through TypeScript satisfies aliases", () => {
  it.each([
    'const shared = { mode: "initial" }; const alias = shared satisfies { mode: string }; alias.mode = "updated"; return shared.mode;',
    'const shared = { nested: { mode: "initial" } }; const alias = shared satisfies { nested: { mode: string } }; alias.nested.mode = "updated"; return shared.nested.mode;',
    'const shared = { mode: "initial" }; const alias = (shared satisfies { mode: string }) as { mode: string }; delete alias.mode; return shared.mode;',
    "const shared = [1]; const alias = shared satisfies number[]; alias[0]++; return shared[0];",
  ])("keeps the mutated value unknown: %s", (body) => {
    expect(resultValue(body)?.status).toBe("unknown");
  });

  it("retains the untouched property through a satisfies alias", () => {
    expect(
      resultValue(`
      const shared = { mode: "initial", token: "TOKEN" };
      const alias = shared satisfies { mode: string; token: string };
      alias.mode = "updated";
      return shared.token;
    `),
    ).toEqual({ status: "literal", value: "TOKEN" });
  });
});
