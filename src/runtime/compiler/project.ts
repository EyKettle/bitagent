import { readFileSync, realpathSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { CompiledModule } from "./workspace.js";

export function isPathSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../") || isAbsolute(specifier) || specifier.startsWith("file:");
}

export function sourceSpecifier(specifier: string): string {
  if (!specifier.startsWith("file:")) return specifier;
  const url = new URL(specifier);
  if (url.search || url.hash) throw new Error(`Source file URL cannot contain a query or fragment: ${specifier}`);
  return fileURLToPath(url);
}

export class Project {
  readonly directory: string;
  readonly consoleFile: string;
  readonly #packages = new Set<string>();
  readonly #dependencyUrls = new Set<string>();
  readonly #hasManifest: boolean;
  readonly #modules = new Map<string, CompiledModule>();

  constructor(workspace: string) {
    this.directory = realpathSync(workspace);
    if (!statSync(this.directory).isDirectory()) throw new Error(`Project is not a directory: ${workspace}`);
    this.consoleFile = resolve(this.directory, ".bitagent-console.ts");
    const manifest = this.#readManifest();
    this.#hasManifest = manifest !== undefined;
    if (!manifest) return;
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      const dependencies = manifest[field];
      if (typeof dependencies === "object" && dependencies !== null && !Array.isArray(dependencies)) {
        for (const name of Object.keys(dependencies)) this.#packages.add(name);
      }
    }
    if (typeof manifest.name === "string") this.#packages.add(manifest.name);
  }

  #readManifest(): Record<string, unknown> | undefined {
    const path = resolve(this.directory, "package.json");
    let source: string;
    try {
      source = readFileSync(path, "utf8");
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
    const manifest: unknown = JSON.parse(source);
    if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
      throw new Error(`Expected a package manifest in ${path}`);
    }
    return manifest as Record<string, unknown>;
  }

  permits(specifier: string): boolean {
    if (isPathSpecifier(specifier) || isBuiltin(specifier)) return true;
    if (specifier.startsWith("#")) return this.#hasManifest;
    if (/^[\w+.-]+:/u.test(specifier)) return false;
    const segments = specifier.split("/");
    const name = segments.slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
    return this.#packages.has(name);
  }

  resolutionBase(specifier: string, from: string): string {
    return isPathSpecifier(specifier) ? from : this.consoleFile;
  }

  module(fileName: string): CompiledModule | undefined {
    return this.#modules.get(fileName);
  }

  adopt(module: CompiledModule): void {
    if (!this.#modules.has(module.fileName)) this.#modules.set(module.fileName, module);
  }

  isConfiguredDependency(url: string): boolean {
    return this.#dependencyUrls.has(url);
  }

  resolveRuntime(specifier: string, from: string): string {
    if (!this.permits(specifier)) throw new Error(`Import ${JSON.stringify(specifier)} is not configured in ${this.directory}`);
    const url = import.meta.resolve(specifier, pathToFileURL(this.resolutionBase(specifier, from)).href);
    // A URL returned by import.meta.resolve can import the same configured dependency.
    if (!isPathSpecifier(specifier) && url.startsWith("file:")) this.#dependencyUrls.add(url);
    return url;
  }
}
