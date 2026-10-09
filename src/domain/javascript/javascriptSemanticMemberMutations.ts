import * as t from "@babel/types";

import {
  resolveSemanticBindingState,
  type JavaScriptSemanticBindingState,
  type JavaScriptSemanticAnalysisState,
} from "./javascriptSemanticState.js";
import {
  clearSemanticPrimitiveBindingValues,
  evaluateSemanticBinding,
  evaluateSemanticExpression,
} from "./javascriptSemanticValues.js";
import { semanticSlotAtPath } from "./javascriptSemanticSlots.js";
import { semanticMutationInitializers } from "./javascriptSemanticMutationInitializers.js";
import {
  semanticArrayIndex,
  semanticPropertyPathKeyMatches,
  type JavaScriptSemanticPropertyPath,
} from "./javascriptSemanticPropertyPaths.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";
import { semanticStaticPropertyKey } from "./javascriptAstValues.js";

type PropertyPath = JavaScriptSemanticPropertyPath;
type ValueEffect = "write" | "escape";

/** Preserve uncertainty from property writes and references exposed to calls. */
export const collectSemanticMemberMutations = (
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
): void => {
  const parents = new WeakMap<t.Node, t.Node>();
  traverseJavaScriptAst(program, {
    enter: (node, parent) => {
      if (parent !== null) parents.set(node, parent);
    },
  });
  const recordedEffects = new Set<string>();
  let arrayIterationUnknown = false;
  const pendingReferences: {
    readonly initializer: JavaScriptSemanticBindingState["referenceInitializers"][number];
    readonly path: PropertyPath;
    readonly bindings: ReadonlySet<string>;
    readonly effect: ValueEffect;
    readonly mutation?: t.Node;
  }[] = [];
  const iterableReferences: IterableReference[] = [];
  const iterableReferenceKeys = new WeakMap<t.Node, Set<string>>();
  const deferIterable = (reference: IterableReference): void => {
    const keys = iterableReferenceKeys.get(reference.node) ?? new Set<string>();
    const key = JSON.stringify([
      reference.projection,
      reference.path,
      reference.fallbackPath,
      reference.effect,
      reference.mutation?.start,
      reference.mutation?.end,
      [...reference.bindings].sort(compareUnicodeCodePoints),
    ]);
    if (keys.has(key)) return;
    keys.add(key);
    iterableReferenceKeys.set(reference.node, keys);
    iterableReferences.push(reference);
  };
  const markValue = (
    node: t.Node,
    path: PropertyPath,
    bindings: ReadonlySet<string>,
    effect: ValueEffect = "write",
    mutation?: t.Node,
  ): void => {
    const pending = [{ node, path, bindings }];
    while (pending.length > 0) {
      const current = pending.pop();
      if (current === undefined) break;
      const expression = unwrapReferenceExpression(current.node);
      if (t.isIdentifier(expression)) {
        const binding = resolveSemanticBindingState(
          state,
          expression,
          expression.name,
        );
        if (binding === undefined) {
          if (
            (expression.name === "Array" &&
              (current.path[0] === "prototype" || current.path[0] === null)) ||
            (["globalThis", "global", "window", "self"].includes(
              expression.name,
            ) &&
              (current.path[0] === "Array" || current.path[0] === null) &&
              (current.path[1] === "prototype" || current.path[1] === null))
          )
            arrayIterationUnknown = true;
          continue;
        }
        if (current.bindings.has(binding.bindingId)) continue;
        const identity = JSON.stringify([
          binding.bindingId,
          effect,
          current.path,
          mutation?.start,
          mutation?.end,
        ]);
        if (recordedEffects.has(identity)) continue;
        const value =
          effect === "write"
            ? evaluateSemanticBinding(binding, state)
            : undefined;
        const primitiveWrite =
          value?.status === "literal" || value?.status === "union";
        recordedEffects.add(identity);
        const nested = new Set([...current.bindings, binding.bindingId]);
        if (!primitiveWrite) {
          (effect === "escape"
            ? binding.escapedPaths
            : binding.mutatedPaths
          ).push(current.path);
          clearSemanticPrimitiveBindingValues(state);
          const initializers =
            mutation === undefined
              ? binding.initializers
              : semanticMutationInitializers(binding, mutation, parents);
          for (const initializer of initializers)
            pending.push({
              node: initializer.node,
              path: [...initializer.projection, ...current.path],
              bindings: nested,
            });
        }
        for (const initializer of binding.referenceInitializers) {
          const path = copiedReferencePath(initializer, current.path, effect);
          if (path === null) continue;
          pendingReferences.push({
            initializer,
            path,
            bindings: nested,
            effect,
            ...(mutation === undefined ? {} : { mutation }),
          });
        }
      } else if (
        t.isMemberExpression(expression) ||
        t.isOptionalMemberExpression(expression)
      ) {
        pending.push({
          node: expression.object,
          path: [
            semanticStaticPropertyKey(expression.property, expression.computed),
            ...current.path,
          ],
          bindings: current.bindings,
        });
      } else {
        if (
          t.isArrayExpression(expression) &&
          ((current.path[0] === "__proto__" &&
            (effect === "escape" || current.path.length > 1)) ||
            (current.path[0] === "constructor" &&
              current.path[1] === "prototype"))
        )
          arrayIterationUnknown = true;
        for (const value of referencedValues(
          expression,
          current.path,
          effect,
        )) {
          if (value.iterableFallbackPath !== undefined)
            deferIterable({
              node: value.node,
              projection: [],
              path: value.path,
              fallbackPath: value.iterableFallbackPath,
              bindings: current.bindings,
              effect,
              ...(mutation === undefined ? {} : { mutation }),
            });
          else pending.push({ ...value, bindings: current.bindings });
        }
      }
    }
  };
  const markEscaped = (node: t.Node, path: PropertyPath = []): void =>
    markValue(node, path, new Set(), "escape");
  const markReceiver = (callee: t.Node): void => {
    const expression = unwrapReferenceExpression(callee);
    if (
      t.isMemberExpression(expression) ||
      t.isOptionalMemberExpression(expression)
    )
      markEscaped(expression.object);
  };
  const markTarget = (node: t.Node, mutation: t.Node): void => {
    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node))
      markValue(
        node.object,
        [semanticStaticPropertyKey(node.property, node.computed)],
        new Set(),
        "write",
        mutation,
      );
    else if (t.isRestElement(node)) markTarget(node.argument, mutation);
    else if (t.isAssignmentPattern(node)) markTarget(node.left, mutation);
    else if (t.isArrayPattern(node)) {
      for (const element of node.elements)
        if (element !== null) markTarget(element, mutation);
    } else if (t.isObjectPattern(node)) {
      for (const property of node.properties)
        markTarget(
          t.isRestElement(property) ? property.argument : property.value,
          mutation,
        );
    }
  };
  traverseJavaScriptAst(program, {
    enter: (node) => {
      if (t.isAssignmentExpression(node)) markTarget(node.left, node);
      else if (t.isUpdateExpression(node)) markTarget(node.argument, node);
      else if (t.isUnaryExpression(node, { operator: "delete" }))
        markTarget(node.argument, node);
      else if (t.isForOfStatement(node) || t.isForInStatement(node))
        markTarget(node.left, node);
      else if (
        t.isCallExpression(node) ||
        t.isOptionalCallExpression(node) ||
        t.isNewExpression(node)
      ) {
        for (const argument of node.arguments)
          if (t.isSpreadElement(argument))
            markEscaped(argument.argument, [null]);
          else markEscaped(argument);
        // Constructing a member does not pass its container as `this`.
        if (!t.isNewExpression(node)) markReceiver(node.callee);
      } else if (t.isTaggedTemplateExpression(node)) {
        markReceiver(node.tag);
        for (const expression of node.quasi.expressions)
          markEscaped(expression);
      }
    },
  });
  // A later effect can make a previously defined destructuring source uncertain.
  // Reconsider defaults and iterable origins until their effects are stable.
  while (pendingReferences.length > 0 || iterableReferences.length > 0) {
    const effectsBefore = recordedEffects.size;
    const iterablesBefore = iterableReferences.length;
    const iterationBefore: boolean = arrayIterationUnknown;
    for (const reference of pendingReferences.splice(0)) {
      const { initializer } = reference;
      if (
        initializer.requiredSources?.some(
          (source) =>
            selectedReferenceSlot(source, state)?.presence === "absent",
        ) ||
        initializer.fallbackSources?.some((source) => {
          const slot = selectedReferenceSlot(source, state);
          return (
            slot?.presence === "present" &&
            (slot.value.status === "literal" ||
              slot.value.status === "union" ||
              slot.value.status === "object" ||
              slot.value.status === "array")
          );
        })
      )
        pendingReferences.push(reference);
      else if (
        initializer.copyKind === "array-rest" &&
        initializer.copyProjectionOffset !== undefined
      ) {
        const offset = initializer.copyProjectionOffset;
        const projection = initializer.projection.slice(0, offset);
        deferIterable({
          node: initializer.node,
          projection,
          path: reference.path,
          fallbackPath: [
            ...projection,
            null,
            ...reference.path.slice(offset + 1),
          ],
          bindings: reference.bindings,
          effect: reference.effect,
          ...(reference.mutation === undefined
            ? {}
            : { mutation: reference.mutation }),
        });
      } else
        markValue(
          initializer.node,
          reference.path,
          reference.bindings,
          reference.effect,
          reference.mutation,
        );
    }
    for (const reference of [...iterableReferences]) {
      const slot = selectedReferenceSlot(reference, state);
      // Custom iteration can reorder values or yield non-indexed children.
      const knownArray =
        !arrayIterationUnknown &&
        slot?.value.status === "array" &&
        slot.value.items.every(
          (item) => semanticArrayIndex(item.name) !== null,
        );
      markValue(
        reference.node,
        knownArray ? reference.path : reference.fallbackPath,
        reference.bindings,
        reference.effect,
        reference.mutation,
      );
    }
    if (
      recordedEffects.size === effectsBefore &&
      iterableReferences.length === iterablesBefore &&
      arrayIterationUnknown === iterationBefore
    )
      break;
  }
  // Gathering effects can evaluate a primitive projection before its object
  // escapes. Final values must use the completed mutation state.
  clearSemanticPrimitiveBindingValues(state);
};

