import { freezeRecord } from "./records.js";
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonSchema = Readonly<Record<string, JsonValue>>;
export interface ContractIssue { readonly path: readonly (string | number)[]; readonly message: string; }
export class ContractError extends TypeError {
  readonly issues: readonly ContractIssue[];
  constructor(issues: readonly ContractIssue[]) {
    super(issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`).join("; "));
    this.name = "ContractError";
    this.issues = Object.freeze(issues.map((issue) => Object.freeze({ path: Object.freeze([...issue.path]), message: issue.message })));
  }
}
const contractBrand: unique symbol = Symbol("Contract");
export interface Contract<T> { readonly [contractBrand]: (value: T) => T; readonly schema: JsonSchema; parse(value: unknown): T; }
export interface DataShape {
  readonly kind: "string" | "number" | "boolean" | "null" | "unit" | "literal" | "array" | "tuple" | "object" | "union" | "ref";
  readonly value?: string | number | boolean;
  readonly items?: readonly DataShape[];
  readonly tupleFlags?: readonly ("required" | "optional" | "rest")[];
  readonly properties?: Readonly<Record<string, { readonly shape: DataShape; readonly optional: boolean; readonly description?: string }>>;
  readonly additional?: DataShape;
  readonly ref?: string;
  readonly definitions?: Readonly<Record<string, DataShape>>;
  readonly description?: string;
}
function projection(shape: DataShape): JsonSchema {
  const metadata = shape.description ? { description: shape.description } : {};
  switch (shape.kind) {
    case "unit": case "null": return { type: "null", ...metadata };
    case "string": case "number": case "boolean": return { type: shape.kind, ...metadata };
    case "literal": return { const: shape.value!, ...metadata };
    case "ref": return { $ref: `#/$defs/${shape.ref}` };
    case "union": return { anyOf: shape.items!.map(projection), ...metadata };
    case "array": return { type: "array", items: projection(shape.items![0]!), ...metadata };
    case "tuple": {
      const flags=shape.tupleFlags??shape.items!.map(()=>"required");const rest=flags.indexOf("rest"),minimum=flags.filter(flag=>flag==="required").length;
      return {type:"array",prefixItems:shape.items!.slice(0,rest<0?shape.items!.length:rest).map(projection),minItems:minimum,...(rest<0?{maxItems:flags.length,items:false}:{items:projection(shape.items![rest]!)}),...metadata};
    }
    case "object": return { type: "object", properties: Object.fromEntries(Object.entries(shape.properties!).map(([key, property]) => [key, { ...projection(property.shape), ...(property.description ? { description: property.description } : {}) }])), required: Object.entries(shape.properties!).filter(([, property]) => !property.optional).map(([key]) => key), additionalProperties: shape.additional === undefined ? false : projection(shape.additional), ...metadata };
  }
}
function adopt(shape: DataShape, value: unknown, path: readonly (string | number)[], active: Set<object>, definitions: Readonly<Record<string, DataShape>>): unknown {
  const reject = (message: string): never => { throw new ContractError([{ path, message }]); };
  if (shape.kind === "ref") return adopt(definitions[shape.ref!]!, value, path, active, definitions);
  if (shape.kind === "union") {
    for (const item of shape.items!) { try { return adopt(item, value, path, active, definitions); } catch (error) { if (!(error instanceof ContractError)) throw error; } }
    return reject("Value matches no union member");
  }
  if (shape.kind === "unit") { if (value === null || value === undefined) return undefined; return reject("Expected a unit result"); }
  if (shape.kind === "literal") { if (value === shape.value) return value; return reject(`Expected ${String(shape.value)}`); }
  if (shape.kind === "null") { if (value === null) return value; return reject("Expected null"); }
  if (shape.kind === "string" || shape.kind === "number" || shape.kind === "boolean") {
    if (typeof value !== shape.kind || (typeof value === "number" && !Number.isFinite(value))) return reject(`Expected finite ${shape.kind}`); return value;
  }
  if (value === null || typeof value !== "object") return reject("Expected a data container");
  if (active.has(value)) return reject("Cyclic data is not permitted");
  if (Object.getOwnPropertySymbols(value).length !== 0) return reject("Symbol properties are not data");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((d) => !Object.hasOwn(d, "value"))) return reject("Accessors are not data");
  const array = Array.isArray(value);
  if (array ? Object.getPrototypeOf(value) !== Array.prototype : Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return reject("Custom prototypes are not data");
  active.add(value);
  try {
    if (shape.kind === "array" || shape.kind === "tuple") {
      if (!array) return reject("Expected an array");
      const flags=shape.tupleFlags??shape.items!.map(()=>"required"),rest=shape.kind==="tuple"?flags.indexOf("rest"):-1;
      if(shape.kind==="tuple"&&(value.length<flags.filter(flag=>flag==="required").length || rest<0&&value.length>flags.length))return reject("Tuple length differs");
      if (Object.keys(descriptors).some((key) => key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length))) return reject("Array has extra properties");
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index++) { if (!Object.hasOwn(descriptors, index)) return reject("Sparse arrays are not data"); const position=shape.kind==="array"?0:rest<0||index<rest?index:index>=value.length-(flags.length-rest-1)?flags.length-(value.length-index):rest;result.push(adopt(shape.items![position]!, descriptors[index]!.value, [...path, index], active, definitions)); }
      return result;
    }
    if (array) return reject("Expected an object");
    const properties = shape.properties!, result: Record<string, unknown> = {};
    const issues: ContractIssue[] = [];
    for (const [key, property] of Object.entries(properties)) {
      const descriptor = descriptors[key];
      if (descriptor === undefined) { if (!property.optional) issues.push({ path: [...path, key], message: "Required property is missing" }); continue; }
      try { Object.defineProperty(result, key, { value: adopt(property.shape, descriptor.value, [...path, key], active, definitions), enumerable: true, writable: true, configurable: true }); } catch (error) { if (!(error instanceof ContractError)) throw error; issues.push(...error.issues); }
    }
    for (const [key, descriptor] of Object.entries(descriptors)) if (!Object.hasOwn(properties, key)) {
      if (shape.additional === undefined) issues.push({ path: [...path, key], message: "Undeclared property" });
      else try { Object.defineProperty(result, key, { value: adopt(shape.additional, descriptor.value, [...path, key], active, definitions), enumerable: true, writable: true, configurable: true }); } catch (error) { if (!(error instanceof ContractError)) throw error; issues.push(...error.issues); }
    }
    if (issues.length > 0) throw new ContractError(issues); return result;
  } finally { active.delete(value); }
}
export function generatedContract<T>(shape: DataShape): Contract<T> {
  const schema = freezeRecord({ ...projection(shape), ...(shape.definitions ? { $defs: Object.fromEntries(Object.entries(shape.definitions).map(([key, entry]) => [key, projection(entry)])) } : {}) });
  return Object.freeze({ schema, parse(value: unknown): T { return adopt(shape, value, [], new Set(), shape.definitions ?? {}) as T; } }) as Contract<T>;
}
/** The compiler replaces a concrete call with an authenticated generated construction. */
export function contract<T>(): Contract<T> { throw new TypeError("contract requires a generated concrete type artifact"); }
