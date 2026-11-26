import {pathToFileURL} from "node:url";
import ts from "typescript";
import type { SourceOrigin } from "../compiler/artifacts.js";

export interface GlobalNominal {
  readonly name: string;
  readonly kind: "constant" | "class" | "enum" | "namespace";
  readonly fingerprint: string;
}
export interface FixedGlobalNominal extends GlobalNominal {
  readonly file: string;
}

/** Nominal reuse is justified by the adopted declaration, not its surrounding global context. */
export function globalNominals(
  files: readonly string[],
  captured: ReadonlyMap<string, string>,
  origins: Readonly<Record<string, SourceOrigin>>,
  graph: ReadonlyMap<string, ReadonlyMap<string, string>>,
) {
  const declarations = new Map<string, { source: string; node: ts.Declaration; kind?: GlobalNominal["kind"] }[]>();
  const parsed = new Map<string, ts.SourceFile>();
  const containsNominal = (node: ts.Node): boolean => {
    if (ts.isClassDeclaration(node) || ts.isEnumDeclaration(node) || ts.isVariableDeclaration(node) && node.type && ts.isTypeOperatorNode(node.type) && node.type.operator === ts.SyntaxKind.UniqueKeyword) return true;
    return !!ts.forEachChild(node, containsNominal);
  };
  for (const file of files) {
    const origin = origins[file];
    const source = origin?.url ?? pathToFileURL(file).href;
    const syntax = ts.createSourceFile(file, origin?.text ?? captured.get(file) ?? "", ts.ScriptTarget.ES2022, true);
    parsed.set(file, syntax);
    const collect = (statement: ts.Statement): void => {
      const add = (name: string, node: ts.Declaration, kind?: GlobalNominal["kind"]) => {
        const list = declarations.get(name) ?? [];
        const text = node.getText(syntax);
        if (!list.some(item => item.source === source && item.node.getText(item.node.getSourceFile()) === text)) list.push({ source, node, ...(kind ? { kind } : {}) });
        declarations.set(name, list);
      };
      if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const unique = declaration.type && ts.isTypeOperatorNode(declaration.type) && declaration.type.operator === ts.SyntaxKind.UniqueKeyword;
        add(declaration.name.text, declaration, unique ? "constant" : undefined);
      }
      else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isModuleDeclaration(statement)) && statement.name && ts.isIdentifier(statement.name)) {
        add(statement.name.text, statement, ts.isClassDeclaration(statement) ? "class" : ts.isEnumDeclaration(statement) ? "enum" : ts.isModuleDeclaration(statement) && containsNominal(statement) ? "namespace" : undefined);
      }
    };
    const visit = (node: ts.Node): void => {
      if (ts.isModuleDeclaration(node) && node.flags & ts.NodeFlags.GlobalAugmentation && node.body && ts.isModuleBlock(node.body)) node.body.statements.forEach(collect);
      ts.forEachChild(node, visit);
    };
    visit(syntax);
    if (/\.d\.[cm]?ts$/.test(file) && !ts.isExternalModule(syntax)) syntax.statements.forEach(collect);
  }
  const descriptors: GlobalNominal[] = [];
  for (const [name, entries] of declarations) {
    const kind = entries.find(item => item.kind)?.kind; if (!kind) continue;
    const reachable = new Set<string>();
    const imported = new Set<string>();
    const visitName = (name: string): void => {
      if (reachable.has(name)) return; reachable.add(name);
      for (const item of declarations.get(name) ?? []) {
        const reference = (node: ts.Node, typeScope: ReadonlySet<string>, valueScope: ReadonlySet<string>): void => {
          const signature = ts.isFunctionLike(node) ? node : undefined;
          const parameters = signature?.typeParameters ?? (ts.isClassLike(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) ? node.typeParameters : undefined);
          const types = parameters?.length ? new Set([...typeScope, ...parameters.map(parameter => parameter.name.text)]) : typeScope;
          let values = valueScope;
          if (signature?.parameters.length) {
            const names = new Set(valueScope);
            const bind = (name: ts.BindingName): void => {if(ts.isIdentifier(name))names.add(name.text);else for(const element of name.elements)if(ts.isBindingElement(element))bind(element.name);};
            signature.parameters.forEach(parameter => bind(parameter.name)); values = names;
          }
          if (ts.isTypeReferenceNode(node) || ts.isTypeQueryNode(node)) {
            let identifier = ts.isTypeReferenceNode(node) ? node.typeName : node.exprName;
            while (ts.isQualifiedName(identifier)) identifier = identifier.left;
            const scope = ts.isTypeReferenceNode(node) ? types : values;
            if (!scope.has(identifier.text) && declarations.has(identifier.text)) visitName(identifier.text);
          }
          if (ts.isExpressionWithTypeArguments(node) && ts.isIdentifier(node.expression) && !types.has(node.expression.text) && declarations.has(node.expression.text)) visitName(node.expression.text);
          ts.forEachChild(node, child => reference(child, types, values));
        };
        const moduleBindings = new Set<string>();
        const sourceFile = item.node.getSourceFile();
        if (ts.isExternalModule(sourceFile)) for (const statement of sourceFile.statements) {
          if (ts.isImportEqualsDeclaration(statement)) moduleBindings.add(statement.name.text);
          else if (ts.isImportDeclaration(statement) && statement.importClause) {
            const clause = statement.importClause;
            if (clause.name) moduleBindings.add(clause.name.text);
            if (clause.namedBindings) {
              if (ts.isNamespaceImport(clause.namedBindings)) moduleBindings.add(clause.namedBindings.name.text);
              else clause.namedBindings.elements.forEach(element => moduleBindings.add(element.name.text));
            }
          }
        }
        reference(item.node, moduleBindings, moduleBindings);
        const visitImport = (file: string): void => { if (imported.has(file)) return; imported.add(file); for (const target of graph.get(file)?.values() ?? []) visitImport(target); };
        for (const [file, syntax] of parsed) if (syntax === item.node.getSourceFile()) for (const target of graph.get(file)?.values() ?? []) visitImport(target);
      }
    };
    visitName(name);
    const records = [...reachable].sort().flatMap(name => (declarations.get(name) ?? []).map(item => [name, item.source, item.node.getText(item.node.getSourceFile())]));
    const dependencies = [...imported].sort().map(file => [origins[file]?.url ?? pathToFileURL(file).href, origins[file]?.text ?? captured.get(file)]);
    descriptors.push({ name, kind, fingerprint: JSON.stringify([records, dependencies]) });
  }
  return { descriptors, parsed };
}

