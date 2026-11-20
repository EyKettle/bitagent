import { Job, type Coroutine, type JobBody } from "@bitagent/core";
import { fromAsync } from "@bitagent/core/host";

// Compile-only consumer: no Job is created outside an execution scope at runtime.
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
interface Data { readonly value: number; }
declare const data: Data;
declare const numberValue: number;
declare const legalUnion: number | Data | null;
declare const illegalUnion: number | Promise<number>;
declare const structural: { then(): void };
declare const optional: { then?: () => void };
declare const mixedThen: { then: string | (() => void) };
declare const functionValue: (argument: string) => number;
declare const existing: Job<Data>;
declare const invalidExisting: Job<Promise<number>>;
declare const dynamic: unknown;
declare const untyped: any;
declare const broadObject: object;
declare const primitives: null | undefined | boolean | number | bigint | symbol | string;
declare const optionalDataThen: { then?: string };
declare const erasedThen: { then: any };
const functionMetadata = { then: { ...Function.prototype } };

function wrap<T>(body: JobBody<T>): Job<T> {
  return Job.create(body);
}

function createContract() {
  const normal = Job.create(function* () { return numberValue; });
  type Normal = Expect<Equal<typeof normal.result, number>>;
  const object = Job.create(function* () { return data; });
  type ObjectResult = Expect<Equal<typeof object.result, Data>>;
  const empty = Job.create(function* () {});
  type Empty = Expect<Equal<typeof empty.result, void>>;
  const never = Job.create(function* (): Coroutine<never> { throw new Error(); });
  type Never = Expect<Equal<typeof never.result, never>>;
  const union = Job.create(function* () { return legalUnion; });
  type Union = Expect<Equal<typeof union.result, number | Data | null>>;
  const explicit = Job.create<Data>(function* () { return data; });
  type Explicit = Expect<Equal<typeof explicit.result, Data>>;
  const io = Job.create(function* () { return yield* fromAsync(() => Promise.resolve(data)); });
  type IO = Expect<Equal<typeof io.result, Data>>;
  const waited = Job.create(function* () { return yield* existing.wait(); });
  type Waited = Expect<Equal<typeof waited.result, Data>>;
  const callable = Job.create(function* () { return functionValue; });
  type Callable = Expect<Equal<typeof callable.result, typeof functionValue>>;
  const nonCallableThen = Job.create(function* () { return { then: 1 }; });
  type NonCallableThen = Expect<Equal<typeof nonCallableThen.result, { then: number }>>;
  const unknown = Job.create(function* () { return dynamic; });
  type Unknown = Expect<Equal<typeof unknown.result, unknown>>;
  const any = Job.create(function* () { return untyped; });
  type Any = Expect<Equal<typeof any.result, any>>;
  const typedBody: JobBody<Data> = function* () { return data; };
  const typed = Job.create(typedBody);
  type TypedBody = Expect<Equal<typeof typed.result, Data>>;
  const wrapped = wrap(typedBody);
  type Wrapped = Expect<Equal<typeof wrapped.result, Data>>;
  const objectBoundary = Job.create(function* () { return broadObject; });
  type ObjectBoundary = Expect<Equal<typeof objectBoundary.result, object>>;
  const primitive = Job.create(function* () { return primitives; });
  type Primitive = Expect<Equal<typeof primitive.result, typeof primitives>>;
  const optionalData = Job.create(function* () { return optionalDataThen; });
  type OptionalData = Expect<Equal<typeof optionalData.result, typeof optionalDataThen>>;
  const metadata = Job.create(function* () { return functionMetadata; });
  type Metadata = Expect<Equal<typeof metadata.result, typeof functionMetadata>>;
  const erased = Job.create(function* () { return erasedThen; });
  type ErasedThen = Expect<Equal<typeof erased.result, typeof erasedThen>>;
  // Explicit erasure cannot recover completion structure; runtime remains authoritative.
  Job.create<unknown>(function* () { return Promise.resolve(1); });
  // @ts-expect-error native Promise completion is illegal
  Job.create(function* () { return Promise.resolve(1); });
  // @ts-expect-error a broader contextual result does not erase the body's completion
  const contextual: Job<unknown> = Job.create(function* () { return Promise.resolve(1); });
  // @ts-expect-error structural thenable need not implement PromiseLike
  Job.create(function* () { return structural; });
  // @ts-expect-error inferred union contains an illegal completion branch
  Job.create(function* () { return illegalUnion; });
  // @ts-expect-error explicit Promise generic is illegal
  Job.create<Promise<number>>(function* () { return Promise.resolve(1); });
  // @ts-expect-error explicit structural thenable generic is illegal
  Job.create<typeof structural>(function* () { return structural; });
  // @ts-expect-error explicit union is illegal even when this callback returns a legal branch
  Job.create<number | Promise<number>>(function* () { return 1; });
  // @ts-expect-error explicit number cannot disguise Promise completion
  Job.create<number>(function* () { return Promise.resolve(1); });
  // @ts-expect-error void must not discard an illegal completion value
  Job.create<void>(function* () { return Promise.resolve(1); });
  // @ts-expect-error optional then can be callable
  Job.create(function* () { return optional; });
  // @ts-expect-error one possible then value is callable
  Job.create(function* () { return mixedThen; });
  // @ts-expect-error constructor-valued then is a function at runtime
  Job.create(function* () { return { then: class Then {} }; });
  // @ts-expect-error yield* does not legalize a thenable completion
  Job.create(function* () { return yield* invalidExisting.wait(); });
  // @ts-expect-error asynchronous generators are not Core coroutines
  Job.create(async function* () { return 1; });
}
void createContract;