interface ReferencedValue {
  readonly node: t.Node;
  readonly path: PropertyPath;
  readonly iterableFallbackPath?: PropertyPath;
}

interface IterableReference extends ReferencedValue {
  readonly projection: PropertyPath;
  readonly fallbackPath: PropertyPath;
  readonly bindings: ReadonlySet<string>;
  readonly effect: ValueEffect;
  readonly mutation?: t.Node;
}

const referencedValues = (
  node: t.Node,
  path: PropertyPath,
  effect: ValueEffect,
): readonly ReferencedValue[] => {
  // An initializer owns its slots; only deeper writes can affect shared children.
  if (t.isObjectExpression(node) || t.isArrayExpression(node)) {
    if (effect === "write" && path.length < 2) return [];
    return t.isObjectExpression(node)
      ? objectReferencedValues(node, path)
      : arrayReferencedValues(node, path);
  }
  if (t.isAssignmentExpression(node))
    return node.operator === "||=" || node.operator === "??="
      ? [
          { node: node.left, path },
          { node: node.right, path },
        ]
      : [{ node: node.right, path }];
  if (t.isAwaitExpression(node)) return [{ node: node.argument, path }];
  if (t.isSequenceExpression(node)) {
    const last = node.expressions.at(-1);
    return last === undefined ? [] : [{ node: last, path }];
  }
  if (t.isConditionalExpression(node))
    return [
      { node: node.consequent, path },
      { node: node.alternate, path },
    ];
  if (t.isLogicalExpression(node))
    return [
      { node: node.left, path },
      { node: node.right, path },
    ];
  return [];
};

