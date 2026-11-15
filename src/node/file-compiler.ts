import { createRequire } from "node:module";
import { dirname, isAbsolute, resolve } from "node:path";
import ts from "typescript";
import { createContractTransformer } from "./contracts.js";

export interface Binding {
  readonly name: string;
  readonly alias: string;
  readonly value: boolean;
  readonly mutable: boolean;
  readonly namespace: boolean;
  readonly typeOnly: boolean;
}

export interface CompiledFile {
  readonly bindings: readonly Binding[];
  readonly main: string;
  readonly javascript: ReadonlyMap<string, string>;
  readonly resolutions: ReadonlyMap<string, ReadonlyMap<string, string>>;
  readonly declarations: ReadonlyMap<string, string>;
  readonly captureFile: string;
}

export class FileCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileCompileError";
  }
}

const captureName = "__bitagentCapture";
const resultName = "__bitagentResult";
export const scriptInternals = Object.freeze({ captureName, resultName });

function names(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  return name.elements.flatMap((element) => ts.isOmittedExpression(element) ? [] : names(element.name));
}

function topLevelNames(file: ts.SourceFile): Map<string, { node: ts.Identifier; mutable: boolean }> {
  const found = new Map<string, { node: ts.Identifier; mutable: boolean }>();
  const add = (node: ts.Identifier, mutable = false) => { found.set(node.text, { node, mutable }); };
  for (const statement of file.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const node of names(declaration.name)) add(node, !(statement.declarationList.flags & ts.NodeFlags.Const));
      }
    } else if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.name) add(clause.name);
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) add(clause.namedBindings.name);
        else for (const specifier of clause.namedBindings.elements) add(specifier.name);
      }
    } else if (ts.isImportEqualsDeclaration(statement)) add(statement.name);
    else if ("name" in statement && statement.name && ts.isIdentifier(statement.name as ts.Node)) {
      add(statement.name as ts.Identifier, ts.isFunctionDeclaration(statement));
    }
  }
  return found;
}

function diagnosticsText(diagnostics: readonly ts.Diagnostic[]): string {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (path) => path,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => "\n",
  });
}