function spawnContract() {
  const normal = Job.spawn(function* () { return numberValue; });
  type Normal = Expect<Equal<typeof normal.result, number>>;
  const object = Job.spawn(function* () { return data; });
  type ObjectResult = Expect<Equal<typeof object.result, Data>>;
  const empty = Job.spawn(function* () {});
  type Empty = Expect<Equal<typeof empty.result, void>>;
  const never = Job.spawn(function* (): Coroutine<never> { throw new Error(); });
  type Never = Expect<Equal<typeof never.result, never>>;
  const union = Job.spawn(function* () { return legalUnion; });
  type Union = Expect<Equal<typeof union.result, number | Data | null>>;
  const explicit = Job.spawn<Data>(function* () { return data; });
  type Explicit = Expect<Equal<typeof explicit.result, Data>>;
  const io = Job.spawn(function* () { return yield* fromAsync(() => Promise.resolve(data)); });
  type IO = Expect<Equal<typeof io.result, Data>>;
  const waited = Job.spawn(function* () { return yield* existing.wait(); });
  type Waited = Expect<Equal<typeof waited.result, Data>>;
  const callable = Job.spawn(function* () { return functionValue; });
  type Callable = Expect<Equal<typeof callable.result, typeof functionValue>>;
  const nonCallableThen = Job.spawn(function* () { return { then: 1 }; });
  type NonCallableThen = Expect<Equal<typeof nonCallableThen.result, { then: number }>>;
  const unknown = Job.spawn(function* () { return dynamic; });
  type Unknown = Expect<Equal<typeof unknown.result, unknown>>;
  const any = Job.spawn(function* () { return untyped; });
  type Any = Expect<Equal<typeof any.result, any>>;
  const typedBody: JobBody<Data> = function* () { return data; };
  const typed = Job.spawn(typedBody);
  type TypedBody = Expect<Equal<typeof typed.result, Data>>;
  const wrapped = wrap(typedBody);
  type Wrapped = Expect<Equal<typeof wrapped.result, Data>>;
  const objectBoundary = Job.spawn(function* () { return broadObject; });
  type ObjectBoundary = Expect<Equal<typeof objectBoundary.result, object>>;
  const primitive = Job.spawn(function* () { return primitives; });
  type Primitive = Expect<Equal<typeof primitive.result, typeof primitives>>;
  const optionalData = Job.spawn(function* () { return optionalDataThen; });
  type OptionalData = Expect<Equal<typeof optionalData.result, typeof optionalDataThen>>;
  const metadata = Job.spawn(function* () { return functionMetadata; });
  type Metadata = Expect<Equal<typeof metadata.result, typeof functionMetadata>>;
  const erased = Job.spawn(function* () { return erasedThen; });
  type ErasedThen = Expect<Equal<typeof erased.result, typeof erasedThen>>;
  // Explicit erasure cannot recover completion structure; runtime remains authoritative.
  Job.spawn<unknown>(function* () { return Promise.resolve(1); });
  // @ts-expect-error native Promise completion is illegal
  Job.spawn(function* () { return Promise.resolve(1); });
  // @ts-expect-error a broader contextual result does not erase the body's completion
  const contextual: Job<unknown> = Job.spawn(function* () { return Promise.resolve(1); });
  // @ts-expect-error structural thenable need not implement PromiseLike
  Job.spawn(function* () { return structural; });
  // @ts-expect-error inferred union contains an illegal completion branch
  Job.spawn(function* () { return illegalUnion; });
  // @ts-expect-error explicit Promise generic is illegal
  Job.spawn<Promise<number>>(function* () { return Promise.resolve(1); });
  // @ts-expect-error explicit structural thenable generic is illegal
  Job.spawn<typeof structural>(function* () { return structural; });
  // @ts-expect-error explicit union is illegal even when this callback returns a legal branch
  Job.spawn<number | Promise<number>>(function* () { return 1; });
  // @ts-expect-error explicit number cannot disguise Promise completion
  Job.spawn<number>(function* () { return Promise.resolve(1); });
  // @ts-expect-error void must not discard an illegal completion value
  Job.spawn<void>(function* () { return Promise.resolve(1); });
  // @ts-expect-error optional then can be callable
  Job.spawn(function* () { return optional; });
  // @ts-expect-error one possible then value is callable
  Job.spawn(function* () { return mixedThen; });
  // @ts-expect-error constructor-valued then is a function at runtime
  Job.spawn(function* () { return { then: class Then {} }; });
  // @ts-expect-error yield* does not legalize a thenable completion
  Job.spawn(function* () { return yield* invalidExisting.wait(); });
  // @ts-expect-error asynchronous generators are not Core coroutines
  Job.spawn(async function* () { return 1; });
}
void spawnContract;
