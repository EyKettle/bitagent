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

export function preview(entry: ts.SourceFile, sourceEnd: number): { exportName?: string; transform: ts.TransformerFactory<ts.SourceFile> } {
  const index = entry.statements.findLastIndex((statement) => statement.getEnd() <= sourceEnd);
  const last = entry.statements[index];
  if (!last || !ts.isExpressionStatement(last)) return { transform: () => (file) => file };
  const name = freshName(entry, "__bitagentPreview");
  const { factory } = ts;
  const transform: ts.TransformerFactory<ts.SourceFile> = () => (file) => {
    const statement = file.statements[index];
    if (!ts.isExpressionStatement(statement)) return file;
    const result = factory.createVariableStatement([factory.createModifier(ts.SyntaxKind.ExportKeyword)],
      factory.createVariableDeclarationList([factory.createVariableDeclaration(name, undefined, undefined, statement.expression)],
        ts.NodeFlags.Const));
    return factory.updateSourceFile(file, [
      ...file.statements.slice(0, index), ts.setTextRange(result, last), ...file.statements.slice(index + 1),
    ]);
  };
  return { exportName: name.text, transform };
}
