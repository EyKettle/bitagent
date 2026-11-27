import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import ts from "typescript";

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
  strict: true,
  skipLibCheck: true,
};

export type SourceInput = { fileName: string; source: string };

export function createProgram(input: SourceInput): { program: ts.Program; entry: ts.SourceFile } {
  const fileName = resolve(input.fileName);
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = (path) => path === fileName ? input.source : readFile(path);
  host.fileExists = (path) => path === fileName || fileExists(path);
  const program = ts.createProgram([fileName], options, host);
  const entry = program.getSourceFile(fileName);
  if (!entry) throw new Error(`Compiler host did not supply ${fileName}`);
  return { program, entry };
}
