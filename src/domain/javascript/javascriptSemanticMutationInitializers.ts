import * as t from "@babel/types";

import type { JavaScriptSemanticBindingState } from "./javascriptSemanticState.js";

interface StatementPosition {
  readonly body: readonly t.Statement[];
  readonly index: number;
}

const statementPosition = (
  statement: t.Statement,
  parents: WeakMap<t.Node, t.Node>,
): StatementPosition | null => {
  const parent = parents.get(statement);
  if (!t.isProgram(parent) && !t.isBlockStatement(parent)) return null;
  const index = parent.body.indexOf(statement);
  return index < 0 ? null : { body: parent.body, index };
};

const directInitializerPosition = (
  node: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): StatementPosition | null => {
  const parent = parents.get(node);
  if (t.isVariableDeclarator(parent) && parent.init === node) {
    const declaration = parents.get(parent);
    return t.isVariableDeclaration(declaration)
      ? statementPosition(declaration, parents)
      : null;
  }
  if (
    t.isAssignmentExpression(parent) &&
    parent.operator === "=" &&
    parent.right === node &&
    t.isIdentifier(parent.left)
  ) {
    const statement = parents.get(parent);
    return t.isExpressionStatement(statement) && statement.expression === parent
      ? statementPosition(statement, parents)
      : null;
  }
  return null;
};

const directMutationPosition = (
  node: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): StatementPosition | null => {
  if (
    !t.isAssignmentExpression(node) &&
    !t.isUpdateExpression(node) &&
    !t.isUnaryExpression(node, { operator: "delete" })
  )
    return null;
  const statement = parents.get(node);
  return t.isExpressionStatement(statement) && statement.expression === node
    ? statementPosition(statement, parents)
    : null;
};

/** Retain the latest provable alias initializer before a direct property write. */
export const semanticMutationInitializers = (
  binding: JavaScriptSemanticBindingState,
  mutation: t.Node,
  parents: WeakMap<t.Node, t.Node>,
): JavaScriptSemanticBindingState["initializers"] => {
  if (binding.initializers.length < 2) return binding.initializers;
  const mutationPosition = directMutationPosition(mutation, parents);
  if (mutationPosition === null) return binding.initializers;
  const positions = binding.initializers.map(({ node }) =>
    directInitializerPosition(node, parents),
  );
  if (
    positions.some(
      (position) =>
        position === null ||
        position.body !== mutationPosition.body ||
        position.index >= mutationPosition.index,
    )
  )
    return binding.initializers;
  const latestIndex = positions.reduce(
    (latest, position) => Math.max(latest, position?.index ?? -1),
    -1,
  );
  return binding.initializers.filter(
    (_, index) => positions[index]?.index === latestIndex,
  );
};
