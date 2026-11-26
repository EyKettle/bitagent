/** Internal measurement channel; public operations remain the measured driver. */
export interface CompilationPhase { readonly id: number; readonly phase: "checking" | "completed"; readonly workerTime: number; }
const observers = new Set<(event: CompilationPhase) => void>();
export function observeCompilation(observer: (event: CompilationPhase) => void): () => void { observers.add(observer); return () => observers.delete(observer); }
export function compilationPhase(event: CompilationPhase): void { for (const observer of observers) observer(event); }
