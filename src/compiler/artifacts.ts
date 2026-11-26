import type { CompiledInput, Compiler, SourceInput } from "./types.js";
import type { ApplicationState, DefinitionSpec, DefinitionType, LiveBinding, StateSnapshot } from "../state/types.js";
import { CompilationError } from "./errors.js";

export interface SourceOrigin { readonly url: string; readonly text: string; }
export interface TypeRecord { readonly file: string; readonly declaration: string; readonly name: string; readonly files: Readonly<Record<string, string>>; readonly sourceOrigins: Readonly<Record<string, SourceOrigin>>; readonly ambientDeclarations:Readonly<Record<string,string>>; readonly ambientOrigins:Readonly<Record<string,SourceOrigin>>; }
export interface BindingDescription {
  readonly name: string; readonly kind: "value" | "type" | "value-type";
  readonly mutable: boolean; readonly display: string;
  readonly origins: readonly { readonly url: string; readonly start: number; readonly length: number }[];
}
export interface ExecutableModule {
  readonly url: string; readonly id: string; readonly code: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly exports: readonly string[];
}
export interface ExecutionBindings {
  readonly values?: Readonly<Record<string, { read(): unknown; write?(value: unknown): void }>>;
  readonly result?: () => unknown;
  readonly initialized?: readonly string[];
}
export interface Artifact {
  readonly compiler: Compiler; readonly snapshot: StateSnapshot;
  readonly specs: readonly DefinitionSpec[];
  readonly declaration: string; readonly declarationFile: string;
  readonly execute: (environment: { binding(id: string): { value: unknown } }, publish: (bindings: ExecutionBindings) => void) => unknown;
}
export const artifacts = new WeakMap<CompiledInput, Artifact>();
export const specifications = new WeakSet<DefinitionSpec>();
export const definitionTypes = new WeakMap<DefinitionType, TypeRecord>();
export const bindings = new WeakMap<LiveBinding, { readonly input: CompiledInput }>();
export const associations = new WeakMap<ApplicationState, { readonly compiler: Compiler; readonly root: object }>();
export const compilers = new WeakMap<Compiler, { adopt(input: SourceInput): SourceInput }>();
let serial = 1;
export function identity(prefix: string): string { return `${prefix}-${serial++}`; }
export function artifact(input: CompiledInput): Artifact {
  const result = artifacts.get(input);
  if (result === undefined) throw new TypeError("Expected an authentic compiled input");
  return result;
}
export function checkSnapshot(snapshot: StateSnapshot): void {
  if (snapshot.revision !== snapshot.state.revision) throw new CompilationError("stale", "State structure changed after preparation");
}
