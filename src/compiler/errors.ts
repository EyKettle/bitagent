import type { CompilationErrorKind } from "./types.js";
export class CompilationError extends Error {
  constructor(readonly kind: CompilationErrorKind, message: string, options?: ErrorOptions) {
    super(message, options); this.name = "CompilationError";
  }
}
