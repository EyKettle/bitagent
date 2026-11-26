import { generatedContract } from "./contracts.js";
import type { ContractIssue, DataShape, JsonSchema } from "./contracts.js";
import type { Coroutine } from "./protocol.js";
export type ToolArguments = { readonly kind: "parsed"; readonly value: unknown } | { readonly kind: "invalid"; readonly text: string; readonly issues: readonly ContractIssue[] };
export interface ToolCall { readonly id: string; readonly name: string; readonly arguments: ToolArguments; }
export interface ToolDefinition { readonly name: string; readonly description?: string; readonly parameters: JsonSchema; readonly result: JsonSchema; }
const toolBrand: unique symbol = Symbol("Tool");
export interface ToolHandle { readonly [toolBrand]: true; readonly definition: ToolDefinition; matches(call: ToolCall): boolean; }
export interface Tool<P extends object, R = void> extends ToolHandle { parse(call: ToolCall): P; read(receipt: unknown): R; }
export interface ToolOptions { readonly description?: string; }
export type ToolHandler<P extends object, R = void> = ((props: P) => R | Coroutine<R>) & ([Extract<R, PromiseLike<unknown>>] extends [never] ? unknown : never);
export interface ToolArtifact { readonly parameters: DataShape; readonly result: DataShape; readonly description?: string; }
/** Concrete tool data and description artifacts are supplied by the same compiler program. */
export function tool<P extends object, R = void>(_name: string, _handler: ToolHandler<P,R>, _options?: ToolOptions): Tool<P,R> { throw new TypeError("tool requires a generated concrete artifact"); }
export function generatedTool(name: string, handler: unknown, options: ToolOptions | undefined, artifact: ToolArtifact): Tool<object,unknown> {
  if(typeof name!=="string"||!name||typeof handler!=="function")throw new TypeError("Tool requires a name and callable handler");
  if(options!==undefined&&(!options||typeof options!=="object"||Object.keys(options).some(k=>k!=="description")||options.description!==undefined&&typeof options.description!=="string"))throw new TypeError("Invalid tool description options");
  const parameters=generatedContract<object>(artifact.parameters),result=generatedContract(artifact.result),description=options?.description??artifact.description;
  const definition=Object.freeze({name,parameters:parameters.schema,result:result.schema,...(description?{description}:{})});
  return Object.freeze({[toolBrand]:true as const,definition,matches(call:ToolCall){return call.name===name;},parse(call:ToolCall){if(call.name!==name||call.arguments.kind!=="parsed")throw new TypeError("Tool call does not match this declaration");return parameters.parse(call.arguments.value);},read(_receipt:unknown):unknown{throw new TypeError("Expected an authenticated execution receipt");}});
}
