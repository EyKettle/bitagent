import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { SourceTextModule, SyntheticModule } from "node:vm";
import type { Context, Module } from "node:vm";

import { DependencyLoader, requireEvaluation } from "./dependencies.js";
import type { DependencySource, Request } from "./dependencies.js";
import type { Diagnostic } from "./diagnostics.js";
import { isPathSpecifier } from "./project.js";
import type { Project } from "./project.js";
import { workspaceTarget } from "./workspace.js";
import type { CompiledModule } from "./workspace.js";

type Graph = CompiledModule & { workspace: ReadonlyMap<string, CompiledModule> };
type Input = { kind: "batch" | "workspace"; source: CompiledModule } | { kind: "dependency"; source: DependencySource };
export type PrepareImport = (specifier: string, from: string) =>
  { kind: "checked"; input: Graph } | { kind: "diagnostic"; diagnostics: readonly Diagnostic[] } | undefined;

export class RejectedImport extends Error {
  constructor(readonly diagnostics: readonly Diagnostic[]) {
    super(diagnostics.map(({ code, message }) => `TS${code}: ${message}`).join("\n"));
  }
}

export class ModuleLoader {
  readonly #context: Context;
  readonly #project: Project;
  readonly #dependencies: DependencyLoader;
  readonly #modules = new Map<string, SourceTextModule>();
  readonly #evaluation = new WeakMap<Module, Promise<void>>();
  #linking: Promise<unknown> = Promise.resolve();

  constructor(context: Context, project: Project) {
    this.#context = context;
    this.#project = project;
    this.#dependencies = new DependencyLoader(context);
  }

  async run(graph: Graph, retained: ReadonlyMap<string, Module>, prepareImport: PrepareImport): Promise<Module> {
    const root = await this.#serializeLinks(() => this.#link({ kind: "batch", source: graph }, graph.workspace, prepareImport, retained));
    await this.#evaluate(root);
    return root;
  }

  #serializeLinks(action: () => Promise<Module>): Promise<Module> {
    const linked = this.#linking.then(action);
    this.#linking = linked.then(() => undefined, () => undefined);
    return linked;
  }

  async #link(
    input: Input,
    workspace: ReadonlyMap<string, CompiledModule>,
    prepareImport: PrepareImport,
    retained: ReadonlyMap<string, Module> = new Map(),
  ): Promise<Module> {
    const staging = new Map<string, SourceTextModule>();
    const visit = async (current: Input | SyntheticModule): Promise<Module> => {
      if (current instanceof SyntheticModule) return current;
      const { source } = current;
      const url = current.kind === "dependency" ? current.source.url : pathToFileURL(source.fileName).href;
      if (current.kind !== "batch") {
        const existing = this.#modules.get(url) ?? staging.get(url);
        if (existing) return existing;
      }
      const module = new SourceTextModule(source.code, {
        context: this.#context,
        identifier: url,
        initializeImportMeta: (meta) => {
          meta.url = url;
          meta.filename = source.fileName;
          meta.dirname = dirname(source.fileName);
          meta.resolve = (specifier: string) => {
            const target = localTarget(current, specifier);
            return target ? pathToFileURL(target).href : this.#resolve(current, specifier);
          };
        },
        importModuleDynamically: (specifier, _referrer, attributes, phase) =>
          this.#dynamic(current, { specifier, attributes, phase }, workspace, prepareImport),
      });
      // Allocate before following edges so cycles reuse the same module record.
      if (current.kind !== "batch") staging.set(url, module);

      const dependencies: Module[] = [];
      for (const request of module.moduleRequests) {
        const internal = current.kind === "batch" && retained.get(request.specifier);
        if (internal) {
          dependencies.push(internal);
          continue;
        }
        const target = localTarget(current, request.specifier);
        if (target) {
          requireEvaluation(request, false);
          const compiled = (input.kind === "workspace" && input.source.fileName === target ? input.source : workspace.get(target))
            ?? this.#project.module(target);
          if (!compiled) throw new Error(`No checked source for ${target}`);
          dependencies.push(await visit({ kind: "workspace", source: compiled }));
        } else {
          dependencies.push(await visit(await this.#dependency(current, request)));
        }
      }
      module.linkRequests(dependencies);
      return module;
    };
    const root = await visit(input);
    if (root instanceof SourceTextModule && root.status === "unlinked") root.instantiate();
    // A later check of a retained function must see the same source as its lazy imports.
    for (const source of workspace.values()) this.#project.adopt(source);
    if (input.kind === "workspace") this.#project.adopt(input.source);
    for (const [url, module] of staging) this.#modules.set(url, module);
    return root;
  }

  async #dynamic(
    input: Input,
    request: Request,
    workspace: ReadonlyMap<string, CompiledModule>,
    prepareImport: PrepareImport,
  ): Promise<Module> {
    const { specifier } = request;
    const module = await this.#serializeLinks(async () => {
      if (input.kind !== "dependency" && this.#project.permits(specifier) && !this.#project.isConfiguredDependency(specifier)) {
        const target = localTarget(input, specifier);
        if (target) {
          requireEvaluation(request, false);
          const compiled = this.#project.module(target) ?? workspace.get(target);
          if (compiled) return this.#link({ kind: "workspace", source: compiled }, workspace, prepareImport);
        }
        if (!input.source.resolutions.has(specifier) || target) {
          const prepared = prepareImport(specifier, input.source.fileName);
          if (prepared?.kind === "diagnostic") throw new RejectedImport(prepared.diagnostics);
          if (prepared?.kind === "checked") {
            requireEvaluation(request, false);
            return this.#link({ kind: "workspace", source: prepared.input }, prepared.input.workspace, prepareImport);
          }
        }
      }
      const dependency = await this.#dependency(input, request);
      if (!(dependency instanceof SyntheticModule)) return this.#link(dependency, new Map(), prepareImport);
      if (dependency.status === "unlinked") await dependency.link(() => { throw new Error("Unexpected synthetic module request"); });
      return dependency;
    });
    await this.#evaluate(module);
    return module;
  }

  #evaluate(module: Module): Promise<void> {
    const existing = this.#evaluation.get(module);
    if (existing) return existing;
    const result = module.evaluate();
    this.#evaluation.set(module, result);
    return result;
  }

  #resolve(input: Input, specifier: string): string {
    return input.kind === "dependency"
      ? import.meta.resolve(specifier, input.source.url)
      : this.#project.resolveRuntime(specifier, input.source.fileName);
  }

  async #dependency(input: Input, request: Request): Promise<Input | SyntheticModule> {
    const url = this.#resolve(input, request.specifier);
    const requiresCheckedSource = input.kind !== "dependency" && isPathSpecifier(request.specifier)
      && !this.#project.isConfiguredDependency(url);
    const dependency = await this.#dependencies.load(url, request, requiresCheckedSource);
    return dependency instanceof SyntheticModule ? dependency : { kind: "dependency", source: dependency };
  }
}

function localTarget(input: Input, specifier: string): string | undefined {
  return input.kind === "dependency" ? undefined : workspaceTarget(input.source.resolutions.get(specifier));
}
