import type { Contract, DataShape } from "./contracts.js";
import { ContractError, generatedContract } from "./contracts.js";
import { Job } from "./jobs.js";
import type { Coroutine } from "./protocol.js";
export type FunctionSignature = (...args: never[]) => unknown;
export type JobFunction<F extends FunctionSignature> = (...args: Parameters<F>) => Job<ReturnType<F>>;
export type FunctionBody<F extends FunctionSignature> = (result: Contract<ReturnType<F>>, ...args: Parameters<F>) => Coroutine<ReturnType<F>>;
export interface FunctionOptions { readonly start?: "immediate" | "manual"; }
export interface FunctionArtifact { readonly parameters: readonly { readonly name: string; readonly optional: boolean; readonly shape: DataShape }[]; readonly result: DataShape; }
export function defineFunction<F extends FunctionSignature>(_body: FunctionBody<F>, _options?: FunctionOptions): JobFunction<F> { throw new TypeError("defineFunction requires a generated function artifact"); }
export function generatedFunction(body: FunctionBody<FunctionSignature>, options: FunctionOptions | undefined, artifact: FunctionArtifact): JobFunction<FunctionSignature> {
  if (typeof body !== "function") throw new TypeError("Function body must be callable");
  if (options !== undefined && (options === null || typeof options !== "object" || Object.keys(options).some((key) => key !== "start") || options.start !== undefined && options.start !== "immediate" && options.start !== "manual")) throw new TypeError("Invalid function startup options");
  const start = options?.start ?? "immediate";
  const parameters = artifact.parameters.map((p) => ({ ...p, contract: generatedContract(p.shape) })), result = generatedContract(artifact.result);
  return (...args: never[]) => {
    const values: unknown[] = [], issues = [];
    if (args.length > parameters.length) issues.push({ path: [parameters.length], message: "Too many arguments" });
    for (const [index, parameter] of parameters.entries()) {
      if (args[index] === undefined && parameter.optional) { values.push(undefined); continue; }
      try { values.push(parameter.contract.parse(args[index])); } catch (error) { if (!(error instanceof ContractError)) throw error; issues.push(...error.issues.map((issue) => ({ path: [parameter.name, ...issue.path], message: issue.message }))); }
    }
    if (issues.length) throw new ContractError(issues);
    const work = function* (): Coroutine<unknown> { return result.parse(yield* body(result, ...values as never[])); };
    return start === "manual" ? Job.create(work) : Job.spawn(work);
  };
}
