import path from "node:path";
import ts from "typescript";

export const globalContextModule = "__bitagent_adopted_global_types__";
export interface GlobalTypeContext {
  readonly fingerprint: string;
  readonly declaration: string;
  readonly ambientDeclarations: Readonly<Record<string, string>>;
}

/** The checker owns symbol identity; emitted declarations own their fixed representation. */
export function captureGlobalTypes(
  program: ts.Program,
  checker: ts.TypeChecker,
  contextIdentity: string,
  sourceFiles: readonly string[],
  originalFiles: ReadonlyMap<string, string>,
) {
  const globalSymbols = new Map<ts.Symbol, string>();
  const ambientSources = new Set<string>();
  const declarationScopes = new WeakMap<ts.Node, ts.Node>();
  const symbolOf = (node: ts.Node): ts.Symbol | undefined => {
    const original = ts.getOriginalNode(node);
    const symbol = checker.getSymbolAtLocation(original) ?? (ts.isIdentifier(node) && declarationScopes.has(node)
      ? checker.resolveName(node.text, declarationScopes.get(node), ts.SymbolFlags.Type | ts.SymbolFlags.Value | ts.SymbolFlags.Namespace, false) : undefined);
    return symbol && checker.getExportSymbolOfSymbol(symbol);
  };
  for (const file of sourceFiles) {
    const source = program.getSourceFile(file);
    if (!source || program.isSourceFileDefaultLibrary(source)) continue;
    const collect = (statement: ts.Statement) => {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            const symbol = symbolOf(declaration.name);
            if (symbol) globalSymbols.set(symbol, declaration.name.text);
          }
        }
      } else if ("name" in statement && statement.name && ts.isIdentifier(statement.name as ts.Node)) {
        const name = statement.name as ts.Identifier;
        const symbol = symbolOf(name);
        if (symbol) globalSymbols.set(symbol, name.text);
      }
    };
    const visit = (node: ts.Node): void => {
      if (ts.isModuleDeclaration(node) && node.flags & ts.NodeFlags.GlobalAugmentation && node.body && ts.isModuleBlock(node.body)) {
        ambientSources.add(file);
        node.body.statements.forEach(collect);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (source.isDeclarationFile && !ts.isExternalModule(source)) {
      ambientSources.add(file);
      source.statements.forEach(collect);
    }
  }
  const raw = new Map<string, ts.SourceFile>();
  const printer = ts.createPrinter();
  const factory = ts.factory;
  const qualifier = (name: ts.EntityName, namespace: string): ts.EntityName => {
    if (ts.isQualifiedName(name)) return factory.updateQualifiedName(name, qualifier(name.left, namespace), name.right);
    return globalSymbols.has(symbolOf(name)!) && !isName(name)
      ? factory.createQualifiedName(factory.createIdentifier(namespace), factory.createIdentifier(name.text)) : name;
  };
  const isName = (node: ts.Identifier): boolean => {
    const original = ts.getOriginalNode(node), parent = original.parent;
    return !!parent && "name" in parent && parent.name === original && !ts.isTypeReferenceNode(parent) && !ts.isTypeQueryNode(parent);
  };
  const transform: ts.TransformerFactory<ts.SourceFile | ts.Bundle> = context => root => {
    if (ts.isBundle(root)) return root;
    const source = program.getSourceFile(root.fileName)!;
    const occupied = new Set<string>();
    const bindScopes = (node: ts.Node, scope: ts.Node): void => {
      const original = ts.getOriginalNode(node);
      const location = original.parent && original.getSourceFile() === source ? original : scope;
      declarationScopes.set(node, location);
      if (ts.isIdentifier(node)) occupied.add(node.text);
      ts.forEachChild(node, child => bindScopes(child, location));
    };
    bindScopes(root, source);
    let namespace = "__bitagentFixedGlobals";
    while (occupied.has(namespace)) namespace += "_";
    raw.set(root.fileName, root);
    let used = false;
    const visit: ts.Visitor = node => {
      if (ts.isModuleDeclaration(node) && node.flags & ts.NodeFlags.GlobalAugmentation) return undefined;
      if (ts.isTypeReferenceNode(node)) {
        const name = qualifier(node.typeName, namespace); if (name !== node.typeName) used = true;
        return factory.updateTypeReferenceNode(node, name, ts.visitNodes(node.typeArguments, visit, ts.isTypeNode));
      }
      if (ts.isTypeQueryNode(node)) {
        const name = qualifier(node.exprName, namespace); if (name !== node.exprName) used = true;
        return factory.updateTypeQueryNode(node, name, ts.visitNodes(node.typeArguments, visit, ts.isTypeNode));
      }
      if (ts.isExpressionWithTypeArguments(node)) {
        let expression = node.expression;
        if (ts.isIdentifier(expression) && globalSymbols.has(symbolOf(expression)!)) {
          expression = factory.createPropertyAccessExpression(factory.createIdentifier(namespace), expression.text); used = true;
        }
        return factory.updateExpressionWithTypeArguments(node, expression, ts.visitNodes(node.typeArguments, visit, ts.isTypeNode));
      }
      return ts.visitEachChild(node, visit, context);
    };
    const transformed = source.isDeclarationFile && !ts.isExternalModule(source)
      ? factory.updateSourceFile(root, [factory.createExportDeclaration(undefined, false, factory.createNamedExports([]))])
      : ts.visitEachChild(root, visit, context);
    return used ? factory.updateSourceFile(transformed, [
      factory.createImportDeclaration(undefined, factory.createImportClause(true, undefined, factory.createNamespaceImport(factory.createIdentifier(namespace))), factory.createStringLiteral(globalContextModule)),
      ...transformed.statements,
    ]) : transformed;
  };

  function snapshot(): GlobalTypeContext {
    const ambientDeclarations: Record<string, string> = {};
    for (const file of ambientSources) {
      const source = raw.get(file) ?? program.getSourceFile(file)!;
      const original = ts.createSourceFile(file, originalFiles.get(file) ?? source.text, ts.ScriptTarget.ES2022, true);
      if (source.isDeclarationFile && !ts.isExternalModule(original)) ambientDeclarations[file] = printer.printFile(original);
      else {
        const imports = original.statements.filter(ts.isImportDeclaration);
        const globals = original.statements.filter(statement => ts.isModuleDeclaration(statement) && statement.flags & ts.NodeFlags.GlobalAugmentation);
        const fixed = source.statements.filter(statement => !ts.isImportDeclaration(statement) && !(ts.isModuleDeclaration(statement) && statement.flags & ts.NodeFlags.GlobalAugmentation));
        ambientDeclarations[file] = printer.printFile(factory.updateSourceFile(source, [...imports, ...fixed, ...globals]));
      }
    }
    if (!globalSymbols.size) return { fingerprint: contextIdentity, declaration: "export {};\n", ambientDeclarations };
    const statements = new Map<ts.Symbol, ts.Statement[]>();
    const allStatements: ts.Statement[] = [];
    const add = (statement: ts.Statement) => {
      const declaration = ts.getOriginalNode(statement);
      let names: ts.Identifier[] = [];
      if (ts.isVariableStatement(statement)) names = statement.declarationList.declarations.flatMap(d => ts.isIdentifier(d.name) ? [d.name] : []);
      else if ("name" in statement && statement.name && ts.isIdentifier(statement.name as ts.Node)) names = [statement.name as ts.Identifier];
      for (const name of names) {
        const symbol = symbolOf(name); if (!symbol) continue;
        const list = statements.get(symbol) ?? []; if (!list.includes(statement)) list.push(statement); statements.set(symbol, list);
      }
      allStatements.push(statement);
      void declaration;
    };
    for (const file of program.getSourceFiles()) {
      const source = raw.get(file.fileName) ?? (file.isDeclarationFile ? file : undefined);
      if (!source) continue;
      const collect = (node: ts.Node): void => {
        if (ts.isModuleDeclaration(node) && node.flags & ts.NodeFlags.GlobalAugmentation && node.body && ts.isModuleBlock(node.body)) node.body.statements.forEach(add);
        else if (ts.isSourceFile(node)) node.statements.forEach(statement => {
          if (ts.isModuleDeclaration(statement) && statement.flags & ts.NodeFlags.GlobalAugmentation) collect(statement);
          else add(statement);
        });
      };
      collect(source);
    }
    const imports = new Map<string, string>();
    const localNames = new Map<ts.Symbol, string>();
    for (const [symbol, name] of globalSymbols) localNames.set(symbol, name);
    const pending = [...globalSymbols.keys()];
    const originImport = (file: string): string => {
      let alias = imports.get(file); if (!alias) { alias = "__bitagentOrigin" + imports.size; imports.set(file, alias); }
      return alias;
    };
    const exports: ts.Statement[] = [];
    const emitted = new Set<ts.Statement>();
    let localSerial = 0;
    const reference = (name: ts.Identifier): ts.EntityName => {
      let symbol = symbolOf(name); if (!symbol) return name;
      if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const local = localNames.get(symbol); if (local) return factory.createIdentifier(local);
      const declaration = symbol.declarations?.[0];
      if (!declaration || program.isSourceFileDefaultLibrary(declaration.getSourceFile())) return name;
      const source = declaration.getSourceFile();
      if (ts.isSourceFile(declaration)) return factory.createIdentifier(originImport(source.fileName));
      const module = checker.getSymbolAtLocation(source);
      if (module && checker.getExportsOfModule(module).some(exported => {
        const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
        return target === symbol;
      })) {
        return factory.createQualifiedName(factory.createIdentifier(originImport(source.fileName)), factory.createIdentifier(symbol.name));
      }
      if (statements.has(symbol)) {
        const name = "__bitagentLocal" + localSerial++; localNames.set(symbol, name); pending.push(symbol); return factory.createIdentifier(name);
      }
      return name;
    };
    const entity = (name: ts.EntityName): ts.EntityName => ts.isQualifiedName(name)
      ? factory.updateQualifiedName(name, entity(name.left), name.right) : reference(name);
    const expressionOf = (name:ts.EntityName):ts.Expression => ts.isIdentifier(name) ? factory.createIdentifier(name.text) : factory.createPropertyAccessExpression(expressionOf(name.left),name.right.text);
    for (let index = 0; index < pending.length; index++) {
      const symbol = pending[index]!;
      for (const statement of statements.get(symbol) ?? []) {
        if (emitted.has(statement)) continue; emitted.add(statement);
        const result = ts.transform(statement, [context => root => {
          const visit: ts.Visitor = node => {
            if (ts.isNumericLiteral(node)) return factory.createNumericLiteral(node.text);
            if (ts.isStringLiteral(node)) return factory.createStringLiteral(node.text);
            if (ts.isBigIntLiteral(node)) return factory.createBigIntLiteral(node.text);
            if (ts.isNoSubstitutionTemplateLiteral(node)) return factory.createNoSubstitutionTemplateLiteral(node.text);
            if (ts.isImportEqualsDeclaration(node) && !ts.isExternalModuleReference(node.moduleReference)) return factory.updateImportEqualsDeclaration(node, node.modifiers, node.isTypeOnly, node.name, entity(node.moduleReference));
            if (ts.isTypeReferenceNode(node)) return factory.updateTypeReferenceNode(node, entity(node.typeName), ts.visitNodes(node.typeArguments, visit, ts.isTypeNode));
            if (ts.isTypeQueryNode(node)) return factory.updateTypeQueryNode(node, entity(node.exprName), ts.visitNodes(node.typeArguments, visit, ts.isTypeNode));
            if (ts.isExpressionWithTypeArguments(node)) {
              const name = ts.isIdentifier(node.expression) ? reference(node.expression) : undefined;
              const expression = name ? expressionOf(name) : node.expression;
              return factory.updateExpressionWithTypeArguments(node, expression, ts.visitNodes(node.typeArguments, visit, ts.isTypeNode));
            }
            if (ts.isIdentifier(node) && isName(node)) {
              const local = localNames.get(symbolOf(node)!); return local ? factory.createIdentifier(local) : node;
            }
            return ts.visitEachChild(node, visit, context);
          };
          const transformed = ts.visitNode(root, visit, ts.isStatement)!;
          if (!ts.canHaveModifiers(transformed)) return transformed;
          const modifiers = (ts.getModifiers(transformed) ?? []).filter(modifier => modifier.kind !== ts.SyntaxKind.ExportKeyword && modifier.kind !== ts.SyntaxKind.DefaultKeyword);
          return factory.replaceModifiers(transformed, [factory.createModifier(ts.SyntaxKind.ExportKeyword), ...modifiers]);
        }]);
        exports.push(result.transformed[0]!); result.dispose();
      }
    }
    const importStatements = [...imports].map(([file, alias]) => factory.createImportDeclaration(undefined,
      factory.createImportClause(false, undefined, factory.createNamespaceImport(factory.createIdentifier(alias))),
      factory.createStringLiteral(file)));
    const source = factory.updateSourceFile(ts.createSourceFile(path.join("/", "global.d.ts"), "", ts.ScriptTarget.ES2022, true), [...importStatements, ...exports]);
    return { fingerprint: contextIdentity, declaration: printer.printFile(source), ambientDeclarations };
  }
  const localizeDeclaration = (source:ts.SourceFile):string => {const result=ts.transform(source,[transform]);const text=printer.printFile(result.transformed[0] as ts.SourceFile);result.dispose();return text;};
  return { transform, snapshot, localizeDeclaration };
}
