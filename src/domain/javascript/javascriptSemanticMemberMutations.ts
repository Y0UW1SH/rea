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
import { traverseJavaScriptAst } from "./javascriptSemanticTraversal.js";
import { semanticStaticPropertyKey } from "./javascriptAstValues.js";

type PropertyPath = readonly (string | number | null)[];
type ValueEffect = "write" | "escape";

/** Preserve uncertainty from property writes and references exposed to calls. */
export const collectSemanticMemberMutations = (
  program: t.Program,
  state: JavaScriptSemanticAnalysisState,
): void => {
  const recordedEffects = new Set<string>();
  const pendingReferences: {
    readonly initializer: JavaScriptSemanticBindingState["referenceInitializers"][number];
    readonly path: PropertyPath;
    readonly bindings: ReadonlySet<string>;
    readonly effect: ValueEffect;
  }[] = [];
  const markValue = (
    node: t.Node,
    path: PropertyPath,
    bindings: ReadonlySet<string>,
    effect: ValueEffect = "write",
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
        if (binding === undefined || current.bindings.has(binding.bindingId))
          continue;
        const identity = JSON.stringify([
          binding.bindingId,
          effect,
          current.path,
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
          for (const initializer of binding.initializers)
            pending.push({
              node: initializer.node,
              path: [...initializer.projection, ...current.path],
              bindings: nested,
            });
        }
        for (const initializer of binding.referenceInitializers) {
          const offset = initializer.copyProjectionOffset;
          const suffix =
            offset === undefined
              ? []
              : initializer.projection.slice(offset + 1);
          const copiedPath = [...suffix, ...current.path];
          if (
            initializer.copyKind !== undefined &&
            effect === "write" &&
            copiedPath.length < 2
          )
            continue;
          const path =
            offset === undefined
              ? [...initializer.projection, ...current.path]
              : [
                  ...initializer.projection.slice(0, offset),
                  ...(initializer.copyKind === "array-rest"
                    ? [null, ...copiedPath.slice(1)]
                    : copiedPath.length === 0
                      ? [null]
                      : copiedPath),
                ];
          pendingReferences.push({
            initializer,
            path,
            bindings: nested,
            effect,
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
        for (const value of referencedValues(expression, current.path, effect))
          pending.push({ ...value, bindings: current.bindings });
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
  const markTarget = (node: t.Node): void => {
    if (t.isMemberExpression(node) || t.isOptionalMemberExpression(node))
      markValue(
        node.object,
        [semanticStaticPropertyKey(node.property, node.computed)],
        new Set(),
      );
    else if (t.isRestElement(node)) markTarget(node.argument);
    else if (t.isAssignmentPattern(node)) markTarget(node.left);
    else if (t.isArrayPattern(node)) {
      for (const element of node.elements)
        if (element !== null) markTarget(element);
    } else if (t.isObjectPattern(node)) {
      for (const property of node.properties)
        markTarget(
          t.isRestElement(property) ? property.argument : property.value,
        );
    }
  };
  traverseJavaScriptAst(program, {
    enter: (node) => {
      if (t.isAssignmentExpression(node)) markTarget(node.left);
      else if (t.isUpdateExpression(node)) markTarget(node.argument);
      else if (t.isUnaryExpression(node, { operator: "delete" }))
        markTarget(node.argument);
      else if (t.isForOfStatement(node) || t.isForInStatement(node))
        markTarget(node.left);
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
  // Reconsider its fallback edges until no newly reachable reference is recorded.
  while (pendingReferences.length > 0) {
    const effectsBefore = recordedEffects.size;
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
      else
        markValue(
          initializer.node,
          reference.path,
          reference.bindings,
          reference.effect,
        );
    }
    if (recordedEffects.size === effectsBefore) break;
  }
  // Gathering effects can evaluate a primitive projection before its object
  // escapes. Final values must use the completed mutation state.
  clearSemanticPrimitiveBindingValues(state);
};

interface ReferencedValue {
  readonly node: t.Node;
  readonly path: PropertyPath;
}

const referencedValues = (
  node: t.Node,
  path: PropertyPath,
  effect: ValueEffect,
): readonly ReferencedValue[] => {
  const [key, ...remaining] = path;
  const wholeEscape = effect === "escape" && path.length === 0;
  // An initializer owns its slots; only deeper writes can affect shared children.
  if (t.isObjectExpression(node))
    return effect === "write" && path.length < 2
      ? []
      : node.properties.flatMap<ReferencedValue>((property) => {
          if (t.isSpreadElement(property))
            return [
              { node: property.argument, path: wholeEscape ? [null] : path },
            ];
          if (!t.isObjectProperty(property)) return [];
          const name = semanticStaticPropertyKey(
            property.key,
            property.computed,
          );
          return wholeEscape ||
            key === null ||
            name === null ||
            String(key) === name
            ? [{ node: property.value, path: remaining }]
            : [];
        });
  if (t.isArrayExpression(node)) {
    if (effect === "write" && path.length < 2) return [];
    let uncertainIndex = false;
    return node.elements.flatMap<ReferencedValue>((element, index) => {
      if (element === null) return [];
      if (t.isSpreadElement(element)) {
        uncertainIndex = true;
        return [{ node: element.argument, path: [null, ...remaining] }];
      }
      return wholeEscape ||
        uncertainIndex ||
        key === null ||
        String(key) === String(index)
        ? [{ node: element, path: remaining }]
        : [];
    });
  }
  if (t.isAssignmentExpression(node))
    return node.operator === "||=" ||
      node.operator === "??=" ||
      node.operator === "&&="
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

const selectedReferenceSlot = (
  source: { readonly node: t.Node; readonly projection: PropertyPath },
  state: JavaScriptSemanticAnalysisState,
) => {
  const path: string[] = [];
  for (const key of source.projection) {
    if (key === null) return undefined;
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