export interface GlobalNominalBinding {
  readonly text: string;
  readonly originalPosition: (position: number) => number;
}

export function bindGlobalNominals(
  source: ts.SourceFile,
  originals: readonly GlobalNominal[],
  fixed: readonly FixedGlobalNominal[],
  emitted: Set<string>,
): GlobalNominalBinding {
  const available = new Map(originals.flatMap(original => {
    const match = fixed.find(item => item.name === original.name && item.fingerprint === original.fingerprint);
    return match ? [[original.name, match] as const] : [];
  }));
  const replacements: { start: number; end: number; text: string }[] = [];
  const imports = new Map<string, string>();
  const occupied = new Set<string>();
  const identifiers = (node: ts.Node): void => { if (ts.isIdentifier(node)) occupied.add(node.text); ts.forEachChild(node, identifiers); };
  identifiers(source);
  const factory = ts.factory, printer = ts.createPrinter();
  const alias = (item: FixedGlobalNominal): ts.ImportEqualsDeclaration | undefined => {
    if (emitted.has(item.name)) return undefined;
    emitted.add(item.name);
    let namespace = imports.get(item.file);
    if (!namespace) {
      namespace = "__bitagentNominal" + imports.size;
      while (occupied.has(namespace)) namespace += "_";
      occupied.add(namespace); imports.set(item.file, namespace);
    }
    return factory.createImportEqualsDeclaration([factory.createModifier(ts.SyntaxKind.ExportKeyword)], false,
      factory.createIdentifier(item.name), factory.createQualifiedName(factory.createIdentifier(namespace), factory.createIdentifier(item.name)));
  };
  const replace = (statement: ts.Statement, results: readonly ts.Statement[]) => {
    replacements.push({ start: statement.getStart(source), end: statement.end,
      text: results.map(result => printer.printNode(ts.EmitHint.Unspecified, result, source)).join("\n") });
  };
  const visit = (statements: readonly ts.Statement[], global: boolean): void => {
    for (const statement of statements) {
      if (ts.isModuleDeclaration(statement) && statement.flags & ts.NodeFlags.GlobalAugmentation && statement.body && ts.isModuleBlock(statement.body)) {
        visit(statement.body.statements, true); continue;
      }
      if (!global) continue;
      if (ts.isVariableStatement(statement)) {
        const remaining: ts.VariableDeclaration[] = [], aliases: ts.ImportEqualsDeclaration[] = [];
        let changed = false;
        for (const declaration of statement.declarationList.declarations) {
          const item = ts.isIdentifier(declaration.name) ? available.get(declaration.name.text) : undefined;
          if (item?.kind === "constant") { changed = true; const binding = alias(item); if (binding) aliases.push(binding); }
          else remaining.push(declaration);
        }
        if (changed) replace(statement, [...aliases, ...(remaining.length ? [factory.updateVariableStatement(statement, statement.modifiers, factory.updateVariableDeclarationList(statement.declarationList, remaining))] : [])]);
      } else if ((ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isModuleDeclaration(statement)) && statement.name && ts.isIdentifier(statement.name)) {
        const item = available.get(statement.name.text);
        if (item) { const binding = alias(item); replace(statement, binding ? [binding] : []); }
      }
    }
  };
  const script = source.isDeclarationFile && !ts.isExternalModule(source);
  visit(source.statements, script);
  if (imports.size) {
    const prefix = [...imports].map(([file, namespace]) => "import * as " + namespace + " from " + JSON.stringify(file) + ";\n").join("");
    const start = source.statements[0]?.getStart(source) ?? source.text.length;
    replacements.push({ start, end: start, text: prefix + (script ? "declare global {\n" : "") });
    if (script) replacements.push({ start: source.text.length, end: source.text.length, text: "\n}\n" });
  }
  replacements.sort((a, b) => a.start - b.start || a.end - b.end);
  let text = "", cursor = 0;
  for (const replacement of replacements) {
    if (replacement.start < cursor) throw new Error("Overlapping global declaration replacements");
    text += source.text.slice(cursor, replacement.start) + replacement.text; cursor = replacement.end;
  }
  text += source.text.slice(cursor);
  const originalPosition = (position: number): number => {
    let delta = 0;
    for (const replacement of replacements) {
      const start = replacement.start + delta, end = start + replacement.text.length;
      if (position < start) break;
      if (position < end) return replacement.start + Math.min(position - start, replacement.end - replacement.start);
      delta += replacement.text.length - (replacement.end - replacement.start);
    }
    return position - delta;
  };
  return { text, originalPosition };
}