const objectReferencedValues = (
  node: t.ObjectExpression,
  path: PropertyPath,
): readonly ReferencedValue[] => {
  const [key, ...remaining] = path;
  const references: ReferencedValue[] = [];
  const overwritten = new Set<string>();
  for (const property of [...node.properties].reverse()) {
    if (t.isSpreadElement(property)) {
      const selected = key ?? null;
      if (typeof selected !== "object" && overwritten.has(String(selected)))
        continue;
      references.push({
        node: property.argument,
        path: [
          typeof selected === "object"
            ? {
                ...(selected ?? {}),
                excludedKeys: [
                  ...new Set([
                    ...(selected?.excludedKeys ?? []),
                    ...overwritten,
                  ]),
                ].sort(compareUnicodeCodePoints),
              }
            : selected,
          ...remaining,
        ],
      });
      continue;
    }
    const name = semanticStaticPropertyKey(property.key, property.computed);
    if (name !== null && overwritten.has(name)) continue;
    if (
      t.isObjectProperty(property) &&
      (name === null || semanticPropertyPathKeyMatches(key ?? null, name))
    )
      references.push({ node: property.value, path: remaining });
    // A prototype setter does not replace an own property from a spread.
    if (
      name !== null &&
      !(t.isObjectMethod(property) && property.kind !== "method") &&
      !(
        t.isObjectProperty(property) &&
        !property.computed &&
        !property.shorthand &&
        name === "__proto__"
      )
    )
      overwritten.add(name);
  }
  return references;
};

