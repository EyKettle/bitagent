import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import ts from "typescript";

import { sourceSpecifier } from "./project.js";
import type { Project } from "./project.js";
import type { SourceInput, TypeSource } from "./scope.js";
import { workspaceTarget } from "./workspace.js";
import type { Resolutions } from "./workspace.js";

const require = createRequire(import.meta.url);
const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2024,
  lib: ["lib.esnext.d.ts"],
  types: ["node"],
  typeRoots: [dirname(dirname(require.resolve("@types/node/package.json")))],
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  customConditions: ["node", "node-addons", "module-sync"],
  moduleDetection: ts.ModuleDetectionKind.Force,
  allowImportingTsExtensions: true,
  rewriteRelativeImportExtensions: true,
  verbatimModuleSyntax: true,
  noUncheckedSideEffectImports: true,
  preserveConstEnums: true,
  allowJs: true,
  // Emit is captured in memory; a separate output path keeps JS inputs from colliding with their output.
  outDir: resolve(tmpdir(), `bitagent-emit-${randomUUID()}`),
  resolveJsonModule: true,
  strict: true,
  skipLibCheck: true,
};

export class Compilation {
  readonly #project: Project;
  readonly #diskSources = new Map<string, string | undefined>();

  constructor(project: Project) {
    this.#project = project;
  }

  program(input: SourceInput, imports?: ReadonlyMap<string, TypeSource>) {
    const fileName = resolve(input.fileName);
    const overlays = collectOverlays({ ...input, fileName }, imports);
    const host = ts.createCompilerHost(options);
    const readFile = host.readFile.bind(host);
    const fileExists = host.fileExists.bind(host);
    const workspaceFiles = new Set<string>([fileName]);
    const externalFiles = new Set<string>();
    const resolutions = new Map<string, Map<string, ts.ResolvedModuleWithFailedLookupLocations>>();
    const cache = ts.createModuleResolutionCache(host.getCurrentDirectory(), host.getCanonicalFileName, options);
    const isApplicationFile = (path: string) => overlays.has(path) || workspaceFiles.has(path)
      || (!externalFiles.has(path) && !path.split(sep).includes("node_modules"));
    host.readFile = (path) => {
      const source = overlays.get(path)?.source ?? this.#project.module(path)?.source;
      if (source !== undefined) return source;
      if (!this.#diskSources.has(path)) this.#diskSources.set(path, readFile(path));
      return this.#diskSources.get(path);
    };
    host.fileExists = (path) => overlays.has(path) || this.#project.module(path) !== undefined
      || (this.#diskSources.has(path) ? this.#diskSources.get(path) !== undefined : fileExists(path));
    host.resolveModuleNameLiterals = (literals, from, redirected, compilerOptions, source) => {
      const overlay = overlays.get(from);
      const applicationFile = isApplicationFile(from);
      if (applicationFile && !resolutions.has(from)) resolutions.set(from, new Map());
      return literals.map((literal) => {
        const name = literal.text;
        const retained = overlay?.imports?.get(name);
        if (retained) return { resolvedModule: { resolvedFileName: retained.fileName, extension: ts.Extension.Ts } };
        if (applicationFile && !this.#project.permits(name)) return { resolvedModule: undefined };
        const base = applicationFile ? this.#project.resolutionBase(name, from) : from;
        let result = (!overlay && this.#project.module(from)?.resolutions.get(name)) || ts.resolveModuleName(
          applicationFile ? sourceSpecifier(name) : name, base, compilerOptions, host, cache, redirected,
          ts.getModeForUsageLocation(source, literal, compilerOptions),
        );
        if (result.resolvedModule) {
          if (!applicationFile || result.resolvedModule.isExternalLibraryImport) {
            externalFiles.add(result.resolvedModule.resolvedFileName);
          } else if (workspaceTarget(result)) {
            const target = result.resolvedModule;
            const canonical = host.realpath?.(target.resolvedFileName) ?? target.resolvedFileName;
            if (canonical !== target.resolvedFileName) result = { ...result, resolvedModule: { ...target, resolvedFileName: canonical } };
            workspaceFiles.add(canonical);
          }
        }
        resolutions.get(from)?.set(name, result);
        return result;
      });
    };
    host.resolveTypeReferenceDirectiveReferences = (references, from, redirected, compilerOptions, source) =>
      references.map((reference) => {
        const name = typeof reference === "string" ? reference : reference.fileName;
        const issuer = from && isApplicationFile(from) ? this.#project.consoleFile : from;
        const mode = (typeof reference === "string" ? undefined : reference.resolutionMode) ?? source?.impliedNodeFormat;
        return ts.resolveTypeReferenceDirective(name, issuer, compilerOptions, host, redirected, undefined, mode);
      });
    const program = ts.createProgram([fileName], options, host);
    const entry = program.getSourceFile(fileName);
    if (!entry) throw new Error(`Compiler host did not supply ${fileName}`);
    return {
      program,
      entry,
      workspaces: [...workspaceFiles].filter((path) => path !== fileName),
      resolutions: (path: string): Resolutions => resolutions.get(path) ?? new Map(),
    };
  }
}

function collectOverlays(input: SourceInput, imports?: ReadonlyMap<string, TypeSource>) {
  const sources = new Map<string, SourceInput & { imports?: ReadonlyMap<string, TypeSource> }>();
  function add(input: SourceInput, imports?: ReadonlyMap<string, TypeSource>): void {
    if (sources.has(input.fileName)) return;
    sources.set(input.fileName, { ...input, imports });
    for (const dependency of imports?.values() ?? []) add(dependency, dependency.imports);
  }
  add(input, imports);
  return sources;
}

export function resolveComputedModule(specifier: string, from: string, project: Project): string | undefined {
  const result = ts.resolveModuleName(sourceSpecifier(specifier), project.resolutionBase(specifier, from), options, {
    ...ts.sys,
    fileExists: (fileName) => project.module(fileName) !== undefined || ts.sys.fileExists(fileName),
  });
  const target = workspaceTarget(result);
  return target && ts.sys.realpath?.(target) || target;
}
