import { randomUUID } from "node:crypto";
import { dirname, extname, resolve } from "node:path";
import ts from "typescript";

import type { Definition, Scope, SourceInput, TypeSource } from "./scope.js";

export type ScopeInput = {
  input: SourceInput;
  imports: ReadonlyMap<string, TypeSource>;
  mutable: ReadonlyMap<string, Definition>;
  retained: ReadonlyMap<string, Definition>;
  prefix: string;
  sourceEnd: number;
};

export function bindScope(input: SourceInput, scope: Scope): ScopeInput {
  const names = sourceNames(ts.createSourceFile(input.fileName, input.source, ts.ScriptTarget.Latest, true));
  const imports = new Map<string, TypeSource>();
  const mutable = new Map<string, Definition>();
  const retained = new Map<string, Definition>();
  const prefix = `__bitagent_${randomUUID().replaceAll("-", "_")}_`;
  const declarations: string[] = [];
  for (const [name, binding] of scope) {
    if (!names.has(name)) continue;
    const { typeOnly, exportName, typeSource, setterExport } = binding;
    imports.set(typeSource.specifier, typeSource);
    retained.set(typeSource.specifier, binding);
    const specifier = JSON.stringify(typeSource.specifier);
    if (setterExport) {
      declarations.push(`declare let ${name}: typeof import(${specifier}).${exportName};`);
      mutable.set(name, binding);
    } else {
      declarations.push(`import ${typeOnly ? "type " : ""}{ ${exportName} as ${name} } from ${specifier};`);
    }
  }
  // A native import of the same path is a separate module, not a reference to this batch.
  const fileName = resolve(dirname(input.fileName), `${prefix}scope${extname(input.fileName)}`);
  return {
    input: { fileName, source: [input.source, "export {};", ...declarations].join("\n") },
    imports,
    mutable,
    retained,
    prefix,
    sourceEnd: input.source.length,
  };
}

function sourceNames(file: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node)) names.add(node.text);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return names;
}

export function mutableBindingTransforms(program: ts.Program, entry: ts.SourceFile, scope: ScopeInput): ts.CustomTransformers {
  const checker = program.getTypeChecker();
  const bindings = new Map<ts.Symbol, Definition>();
  for (const symbol of checker.getSymbolsInScope(entry, ts.SymbolFlags.Value)) {
    const binding = scope.mutable.get(symbol.name);
    if (binding) bindings.set(symbol, binding);
  }
  return {
    before: [rewriteMutableReferences(checker, bindings, scope)],
    after: [forwardMutableExports(checker, bindings, entry, scope.sourceEnd)],
  };
}

function rewriteMutableReferences(checker: ts.TypeChecker, bindings: ReadonlyMap<ts.Symbol, Definition>,
  scope: ScopeInput): ts.TransformerFactory<ts.SourceFile> {
  return (context) => (file) => {
    const { factory } = context;
    function isMutable(symbol: ts.Symbol | undefined): boolean {
      return symbol !== undefined && bindings.has(symbol);
    }
    function cell(name: string): ts.ElementAccessExpression {
      return factory.createElementAccessExpression(factory.createIdentifier(`${scope.prefix}cells`), factory.createStringLiteral(name));
    }
    function visit(node: ts.Node): ts.VisitResult<ts.Node> {
      if (ts.isExportDeclaration(node)) return node;
      if (ts.isShorthandPropertyAssignment(node) && isMutable(checker.getShorthandAssignmentValueSymbol(node))) {
        const target = cell(node.name.text);
        const fallback = ts.visitNode(node.objectAssignmentInitializer, visit, ts.isExpression);
        return factory.createPropertyAssignment(node.name, fallback ? factory.createAssignment(target, fallback) : target);
      }
      if (ts.isCallExpression(node) || ts.isTaggedTemplateExpression(node)) {
        const original = ts.isCallExpression(node) ? node.expression : node.tag;
        const callee = unwrapCallee(original);
        if (ts.isIdentifier(callee) && isMutable(checker.getSymbolAtLocation(callee))) {
          // Evaluating the cell as a value preserves the bare call's receiver.
          const detached = factory.createParenthesizedExpression(factory.createCommaListExpression([factory.createNumericLiteral(0), cell(callee.text)]));
          if (ts.isTaggedTemplateExpression(node)) {
            return factory.updateTaggedTemplateExpression(node, detached, node.typeArguments, ts.visitNode(node.template, visit, ts.isTemplateLiteral)!);
          }
          return factory.updateCallExpression(node, detached, node.typeArguments, ts.visitNodes(node.arguments, visit, ts.isExpression));
        }
      }
      if (ts.isIdentifier(node) && !ts.isPartOfTypeNode(node) && isMutable(checker.getSymbolAtLocation(node))) {
        return cell(node.text);
      }
      return ts.visitEachChild(node, visit, context);
    }
    // Only adopted user statements are rewritten; the suffix supplies checking-only declarations.
    return factory.updateSourceFile(file, file.statements.map((statement) => statement.getEnd() <= scope.sourceEnd
      ? ts.visitNode(statement, visit, ts.isStatement)!
      : statement));
  };
}

function forwardMutableExports(checker: ts.TypeChecker, bindings: ReadonlyMap<ts.Symbol, Definition>, entry: ts.SourceFile,
  sourceEnd: number): ts.TransformerFactory<ts.SourceFile> {
  return ({ factory }) => (file) => {
    function forward(node: ts.Statement): ts.VisitResult<ts.Statement> {
      if (!ts.isExportDeclaration(node) || node.moduleSpecifier || !node.exportClause || !ts.isNamedExports(node.exportClause)) {
        return node;
      }
      const origin = ts.getOriginalNode(node, ts.isExportDeclaration);
      if (!origin || origin.parent !== entry || origin.getEnd() > sourceEnd) return node;
      const local: ts.ExportSpecifier[] = [];
      const forwarded = new Map<string, ts.ExportSpecifier[]>();
      for (const specifier of node.exportClause.elements) {
        const original = ts.getOriginalNode(specifier, ts.isExportSpecifier);
        const symbol = original && original.parent === origin.exportClause ? checker.getExportSpecifierLocalTargetSymbol(original) : undefined;
        const binding = symbol && bindings.get(symbol);
        if (!binding) {
          local.push(specifier);
          continue;
        }
        const { typeSource, exportName } = binding;
        const alias = factory.createExportSpecifier(false, exportName, specifier.name);
        const aliases = forwarded.get(typeSource.specifier);
        if (aliases) aliases.push(alias);
        else forwarded.set(typeSource.specifier, [alias]);
      }
      if (!forwarded.size) return node;
      const declarations = local.length
        ? [factory.updateExportDeclaration(node, node.modifiers, node.isTypeOnly,
          factory.updateNamedExports(node.exportClause, local), node.moduleSpecifier, node.attributes)]
        : [];
      // Forward the live binding after TypeScript erases type-only exports.
      for (const [specifier, aliases] of forwarded) {
        declarations.push(factory.createExportDeclaration(undefined, false, factory.createNamedExports(aliases),
          factory.createStringLiteral(specifier)));
      }
      return declarations;
    }
    return factory.updateSourceFile(file, ts.visitNodes(file.statements, forward, ts.isStatement));
  };
}

function unwrapCallee(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression)
    || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)
    || ts.isSatisfiesExpression(expression) || ts.isExpressionWithTypeArguments(expression)) {
    expression = expression.expression;
  }
  return expression;
}
