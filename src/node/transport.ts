import type { FixedGlobalNominal, GlobalNominal } from "./global-nominals.js";
import type { GlobalTypeContext } from "./global-types.js";
import type { BindingDescription, SourceOrigin } from "../compiler/artifacts.js";
import type { CompilationDiagnostic, ModuleVersion, SourceRecord } from "../compiler/types.js";
export type GeneratorName = "contract" | "defineFunction" | "tool";
export interface CompileRequest {
  readonly id: number; readonly entry: string; readonly text?: string;
  readonly statePrelude: string;
  readonly declarationFiles: Readonly<Record<string, string>>;
  readonly declarationOrigins: Readonly<Record<string, SourceOrigin>>;
  readonly globalNominals: readonly FixedGlobalNominal[];
  readonly activeDeclarations: readonly string[];
  readonly ambientDeclarations:Readonly<Record<string,string>>;
  readonly ambientOrigins:Readonly<Record<string,SourceOrigin>>;
  readonly externalDefinitions: readonly { readonly name: string; readonly id: string; readonly mutable: boolean; readonly generator?:GeneratorName }[];
  readonly base: string;
  readonly cachedModules: readonly CachedModule[];
  readonly cachedDeclarations: readonly CachedDeclaration[];
  readonly libraryFiles: Readonly<Record<string,string>>;
}
export interface EmittedModule { readonly generatorAliases:Readonly<Record<string,GeneratorName>>; readonly url: string; readonly fingerprint: string; readonly code: string; readonly exports: readonly string[]; readonly dependencies: Readonly<Record<string, string>>; readonly externalIDs:readonly string[]; readonly declarationDependencies:Readonly<Record<string,string>>; readonly helpers: {readonly environment:string;readonly generated:string;readonly capture:string;readonly display:string;readonly acquire:string}; }
export interface CachedModule {
 readonly module: EmittedModule; readonly file: string; readonly files: Readonly<Record<string,string>>; readonly sourceOrigins:Readonly<Record<string,SourceOrigin>>;
}
export interface CachedDeclaration { readonly source:string; readonly fingerprint:string; readonly file:string; readonly files:Readonly<Record<string,string>>; readonly sourceOrigins:Readonly<Record<string,SourceOrigin>>; }
export interface CompileResponse {
  readonly globalNominals: readonly GlobalNominal[];
  readonly globalTypeContext:GlobalTypeContext;
  readonly id: number; readonly diagnostics: readonly CompilationDiagnostic[];
  readonly sources: readonly SourceRecord[]; readonly modules: readonly EmittedModule[];
  readonly definitions: readonly BindingDescription[]; readonly declaration: string; readonly declarationFile: string;
  readonly declarationFingerprints:Readonly<Record<string,string>>;
  readonly entry: string; readonly declarations: Readonly<Record<string, string>>;
  readonly declarationImages: Readonly<Record<string,string>>;
  readonly resolutions: Readonly<Record<string,Readonly<Record<string,string>>>>;
  readonly libraryFiles: Readonly<Record<string,string>>;
}
