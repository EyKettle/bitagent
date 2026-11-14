import ts from "typescript";
import { createGenerator } from "ts-json-schema-generator";
import { contractParser, type FunctionContract, type JsonSchema } from "../contracts.js";

export class ContractCompileError extends Error {
  constructor(node: ts.Node, message: string) {
    const file = node.getSourceFile();
    const position = file.getLineAndCharacterOfPosition(node.getStart());
    super(`${file.fileName}:${position.line + 1}:${position.character + 1}: ${message}`);
    this.name = "ContractCompileError";
  }
}

/** JSON transport must not silently change the TypeScript result (e.g. Date into string). */
function assertDataType(
  type: ts.Type,
  node: ts.Node,
  checker: ts.TypeChecker,
  seen: Set<ts.Type> = new Set(),
  optional = false,
): void {
  if (seen.has(type)) return;
  seen.add(type);
  if (type.isUnion()) {
    for (const member of type.types) {
      if (optional && (member.flags & ts.TypeFlags.Undefined)) continue;
      assertDataType(member, node, checker, new Set(seen));
    }
    return;
  }
  if (type.flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral | ts.TypeFlags.Number |
    ts.TypeFlags.NumberLiteral | ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral | ts.TypeFlags.Null)) return;
  if (!(type.flags & ts.TypeFlags.Object) || type.isClass() ||
      type.getCallSignatures().length !== 0 || type.getConstructSignatures().length !== 0) {
    throw new ContractCompileError(node, `Contract type ${checker.typeToString(type)} is not lossless JSON data`);
  }
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    const reference = type as ts.TypeReference;
    const elements = checker.getTypeArguments(reference);
    const flags = checker.isTupleType(type) ? (reference.target as ts.TupleType).elementFlags : [];
    elements.forEach((element, index) => {
      assertDataType(element, node, checker, new Set(seen), Boolean((flags[index] ?? 0) & ts.ElementFlags.Optional));
    });
    return;
  }
  for (const property of type.getProperties()) {
    if (property.name.startsWith("__@")) {
      throw new ContractCompileError(node, "Symbol properties cannot cross a JSON contract");
    }
    assertDataType(checker.getTypeOfSymbolAtLocation(property, node), node, checker,
      new Set(seen), Boolean(property.flags & ts.SymbolFlags.Optional));
  }
  for (const index of checker.getIndexInfosOfType(type)) {
    if (!(index.keyType.flags & (ts.TypeFlags.String | ts.TypeFlags.Number))) {
      throw new ContractCompileError(node, "Contract index keys must be strings or numbers");
    }
    assertDataType(index.type, node, checker, new Set(seen));
  }
}

function isContractCall(node: ts.Node, checker: ts.TypeChecker): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const declaration = checker.getResolvedSignature(node)?.declaration;
  return declaration !== undefined && ts.getJSDocTags(declaration)
    .some((tag) => tag.tagName.text === "bitagentContract");
}

function jsonExpression(value: unknown): ts.Expression {
  const factory = ts.factory;
  if (value === null) return factory.createNull();
  if (typeof value === "string") return factory.createStringLiteral(value);
  if (typeof value === "number") {
    return value < 0
      ? factory.createPrefixUnaryExpression(ts.SyntaxKind.MinusToken, factory.createNumericLiteral(-value))
      : factory.createNumericLiteral(value);
  }
  if (typeof value === "boolean") return value ? factory.createTrue() : factory.createFalse();
  if (Array.isArray(value)) return factory.createArrayLiteralExpression(value.map(jsonExpression));
  if (typeof value === "object") {
    return factory.createObjectLiteralExpression(Object.entries(value).map(([key, item]) =>
      factory.createPropertyAssignment(factory.createComputedPropertyName(factory.createStringLiteral(key)), jsonExpression(item))));
  }
  throw new TypeError("A generated contract must contain only JSON values");
}

