import type { Environment } from "./execution.js";
import type { ExecutionBindings } from "../compiler/artifacts.js";
interface Context { readonly environment: Environment; readonly generated: object; readonly capture: (bindings: ExecutionBindings) => void; readonly initialize: (metadata: ImportMeta) => void; }
const contexts = new Map<string, Context>();
export function retainContext(token: string, context: Context): void { contexts.set(token, context); }
export function releaseContext(token: string): void { contexts.delete(token); }
export function acquire(token: string, metadata: ImportMeta): Context { const context = contexts.get(token); if (!context) throw new TypeError("No active captured module context"); context.initialize(metadata); return context; }
