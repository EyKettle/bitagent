import { ContractError, contractParser, requireContract } from "./contracts.js";
import type { ContractParser, FunctionContract, JsonSchema } from "./contracts.js";
import type { Coroutine } from "./coroutine.js";

export type FunctionSignature = (...args: never[]) => unknown;
export type CoroutineFunction<F extends FunctionSignature> = (...args: Parameters<F>) => Coroutine<ReturnType<F>>;
export type FunctionBody<F extends FunctionSignature> = (
  result: ContractParser<ReturnType<F>>,
  ...args: Parameters<F>
) => Coroutine<ReturnType<F>>;

/**
 * Defines a coroutine function from one concrete input/result signature.
 * The BitAgent compiler supplies the runtime contract before this module loads.
 * @bitagentContract
 */
export function defineFunction<F extends FunctionSignature>(body: FunctionBody<F>): CoroutineFunction<F>;
export function defineFunction<F extends FunctionSignature>(
  body: FunctionBody<F>,
  compiled?: FunctionContract,
): CoroutineFunction<F> {
  const contract = requireContract(compiled);
  const parameters = contract.parameters.map((parameter) => ({
    ...parameter, parser: contractParser(parameter.schema),
  }));
  const result = contractParser<ReturnType<F>>(contract.output);
  return (...args: Parameters<F>): Coroutine<ReturnType<F>> => {
    // The caller can keep editing its own data without changing this invocation.
    const snapshot: Parameters<F> = structuredClone(args);
    if (snapshot.length > parameters.length) throw new ContractError("Too many function arguments");
    for (const [index, parameter] of parameters.entries()) {
      if (snapshot[index] === undefined && parameter.optional) continue;
      try { parameter.parser.parse(snapshot[index]); }
      catch (error) {
        if (error instanceof ContractError) throw new ContractError(`Argument ${parameter.name}: ${error.issues}`);
        throw error;
      }
    }
    return (function* () {
      return result.parse(yield* body(result, ...snapshot));
    })();
  };
}

export interface SubmitTool<T> {
  readonly name: "submit";
  readonly description: string;
  readonly parameters: JsonSchema;
  /** Parsing does not itself stop a model or choose the caller's control flow. */
  parse(argumentsValue: unknown): T;
}

/** Constructs the return channel; its caller decides how success and failure are used. */
export function createSubmitTool<T>(result: ContractParser<T>): SubmitTool<T> {
  // Keep draft-07 definitions at the root: references inside value remain valid.
  const { $schema, definitions, ...valueSchema } = result.schema;
  const parameters: JsonSchema = {
    ...($schema === undefined ? {} : { $schema }),
    ...(definitions === undefined ? {} : { definitions }),
    type: "object",
    properties: { value: valueSchema },
    required: ["value"],
    additionalProperties: false,
  };
  const envelope = contractParser<{ value: unknown }>(parameters);
  return Object.freeze({
    name: "submit" as const,
    description: "Submit the function result in value. Follow the declared result schema exactly.",
    get parameters() { return envelope.schema; },
    parse(argumentsValue: unknown): T {
      const snapshot: unknown = structuredClone(argumentsValue);
      return result.parse(envelope.parse(snapshot).value);
    },
  });
}
