import type { Module } from "node:vm";

export type SourceInput = { fileName: string; source: string };

export type TypeSource = SourceInput & {
  specifier: string;
  imports: ReadonlyMap<string, TypeSource>;
};

export type BindingPlan = {
  name: string;
  exportName: string;
  typeOnly: boolean;
  setterExport?: string;
};

export type Definition = BindingPlan & {
  typeSource: TypeSource;
  module: Module;
};

export type Scope = ReadonlyMap<string, Definition>;

export type BatchScope = {
  bindings: Scope;
  retainCells(names: Iterable<string>): object;
};
