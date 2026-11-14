import { resolve } from "node:path";
import ts from "typescript";
import tsNode from "ts-node";

/** Keep ts-node checking; only the virtual REPL can use await outside a module. */
export function configureReplCompiler(service: tsNode.Service, scriptPath: string): void {
  const compile = service.compile;
  service.compile = (source, filename, lineOffset) => {
    if (resolve(filename) !== scriptPath) return compile(source, filename, lineOffset);
    try {
      compile(source, filename, lineOffset);
    } catch (error) {
      if (!(error instanceof tsNode.TSError) || error.diagnostics.length === 0 ||
          !error.diagnostics.every((diagnostic) =>
            diagnostic.code === 1309 && diagnostic.file !== undefined &&
            resolve(diagnostic.file.fileName) === scriptPath)) {
        throw error;
      }
    }
    // Use the same emit before and after the first await so REPL diffs never replay old code.
    const output = ts.transpileModule(source, {
      fileName: filename,
      reportDiagnostics: true,
      compilerOptions: {
        ...service.config.options,
        module: ts.ModuleKind.CommonJS,
        moduleResolution: ts.ModuleResolutionKind.Node10,
      },
    });
    const diagnostics = output.diagnostics ?? [];
    if (diagnostics.length > 0) {
      throw new tsNode.TSError(ts.formatDiagnostics(diagnostics, {
        getCurrentDirectory: () => service.options.cwd ?? process.cwd(),
        getCanonicalFileName: (name) => name,
        getNewLine: () => "\n",
      }), diagnostics.map((diagnostic) => diagnostic.code), diagnostics);
    }
    return output.outputText;
  };
}
