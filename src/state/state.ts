import { artifact, associations, bindings, identity, specifications } from "../compiler/artifacts.js";
import type { CompiledInput } from "../compiler/types.js";
import type { ApplicationState, Definition, LiveBinding, StateChange, StateErrorKind, StateSnapshot } from "./types.js";

export class StateError extends Error {
  constructor(readonly kind: StateErrorKind, message: string, options?: ErrorOptions) {
    super(message, options); this.name = "StateError";
  }
}
interface Entry { readonly owner: Store; readonly binding: LiveBinding | undefined; }
const definitions = new WeakMap<Definition, Entry>();
const stores = new WeakMap<ApplicationState, Store>();
const snapshots = new WeakSet<StateSnapshot>();
interface Change { readonly before: number; readonly added: Definition[]; readonly removed: Definition[]; }
class Store {
  revision = 0;
  readonly entries = new Map<string, Definition>();
  active: Change | undefined;
  readonly handle: ApplicationState;
  constructor() {
    const store = this;
    this.handle = Object.freeze({
      id: identity("state"),
      get revision() { return store.revision; },
      get definitions() { return Object.freeze([...store.entries.values()]); },
      snapshot(): StateSnapshot {
        const result = Object.freeze({ state: store.handle, revision: store.revision, definitions: store.handle.definitions }) as StateSnapshot;
        snapshots.add(result); return result;
      },
      find(name: string) { if (typeof name !== "string") throw new TypeError("Definition name must be a string"); return store.entries.get(name); },
      value(definition: Definition) { return store.read(definition); },
      aliases(target: object) {
        if (target === null || (typeof target !== "object" && typeof target !== "function")) throw new TypeError("Aliases require an object or function");
        return Object.freeze([...store.entries.values()].filter((d) => d.spec.kind !== "type" && Object.is(store.read(d), target)));
      },
      remove(...items: readonly Definition[]): StateChange {
        const unique = [...new Set(items)];
        for (const item of unique) store.entry(item);
        const change: Change = { before: store.revision, added: [], removed: [] };
        for (const item of unique) { store.entries.delete(item.spec.name); store.bump(); change.removed.push(item); store.active?.removed.push(item); }
        return store.change(change);
      },
    }) as ApplicationState;
  }
  entry(definition: Definition): Entry {
    const entry = definitions.get(definition);
    if (entry === undefined) throw new TypeError("Expected an authentic definition");
    if (entry.owner !== this) throw new StateError("foreign", "Definition belongs to another State");
    if (this.entries.get(definition.spec.name) !== definition) throw new StateError("stale", "Definition has been removed");
    return entry;
  }
  read(definition: Definition): unknown {
    const entry = this.entry(definition);
    if (entry.binding === undefined) throw new StateError("missing-value", "A pure type has no runtime value");
    return entry.binding.read();
  }
  bump(): void { if (this.revision === Number.MAX_SAFE_INTEGER) throw new StateError("stale", "State revision exhausted"); this.revision++; }
  change(change: Change): StateChange { return Object.freeze({ before: change.before, after: this.revision, added: Object.freeze([...change.added]), removed: Object.freeze([...change.removed]) }); }
  add(spec: Definition["spec"], binding: LiveBinding | undefined): Definition {
    if (this.entries.has(spec.name)) throw new StateError("duplicate", `Definition already exists: ${spec.name}`);
    const definition = Object.freeze({ id: identity("definition"), spec }) as Definition;
    definitions.set(definition, { owner: this, binding }); this.entries.set(spec.name, definition); this.bump(); this.active!.added.push(definition); return definition;
  }
}
export function createState(): ApplicationState { const store = new Store(); stores.set(store.handle, store); return store.handle; }
export function requireState(state: ApplicationState): Store { const store = stores.get(state); if (store === undefined) throw new TypeError("Expected an authentic State"); return store; }
export function requireSnapshot(snapshot: StateSnapshot): void { if (!snapshots.has(snapshot)) throw new TypeError("Expected an authentic State snapshot"); }
export function readBinding(state: ApplicationState, id: string): unknown {
  const store = requireState(state); const definition = [...store.entries.values()].find((d) => d.id === id);
  if (definition === undefined) throw new StateError("stale", "Definition no longer exists"); return store.read(definition);
}
export function captureBindings(state: ApplicationState): Map<string, LiveBinding> {
  const store = requireState(state), captured = new Map<string, LiveBinding>();
  for (const d of store.entries.values()) { const binding = store.entry(d).binding; if (binding !== undefined) captured.set(d.id, binding); }
  return captured;
}
export interface DefinitionPublication { readonly state: ApplicationState; publish(binding: LiveBinding): Definition; finish(): StateChange; }
export function beginPublication(state: ApplicationState, input: CompiledInput): DefinitionPublication {
  const store = requireState(state), compiled = artifact(input);
  if (compiled.snapshot.state !== state) throw new StateError("foreign", "Compilation belongs to another State");
  const association = associations.get(state);
  if (association === undefined || association.compiler !== compiled.compiler) throw new StateError("invalid-publication", "Compiler is not associated with this State");
  if (store.active !== undefined) throw new StateError("busy", "State publication is active");
  if (compiled.snapshot.revision !== store.revision) throw new StateError("stale", "State changed after compilation");
  for (const spec of compiled.specs) {
    if (!specifications.has(spec)) throw new StateError("invalid-publication", "Unauthenticated definition specification");
    if (store.entries.has(spec.name)) throw new StateError("duplicate", `Definition already exists: ${spec.name}`);
  }
  const change: Change = { before: store.revision, added: [], removed: [] }; store.active = change;
  let result: StateChange | undefined;
  for (const spec of compiled.specs) if (spec.kind === "type") store.add(spec, undefined);
  const published = new Map<Definition["spec"], Definition>();
  return Object.freeze({ state,
    publish(binding: LiveBinding): Definition {
      if (result !== undefined) throw new StateError("closed", "Publication has finished");
      if (bindings.get(binding)?.input !== input || !compiled.specs.includes(binding.spec) || binding.spec.kind === "type") throw new StateError("invalid-publication", "Binding is not generated for this input");
      const existing = published.get(binding.spec); if (existing !== undefined) return existing;
      const definition = store.add(binding.spec, binding); published.set(binding.spec, definition); return definition;
    },
    finish(): StateChange { if (result !== undefined) return result; result = store.change(change); store.active = undefined; return result; },
  });
}
