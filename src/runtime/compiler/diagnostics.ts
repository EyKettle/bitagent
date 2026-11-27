import ts from "typescript";

export type Diagnostic = {
  kind: "syntax" | "type";
  code: number;
  message: string;
  fileName?: string;
  line?: number;
  column?: number;
};

export function diagnosticsFor(program: ts.Program): Diagnostic[] {
  return [
    ...toDiagnostics("syntax", program.getSyntacticDiagnostics()),
    ...toDiagnostics("type", [
      ...program.getOptionsDiagnostics(),
      ...program.getGlobalDiagnostics(),
      ...program.getSemanticDiagnostics(),
    ]),
  ];
}

export function toDiagnostics(kind: Diagnostic["kind"], diagnostics: readonly ts.Diagnostic[]): Diagnostic[] {
  return diagnostics.filter(({ category }) => category === ts.DiagnosticCategory.Error).map((diagnostic) => {
    const result: Diagnostic = {
      kind,
      code: diagnostic.code,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    };
    if (diagnostic.file && diagnostic.start !== undefined) {
      const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      result.fileName = diagnostic.file.fileName;
      result.line = line + 1;
      result.column = character + 1;
    }
    return result;
  });
}
