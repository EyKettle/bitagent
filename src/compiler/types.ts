import type { Job } from "../runtime/types.js";
import type { ApplicationState, DefinitionSpec, StateChange, StateSnapshot } from "../state/types.js";

declare const compilerBrand: unique symbol;
declare const compilationBrand: unique symbol;
declare const preparedBrand: unique symbol;
declare const sessionBrand: unique symbol;

export type SourceInput =
  | { readonly kind: "text"; readonly url: URL; readonly text: string }
  | { readonly kind: "file"; readonly url: URL };
export interface SourceSpan {
  readonly url: string;
  readonly start: number;
  readonly length: number;
}
export type DiagnosticPhase = "source" | "syntax" | "type" | "contract";
export interface DiagnosticRelated {
  readonly message: string;
  readonly span?: SourceSpan;
}
export interface CompilationDiagnostic {
  readonly phase: DiagnosticPhase;
  readonly severity: "error" | "warning" | "message";
  readonly code: string;
  readonly message: string;
  readonly span?: SourceSpan;
  readonly related: readonly DiagnosticRelated[];
}
export interface SourceRecord {
  readonly url: string;
  readonly version: string;
  readonly text: string;
}
export interface ModuleVersion {
  readonly id: string;
  readonly url: string;
  readonly sourceVersion: string;
  readonly dependencies: readonly string[];
}
export interface CompiledInput {
  readonly [compilationBrand]: true;
  readonly id: string;
  readonly compiler: Compiler;
  readonly snapshot: StateSnapshot;
  readonly entry: string;
  readonly sources: readonly SourceRecord[];
  readonly modules: readonly ModuleVersion[];
  readonly definitions: readonly DefinitionSpec[];
  readonly diagnostics: readonly CompilationDiagnostic[];
}
export type CompilationResult =
  | { readonly kind: "compiled"; readonly input: CompiledInput }
  | { readonly kind: "diagnostics"; readonly diagnostics: readonly CompilationDiagnostic[] };
export type CompilerState = "open" | "closing" | "closed";
export type CompilationErrorKind =
  | "configuration" | "foreign" | "stale" | "used" | "closed" | "busy" | "module" | "invariant";
export interface Compiler {
  readonly [compilerBrand]: true;
  readonly state: CompilerState;
  readonly baseURL: string;
  compile(input: SourceInput, snapshot: StateSnapshot): Job<CompilationResult>;
  close(reason?: unknown): Promise<void>;
}
export type PreparedInputState = "ready" | "used" | "discarded";
export interface PreparedInput {
  readonly [preparedBrand]: true;
  readonly state: PreparedInputState;
  readonly compilation: CompiledInput;
}
export type PreparationResult =
  | { readonly kind: "ready"; readonly input: PreparedInput }
  | { readonly kind: "diagnostics"; readonly diagnostics: readonly CompilationDiagnostic[] };
export type InputExecution =
  | { readonly kind: "returned"; readonly value: unknown; readonly change: StateChange }
  | { readonly kind: "threw"; readonly error: unknown; readonly change: StateChange };
export interface CompilerSession {
  readonly [sessionBrand]: true;
  readonly state: CompilerState;
  readonly applicationState: ApplicationState;
  readonly compiler: Compiler;
  prepare(input: SourceInput): Job<PreparationResult>;
  execute(input: PreparedInput): InputExecution;
  discard(input: PreparedInput): boolean;
  close(reason?: unknown): Promise<void>;
}
