import ts from "typescript";

export function freshName(file: ts.SourceFile, stem: string): ts.Identifier {
  const used = new Set<string>();
  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node)) used.add(node.text);
    ts.forEachChild(node, visit);
  }
  visit(file);
  let name = stem;
  for (let suffix = 1; used.has(name); suffix++) name = `${stem}${suffix}`;
  return ts.factory.createIdentifier(name);
}

export function preview(entry: ts.SourceFile): { exportName?: string; transform: ts.TransformerFactory<ts.SourceFile> } {
  const last = entry.statements.at(-1);
  if (!last || !ts.isExpressionStatement(last)) return { transform: () => (file) => file };
  const name = freshName(entry, "__bitagentPreview");
  const { factory } = ts;
  const transform: ts.TransformerFactory<ts.SourceFile> = () => (file) => {
    const result = factory.createVariableStatement([factory.createModifier(ts.SyntaxKind.ExportKeyword)],
      factory.createVariableDeclarationList([factory.createVariableDeclaration(name, undefined, undefined, last.expression)],
        ts.NodeFlags.Const));
    return factory.updateSourceFile(file, [...file.statements.slice(0, -1), ts.setTextRange(result, last)]);
  };
  return { exportName: name.text, transform };
}
