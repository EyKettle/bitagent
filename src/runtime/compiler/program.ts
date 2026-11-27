import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import ts from "typescript";

import type { SourceInput, TypeSource } from "./scope.js";

const require = createRequire(import.meta.url);
const options: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2024,
  lib: ["lib.esnext.d.ts"],
  types: ["node"],
  typeRoots: [dirname(dirname(require.resolve("@types/node/package.json")))],
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  moduleDetection: ts.ModuleDetectionKind.Force,
  allowImportingTsExtensions: true,
  rewriteRelativeImportExtensions: true,
  preserveConstEnums: true,
  strict: true,
  skipLibCheck: true,
};

export function createProgram(input: SourceInput, imports: ReadonlyMap<string, TypeSource> = new Map(), oldProgram?: ts.Program) {
  const fileName = resolve(input.fileName);
  const sources = new Map<string, SourceInput & { imports: ReadonlyMap<string, TypeSource> }>();
  function add(input: SourceInput, imports: ReadonlyMap<string, TypeSource>): void {
    if (sources.has(input.fileName)) return;
    sources.set(input.fileName, { ...input, imports });
    for (const dependency of imports.values()) add(dependency, dependency.imports);
  }
  add({ ...input, fileName }, imports);

  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = (path) => sources.get(path)?.source ?? readFile(path);
  host.fileExists = (path) => sources.has(path) || fileExists(path);
  const cache = ts.createModuleResolutionCache(host.getCurrentDirectory(), host.getCanonicalFileName, options);
  host.resolveModuleNameLiterals = (literals, relativeTo, redirected, options, from) => literals.map((literal) => {
    const scoped = sources.get(relativeTo)?.imports.get(literal.text);
    if (scoped) return { resolvedModule: { resolvedFileName: scoped.fileName, extension: ts.Extension.Ts } };
    return ts.resolveModuleName(literal.text, relativeTo, options, host, cache, redirected,
      ts.getModeForUsageLocation(from, literal, options));
  });
  const program = ts.createProgram({ rootNames: [fileName], options, host, oldProgram });
  const entry = program.getSourceFile(fileName);
  if (!entry) throw new Error(`Compiler host did not supply ${fileName}`);
  return { program, entry };
}
