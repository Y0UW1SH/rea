import type { JsonValue } from "../../domain/jsonValue.js";

/** The JSON Schema type names a tool argument may list. */
export type JsonSchemaTypeName =
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "array"
  | "null";

/** JSON Schema for a value inside a tool argument: a recorded value it must take, or a body's members and wrapping. */
export interface EnvironmentToolSchema {
  /** One type, or the list of types a strict replay body may take. */
  readonly type?:
    | "string"
    | "number"
    | "object"
    | "array"
    | readonly JsonSchemaTypeName[];
  readonly items?: EnvironmentToolSchema;
  readonly enum?: readonly string[];
  readonly const?: JsonValue;
  readonly properties?: Readonly<Record<string, EnvironmentToolSchema>>;
  readonly required?: readonly string[];
  readonly description?: string;
}

/** The serialized size of what a property's schema adds to a one-word type and its description, charged against the catalog budget like text. */
export const schemaBytes = (property: EnvironmentToolSchema): number => {
  const added = [
    Array.isArray(property.type) ? property.type : undefined,
    property.items,
    property.enum,
    property.const,
    property.properties,
    property.required,
  ];
  return added.every((part) => part === undefined)
    ? 0
    : 6 * JSON.stringify(added).length;
};
