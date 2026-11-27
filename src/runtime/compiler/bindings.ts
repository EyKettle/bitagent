import ts from "typescript";

import type { BindingPlan } from "./scope.js";

const meanings = ts.SymbolFlags.Value | ts.SymbolFlags.Type | ts.SymbolFlags.Namespace | ts.SymbolFlags.Alias;

export function planBindings(program: ts.Program, entry: ts.SourceFile, end: number, prefix: string): BindingPlan[] {
  const checker = program.getTypeChecker();
  return checker.getSymbolsInScope(entry, meanings).flatMap((symbol, index) => {
    const local = symbol.declarations?.filter((node) => node.getSourceFile() === entry && node.getEnd() <= end);
    if (!local?.length || symbol.name === "default") return [];
    const declaration = local.find((node) => node === symbol.valueDeclaration) ?? local[0];
    const variable = variableDeclaration(declaration);
    if (variable && (variable.parent.flags & ts.NodeFlags.Using) !== 0) return [];

    const exported = checker.getExportSymbolOfSymbol(symbol);
    const target = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const ambient = local.every((node) => (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Ambient) !== 0);
    if (ambient && !(target.flags & (ts.SymbolFlags.Type | ts.SymbolFlags.Namespace))) return [];
    const typeOnly = ambient || !(target.flags & ts.SymbolFlags.Value)
      || ts.isTypeOnlyImportOrExportDeclaration(declaration);
    const exportName = `${prefix}binding${index}`;
    return [{
      name: symbol.name,
      exportName,
      typeOnly,
      setterExport: variable && !ambient && !(variable.parent.flags & ts.NodeFlags.Const) ? `${exportName}Set` : undefined,
    }];
  });
}

function variableDeclaration(node: ts.Node): ts.VariableDeclaration | undefined {
  while (ts.isBindingElement(node)) node = node.parent.parent;
  return ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent) ? node : undefined;
}

export function bindingExports(bindings: readonly BindingPlan[]): string {
  return bindings.map(({ name, exportName, typeOnly }) => `export ${typeOnly ? "type " : ""}{ ${name} as ${exportName} };`).join("\n");
}

export function bindingSetters(bindings: readonly BindingPlan[]): string {
  return bindings.flatMap(({ name, setterExport }) => setterExport
    ? `export function ${setterExport}(value) { ${name} = value; }`
    : []).join("\n");
}