/** Checks and emits the exact source snapshot, without reading it again during execution. */
export function compileFile(
  filename: string,
  source: string,
  globals: string,
  outputDirectory: string,
): CompiledFile {
  const original = ts.createSourceFile(filename, source, ts.ScriptTarget.ES2022, true);
  const candidates = topLevelNames(original);
  for (const reserved of [captureName, resultName]) {
    if (candidates.has(reserved)) throw new FileCompileError(`${reserved} is reserved by the file host`);
  }
  // Files are ordinary modules in the editor. Private export aliases make every
  // top-level definition available to declaration emit without changing its name.
  const aliases = [...candidates.keys()].map((name, index) => ({ name, alias: `__live_${index}` }));
  const prepared = source + "\nexport {};\n" + aliases.map(({ name, alias }) => `export { ${name} as ${alias} };`).join("\n");
  const options: ts.CompilerOptions = {
    strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
    skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, moduleDetection: ts.ModuleDetectionKind.Force,
    declaration: true, preserveConstEnums: true, outDir: outputDirectory, noEmitOnError: true,
    lib: ["lib.es2022.d.ts"], types: ["node"],
    typeRoots: [dirname(dirname(createRequire(import.meta.url).resolve("@types/node/package.json")))],
  };
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host);
  host.readFile = (path) => resolve(path) === filename ? prepared : read(path);
  const program = ts.createProgram([filename, globals], options, host);
  const file = program.getSourceFile(filename);
  if (!file) throw new FileCompileError(`Cannot load ${filename}`);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) throw new FileCompileError(diagnosticsText(diagnostics));
  const checker = program.getTypeChecker();
  const bindings: Binding[] = [];
  const identifiers = topLevelNames(file);
  for (const { name, alias } of aliases) {
    const candidate = identifiers.get(name)!;
    const symbol = checker.getSymbolAtLocation(candidate.node);
    if (!symbol) throw new FileCompileError(`Cannot resolve the definition ${name}`);
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    const typeOnly = ts.isImportSpecifier(candidate.node.parent)
      ? candidate.node.parent.isTypeOnly || candidate.node.parent.parent.parent.isTypeOnly
      : ts.isImportClause(candidate.node.parent) ? candidate.node.parent.isTypeOnly
      : ts.isNamespaceImport(candidate.node.parent) ? candidate.node.parent.parent.isTypeOnly
      : ts.isImportEqualsDeclaration(candidate.node.parent) ? candidate.node.parent.isTypeOnly : false;
    bindings.push({ name, alias, mutable: candidate.mutable, typeOnly,
      value: !typeOnly && Boolean(target.flags & ts.SymbolFlags.Value),
      namespace: typeOnly || Boolean(target.flags & (ts.SymbolFlags.Type | ts.SymbolFlags.Namespace)) });
  }

  function checkEntry(node: ts.Node): void {
    if (ts.isFunctionLike(node)) return;
    if (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier)) {
      throw new FileCompileError(`${filename}: file entries cannot await; start a function* coroutine with app.start()`);
    }
    ts.forEachChild(node, checkEntry);
  }
  for (const local of program.getSourceFiles()) if (!local.isDeclarationFile) checkEntry(local);

  const bindingByName = new Map(bindings.filter((binding) => binding.value).map((binding) => [binding.name, binding]));
  const capture: ts.TransformerFactory<ts.SourceFile> = () => (input) => {
    if (input.fileName !== file.fileName) return input;
    const factory = ts.factory;
    function record(identifier: ts.Identifier): ts.Statement[] {
      const binding = bindingByName.get(identifier.text);
      if (!binding) return [];
      const get = factory.createArrowFunction(undefined, undefined, [], undefined,
        factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken), identifier);
      const args: ts.Expression[] = [factory.createStringLiteral(binding.name), get];
      if (binding.mutable) {
        const value = factory.createUniqueName("__nextValue");
        args.push(factory.createArrowFunction(undefined, undefined,
          [factory.createParameterDeclaration(undefined, undefined, value)], undefined,
          factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken), factory.createAssignment(identifier, value)));
      }
      return [factory.createExpressionStatement(factory.createCallExpression(factory.createIdentifier(captureName), undefined, args))];
    }
    const statements: ts.Statement[] = [];
    // Function declarations are hoisted by JS, even if an earlier statement fails.
    for (const statement of input.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) statements.push(...record(statement.name));
    }
    for (const statement of input.statements) {
      if (ts.isVariableStatement(statement) && !statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) {
        for (const declaration of statement.declarationList.declarations) {
          statements.push(factory.updateVariableStatement(statement, statement.modifiers,
            factory.updateVariableDeclarationList(statement.declarationList, [declaration])));
          for (const identifier of names(declaration.name)) statements.push(...record(identifier));
        }
      } else {
        statements.push(statement);
        if (ts.isImportDeclaration(statement)) {
          const clause = statement.importClause;
          if (clause?.name) statements.push(...record(clause.name));
          if (clause?.namedBindings) {
            if (ts.isNamespaceImport(clause.namedBindings)) statements.push(...record(clause.namedBindings.name));
            else for (const specifier of clause.namedBindings.elements) statements.push(...record(specifier.name));
          }
        } else if (ts.isImportEqualsDeclaration(statement)) statements.push(...record(statement.name));
        else if ((ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) &&
                 statement.name && ts.isIdentifier(statement.name)) statements.push(...record(statement.name));
      }
    }
    // A final expression is a host display value, never an implicitly awaited result.
    const last = [...input.statements].reverse().find((statement) => statement.getStart() < source.length);
    if (last && ts.isExpressionStatement(last)) {
      const index = statements.indexOf(last);
      if (index >= 0) statements[index] = factory.updateExpressionStatement(last,
        factory.createCallExpression(factory.createIdentifier(resultName), undefined, [last.expression]));
    }
    return factory.updateSourceFile(input, statements);
  };

  const declarations = new Map<string, string>();
  const declarationOrigins = new Map<string, string>();
  const javascript = new Map<string, string>();
  let captureFile: string | undefined;
  const emit = program.emit(undefined, (path, text, _bom, _error, sources) => {
    const origin = sources?.[0];
    if (!origin) return;
    if (path.endsWith(".d.ts") || path.endsWith(".d.cts") || path.endsWith(".d.mts")) {
      declarations.set(resolve(path), text);
      declarationOrigins.set(resolve(origin.fileName), resolve(path));
      if (resolve(origin.fileName) === filename) captureFile = resolve(path);
    } else if (/\.[cm]?js$/.test(path)) {
      // Typechecking uses NodeNext. Execution is an explicit synchronous CommonJS
      // host; lowering already-emitted JS does not relax the TypeScript checks.
      const emitted = ts.transpileModule(text, {
        fileName: path, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
          moduleResolution: ts.ModuleResolutionKind.Node10, esModuleInterop: true },
      });
      javascript.set(resolve(origin.fileName), emitted.outputText);
    }
  }, undefined, undefined, { before: [createContractTransformer(program), capture] });
  if (emit.emitSkipped || emit.diagnostics.length) throw new FileCompileError(diagnosticsText(emit.diagnostics));
  if (!captureFile || !javascript.has(filename)) throw new FileCompileError(`No executable output for ${filename}`);

  // Declarations move into immutable execution snapshots. Resolve file imports
  // from their original source, then point at the captured type when emitted.
  const importPaths = new Map<string, string>();
  for (const local of program.getSourceFiles()) {
    const origin = resolve(local.fileName);
    const target = declarationOrigins.get(origin) ?? origin;
    const module = target.replace(/(?:\.d)?\.(cts|mts|ts|tsx)$/, (_match, extension: string) =>
      extension === "cts" ? ".cjs" : extension === "mts" ? ".mjs" : ".js");
    importPaths.set(origin.replace(/(?:\.d)?\.(?:cts|mts|ts|tsx)$/, ""), module);
    importPaths.set(origin, module);
  }
  const sourceByDeclaration = new Map([...declarationOrigins].map(([origin, path]) => [path, origin]));
  const printer = ts.createPrinter();
  for (const [path, text] of declarations) {
    const origin = sourceByDeclaration.get(path)!;
    const modulePath = (specifier: string): string => {
      if (!specifier.startsWith(".") && !isAbsolute(specifier)) return specifier;
      const target = ts.resolveModuleName(specifier, origin, options, host).resolvedModule;
      return (target && importPaths.get(resolve(target.resolvedFileName))) ?? importPaths.get(specifier) ?? specifier;
    };
    const parsed = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true);
    const transformed = ts.transform(parsed, [(context) => {
      const visit: ts.Visitor = (input) => {
        const node = ts.visitEachChild(input, visit, context);
        if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) &&
            ts.isStringLiteral(node.argument.literal)) {
          return ts.factory.updateImportTypeNode(node,
            ts.factory.createLiteralTypeNode(ts.factory.createStringLiteral(modulePath(node.argument.literal.text))),
            node.attributes, node.qualifier, node.typeArguments, node.isTypeOf);
        }
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          return ts.factory.updateImportDeclaration(node, node.modifiers, node.importClause,
            ts.factory.createStringLiteral(modulePath(node.moduleSpecifier.text)), node.attributes);
        }
        if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          return ts.factory.updateExportDeclaration(node, node.modifiers, node.isTypeOnly, node.exportClause,
            ts.factory.createStringLiteral(modulePath(node.moduleSpecifier.text)), node.attributes);
        }
        if (ts.isExternalModuleReference(node) && node.expression && ts.isStringLiteral(node.expression)) {
          return ts.factory.updateExternalModuleReference(node, ts.factory.createStringLiteral(modulePath(node.expression.text)));
        }
        return node;
      };
      return (input) => ts.visitNode(input, visit) as ts.SourceFile;
    }]);
    declarations.set(path, printer.printFile(transformed.transformed[0]!));
    transformed.dispose();
  }

  const resolutions = new Map<string, ReadonlyMap<string, string>>();
  for (const local of program.getSourceFiles()) {
    if (!javascript.has(resolve(local.fileName))) continue;
    const imports = new Map<string, string>();
    const visit = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        const specifier = node.moduleSpecifier.text;
        const target = ts.resolveModuleName(specifier, local.fileName, options, host).resolvedModule;
        if (target) imports.set(specifier, resolve(target.resolvedFileName));
      }
      ts.forEachChild(node, visit);
    };
    visit(local);
    resolutions.set(resolve(local.fileName), imports);
  }
  return { main: filename, bindings, javascript, resolutions, declarations, captureFile };
}