/** Resolves every contract before emission, so one unsupported type cannot leave a partial build. */
export function createContractTransformer(program: ts.Program): ts.TransformerFactory<ts.SourceFile> {
  const checker = program.getTypeChecker();
  const generator = createGenerator({
    tsProgram: program, topRef: false, functions: "fail", strictTuples: true, jsDoc: "none",
  });
  const contracts = new Map<ts.CallExpression, FunctionContract>();

  function schema(node: ts.TypeNode): JsonSchema {
    try {
      const generated = generator.createSchemaFromNodes([node]) as JsonSchema;
      if (!["type", "$ref", "anyOf", "oneOf", "allOf", "const", "enum"].some((key) => key in generated)) {
        throw new Error("The type generator produced no enforceable constraint");
      }
      contractParser(generated);
      return generated;
    } catch (error) {
      throw new ContractCompileError(node, error instanceof Error ? error.message : String(error));
    }
  }

  function collect(node: ts.Node): void {
    if (isContractCall(node, checker)) {
      const argument = node.typeArguments?.[0];
      if (node.typeArguments?.length !== 1 || argument === undefined || node.arguments.length !== 1) {
        throw new ContractCompileError(node, "defineFunction requires one explicit concrete function signature and one body");
      }
      const signatures = checker.getTypeFromTypeNode(argument).getCallSignatures();
      const signature = signatures[0];
      if (signatures.length !== 1 || signature === undefined || (signature.typeParameters?.length ?? 0) !== 0) {
        throw new ContractCompileError(argument, "A contract requires one non-generic function signature, not overloads");
      }
      const declaration = signature.getDeclaration();
      if (declaration.type === undefined) throw new ContractCompileError(argument, "The function contract needs an explicit return type");
      // A generic alias's declaration still holds its type parameters. Refuse it rather than generating the wrong schema.
      const declaredSignature = checker.getSignatureFromDeclaration(declaration);
      if (declaredSignature !== undefined && signature !== declaredSignature &&
          declaration.parent && ts.isTypeAliasDeclaration(declaration.parent) && declaration.parent.typeParameters?.length) {
        throw new ContractCompileError(argument, "Use a concrete signature for this contract instead of an instantiated generic function alias");
      }
      const parameters = declaration.parameters.map((parameter, index) => {
        if (!ts.isIdentifier(parameter.name) || parameter.type === undefined || parameter.dotDotDotToken !== undefined) {
          throw new ContractCompileError(parameter, "Contract parameters need names and explicit types; rest parameters are not supported");
        }
        const symbol = signature.parameters[index];
        if (symbol === undefined) throw new ContractCompileError(parameter, "Cannot resolve the parameter type");
        const optional = parameter.questionToken !== undefined || parameter.initializer !== undefined;
        assertDataType(checker.getTypeOfSymbolAtLocation(symbol, parameter), parameter, checker, new Set(), optional);
        return { name: parameter.name.text, optional, schema: schema(parameter.type) };
      });
      assertDataType(checker.getReturnTypeOfSignature(signature), declaration.type, checker);
      contracts.set(node, { version: 1, parameters, output: schema(declaration.type) });
    }
    ts.forEachChild(node, collect);
  }
  for (const file of program.getSourceFiles()) if (!file.isDeclarationFile) collect(file);

  return (context) => {
    const visit: ts.Visitor = (node) => {
      if (ts.isCallExpression(node)) {
        const contract = contracts.get(node);
        if (contract !== undefined) {
          const updated = ts.visitEachChild(node, visit, context);
          return ts.factory.updateCallExpression(updated, updated.expression, updated.typeArguments,
            [...updated.arguments, jsonExpression(JSON.parse(JSON.stringify(contract)))]);
        }
      }
      return ts.visitEachChild(node, visit, context);
    };
    return (file) => ts.visitNode(file, visit) as ts.SourceFile;
  };
}

/** Builds ordinary user packages with the same contract transform used by the file host. */
export function compileContractProject(configFile: string): void {
  const config = ts.readConfigFile(configFile, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ts.sys.resolvePath(configFile + "/.."),
    { noEmit: false, noEmitOnError: true }, configFile);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  if (diagnostics.length) throw new Error(formatDiagnostics(diagnostics));
  const transformer = createContractTransformer(program);
  const emitted = program.emit(undefined, undefined, undefined, undefined, { before: [transformer] });
  if (emitted.emitSkipped || emitted.diagnostics.length) throw new Error(formatDiagnostics(emitted.diagnostics));
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getNewLine: () => "\n",
  });
}
