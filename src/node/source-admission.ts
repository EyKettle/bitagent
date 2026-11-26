import ts from "typescript";
import path from "node:path";

/** Selected standard libraries and their actual lib references own the library image. */
export function adoptStandardLibraries(
  options: ts.CompilerOptions,
  readFile: (file: string) => string | undefined,
): Readonly<Record<string, string>> {
  const directory = path.dirname(ts.getDefaultLibFilePath(options));
  const files: Record<string, string> = {};
  const adopt = (file: string): void => {
    if (Object.hasOwn(files, file)) return;
    const text = readFile(file);
    if (text === undefined) throw new Error(`Missing TypeScript standard library: ${file}`);
    files[file] = text;
    for (const reference of ts.preProcessFile(text, false).libReferenceDirectives)
      adopt(path.join(directory, `lib.${reference.fileName.toLowerCase()}.d.ts`));
  };
  for (const name of options.lib ?? [path.basename(ts.getDefaultLibFilePath(options))])
    adopt(path.join(directory, name));
  return files;
}

/** Adopted readonly libraries share runtime/type identity; input augmentation cannot retag old values. */
export function sharedLibraryAugmentations(
  program: ts.Program,
  libraryFiles: Readonly<Record<string, string>>,
): readonly ts.Identifier[] {
  const libraries = new Set(program.getSourceFiles().filter(source =>
    Object.hasOwn(libraryFiles, source.fileName)));
  const checker = program.getTypeChecker();
  const augmentations: ts.Identifier[] = [];
  for (const source of program.getSourceFiles()) {
    if (Object.hasOwn(libraryFiles, source.fileName)) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && "name" in node.parent && node.parent.name === node) {
        const symbol = checker.getSymbolAtLocation(node);
        const merged = symbol && checker.getExportSymbolOfSymbol(symbol);
        if (merged?.declarations?.some(declaration => declaration === node.parent) &&
          merged.declarations.some(declaration => libraries.has(declaration.getSourceFile()))) augmentations.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return augmentations;
}