const arrayReferencedValues = (
  node: t.ArrayExpression,
  path: PropertyPath,
): readonly ReferencedValue[] => {
  const [key, ...remaining] = path;
  const selected = key ?? null;
  const selectedIndex =
    typeof selected === "object" ? null : semanticArrayIndex(selected);
  if (typeof selected !== "object" && selectedIndex === null) return [];
  const references: ReferencedValue[] = [];
  let minimumIndex = 0;
  let uncertainIndex = false;
  for (const element of node.elements) {
    if (t.isSpreadElement(element)) {
      if (selectedIndex === null || selectedIndex >= minimumIndex) {
        let sourceKey: PropertyPath[number] = null;
        if (!uncertainIndex) {
          if (selectedIndex !== null) sourceKey = selectedIndex - minimumIndex;
          else if (selected !== null && typeof selected === "object")
            sourceKey = {
              excludedKeys: selected.excludedKeys.flatMap((name) => {
                const index = semanticArrayIndex(name);
                return index === null || index < minimumIndex
                  ? []
                  : [String(index - minimumIndex)];
              }),
              startIndex: Math.max(
                0,
                (selected.startIndex ?? 0) - minimumIndex,
              ),
            };
        }
        references.push({
          node: element.argument,
          path: [sourceKey, ...remaining],
          ...(sourceKey === null
            ? {}
            : { iterableFallbackPath: [null, ...remaining] }),
        });
      }
      uncertainIndex = true;
      continue;
    }
    if (
      element !== null &&
      (uncertainIndex
        ? selectedIndex === null || selectedIndex >= minimumIndex
        : semanticPropertyPathKeyMatches(selected, String(minimumIndex)))
    )
      references.push({ node: element, path: remaining });
    minimumIndex++;
  }
  return references;
};

const copiedReferencePath = (
  initializer: JavaScriptSemanticBindingState["referenceInitializers"][number],
  path: PropertyPath,
  effect: ValueEffect,
): PropertyPath | null => {
  const offset = initializer.copyProjectionOffset;
  if (offset === undefined) return [...initializer.projection, ...path];
  const copiedPath = [...initializer.projection.slice(offset + 1), ...path];
  if (effect === "write" && copiedPath.length < 2) return null;
  let [key, ...remaining] = copiedPath;
  if (initializer.copyKind === "array-rest") {
    const startIndex = initializer.copyStartIndex ?? 0;
    if (key === undefined || key === null)
      key = { excludedKeys: [], startIndex };
    else if (typeof key === "object")
      key = {
        excludedKeys: key.excludedKeys.flatMap((name) => {
          const index = semanticArrayIndex(name);
          return index === null ? [] : [String(index + startIndex)];
        }),
        startIndex: (key.startIndex ?? 0) + startIndex,
      };
    else {
      const index = semanticArrayIndex(key);
      if (index === null) return null;
      key = index + startIndex;
    }
  } else {
    const excludedKeys = initializer.copyExcludedKeys ?? [];
    if (key === undefined || key === null) key = { excludedKeys };
    else if (typeof key === "object")
      key = {
        ...key,
        excludedKeys: [...new Set([...key.excludedKeys, ...excludedKeys])].sort(
          compareUnicodeCodePoints,
        ),
      };
    else if (excludedKeys.includes(String(key))) return null;
  }
  return [...initializer.projection.slice(0, offset), key, ...remaining];
};

const selectedReferenceSlot = (
  source: { readonly node: t.Node; readonly projection: PropertyPath },
  state: JavaScriptSemanticAnalysisState,
) => {
  const path: string[] = [];
  for (const key of source.projection) {
    if (key === null || typeof key === "object") return undefined;
    path.push(String(key));
  }
  return semanticSlotAtPath(
    evaluateSemanticExpression(source.node, state),
    path,
  );
};

const unwrapReferenceExpression = (node: t.Node): t.Node => {
  let current = node;
  while (
    t.isParenthesizedExpression(current) ||
    t.isTSAsExpression(current) ||
    t.isTSTypeAssertion(current) ||
    t.isTSSatisfiesExpression(current) ||
    t.isTSNonNullExpression(current) ||
    t.isTSInstantiationExpression(current)
  )
    current = current.expression;
  return current;
};
