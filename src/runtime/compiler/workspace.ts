import ts from "typescript";

import type { SourceInput } from "./scope.js";

export type Resolutions = ReadonlyMap<string, ts.ResolvedModuleWithFailedLookupLocations>;

export type CompiledModule = SourceInput & {
  code: string;
  resolutions: Resolutions;
};

export function isModuleSource(fileName: string): boolean {
  return /\.(?:[m]?ts|[m]?js)$/u.test(fileName) && !/\.d\.(?:ts|mts)$/u.test(fileName);
}

export function workspaceTarget(resolution: ts.ResolvedModuleWithFailedLookupLocations | undefined): string | undefined {
  const target = resolution?.resolvedModule;
  return target && !target.isExternalLibraryImport && isModuleSource(target.resolvedFileName)
    ? target.resolvedFileName
    : undefined;
}

export function emitModule(program: ts.Program, file: ts.SourceFile, resolutions: Resolutions,
  before: readonly ts.TransformerFactory<ts.SourceFile>[] = []): {
  module: CompiledModule | undefined;
  diagnostics: readonly ts.Diagnostic[];
} {
  let code: string | undefined;
  const result = program.emit(file, (path, text) => {
    if (/\.(?:js|mjs)$/u.test(path)) code = text;
  }, undefined, false, { before: [...before], after: [keepModuleSpecifiers] });
  return {
    module: !result.emitSkipped && code !== undefined
      ? { fileName: file.fileName, source: file.text, code, resolutions }
      : undefined,
    diagnostics: result.diagnostics,
  };
}

// Node loads the checked in-memory sources, so the original specifiers are the graph keys.
const keepModuleSpecifiers: ts.TransformerFactory<ts.SourceFile> = (context) => (file) => {
  const { factory } = context;
  function original(node: ts.Expression): ts.Expression {
    const initial = ts.getOriginalNode(node);
    return ts.isStringLiteralLike(initial) ? initial : node;
  }
  function visit(node: ts.Node): ts.VisitResult<ts.Node> {
    if (ts.isImportDeclaration(node)) {
      return factory.updateImportDeclaration(node, node.modifiers, node.importClause, original(node.moduleSpecifier), node.attributes);
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      return factory.updateExportDeclaration(node, node.modifiers, node.isTypeOnly, node.exportClause,
        original(node.moduleSpecifier), node.attributes);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length) {
      const args = ts.visitNodes(node.arguments, visit, ts.isExpression);
      return factory.updateCallExpression(node, node.expression, node.typeArguments, [original(args[0]), ...args.slice(1)]);
    }
    return ts.visitEachChild(node, visit, context);
  }
  return ts.visitNode(file, visit, ts.isSourceFile) ?? file;
};
