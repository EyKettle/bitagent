import { Ajv, type ValidateFunction } from "ajv";

export type JsonSchema = Readonly<Record<string, unknown>>;

/** Generated from a concrete TypeScript function signature, never inferred from a model reply. */
export interface ParameterContract {
  readonly name: string;
  readonly optional: boolean;
  readonly schema: JsonSchema;
}

export interface FunctionContract {
  readonly version: 1;
  readonly parameters: readonly ParameterContract[];
  readonly output: JsonSchema;
}

export class ContractError extends TypeError {
  constructor(readonly issues: string) {
    super(issues);
    this.name = "ContractError";
  }
}

export interface ContractParser<T> {
  readonly schema: JsonSchema;
  parse(value: unknown): T;
}

/** Internal boundary: the compiler supplies the schema corresponding to T. */
export function contractParser<T>(schema: JsonSchema): ContractParser<T> {
  const snapshot = structuredClone(schema);
  const ajv = new Ajv({ allErrors: true, strict: true, strictTuples: false, ownProperties: true });
  const validate: ValidateFunction<T> = ajv.compile<T>(snapshot);
  return Object.freeze({
    get schema() { return structuredClone(snapshot); },
    parse(value: unknown): T {
      if (!validate(value)) {
        throw new ContractError(ajv.errorsText(validate.errors, { separator: "; ", dataVar: "value" }));
      }
      return value;
    },
  });
}

export function requireContract(contract: FunctionContract | undefined): FunctionContract {
  if (contract?.version !== 1) {
    throw new ContractError("Missing compiled function contract. Compile this module with BitAgent before loading it.");
  }
  return contract;
}
