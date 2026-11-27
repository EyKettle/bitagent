import type { BatchScope, Definition } from "../compiler/index.js";

export class Definitions implements BatchScope {
  readonly #bindings = new Map<string, Definition>();

  get bindings(): BatchScope["bindings"] {
    return this.#bindings;
  }

  retainCells(names: Iterable<string>): object {
    const cells: object = Object.create(null);
    for (const name of names) {
      const definition = this.#bindings.get(name);
      if (!definition?.setterExport) throw new Error(`No mutable definition named ${name}`);
      const { module, exportName, setterExport } = definition;
      const setter: unknown = Reflect.get(module.namespace, setterExport);
      if (typeof setter !== "function") throw new Error(`Mutable definition ${name} has no setter`);
      // Capture the binding, not its name in the registry: drop cannot retarget an old closure.
      Object.defineProperty(cells, name, {
        get: () => Reflect.get(module.namespace, exportName),
        set: (value: unknown) => { Reflect.apply(setter, undefined, [value]); },
      });
    }
    return cells;
  }

  introduce(definitions: readonly Definition[]): void {
    for (const definition of definitions) this.#bindings.set(definition.name, definition);
  }

  drop(name: string): boolean {
    return this.#bindings.delete(name);
  }
}
