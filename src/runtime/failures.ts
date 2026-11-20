/** Source identity distinguishes independent failures even when their thrown values match. */
export interface FailureSource { readonly error: unknown; }
export interface Failure {
  readonly error: unknown;
  readonly sources: readonly FailureSource[];
}

export function observeFailure(error: unknown): Failure {
  return { error, sources: [{ error }] };
}

export function mergeFailures(body: Failure | undefined, shutdown: readonly FailureSource[]): Failure | undefined {
  const sources = [...new Set([...(body?.sources ?? []), ...shutdown])];
  if (sources.length === 0) return undefined;
  if (body !== undefined && sources.length === body.sources.length) return body;
  const error = sources.length === 1 ? sources[0]!.error
    : new AggregateError(sources.map((source) => source.error), "Execution scope failed to settle");
  return { error, sources };
}

/** Carries provenance through the driver without exposing a wrapper to application code. */
export class CoroutineFailure {
  constructor(readonly failure: Failure) {}
}
