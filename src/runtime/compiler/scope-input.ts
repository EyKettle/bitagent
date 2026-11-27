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

export function rewriteMutableBindings(program: ts.Program, entry: ts.SourceFile, scope: ScopeInput): ts.TransformerFactory<ts.SourceFile> {
  const checker = program.getTypeChecker();
  const symbols = new Set(checker.getSymbolsInScope(entry, ts.SymbolFlags.Value).filter(({ name }) => scope.mutable.has(name)));
  const { factory } = ts;
  return (context) => (file) => {
    function isMutable(symbol: ts.Symbol | undefined): boolean {
      return symbol !== undefined && symbols.has(symbol);
    }
    function cell(name: string): ts.ElementAccessExpression {
      return factory.createElementAccessExpression(factory.createIdentifier(`${scope.prefix}cells`), factory.createStringLiteral(name));
    }
    function visit(node: ts.Node): ts.VisitResult<ts.Node> {
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

function unwrapCallee(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression) || ts.isNonNullExpression(expression)
    || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)
    || ts.isSatisfiesExpression(expression) || ts.isExpressionWithTypeArguments(expression)) {
    expression = expression.expression;
  }
  return expression;
}
