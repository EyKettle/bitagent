declare const stateBrand: unique symbol;
declare const snapshotBrand: unique symbol;
declare const definitionBrand: unique symbol;
declare const definitionTypeBrand: unique symbol;
declare const definitionSpecBrand: unique symbol;
declare const liveBindingBrand: unique symbol;

export type DefinitionKind = "value" | "type" | "value-type";
export interface DefinitionOrigin {
  readonly url: string;
  readonly start: number;
  readonly length: number;
}
export interface DefinitionType {
  readonly [definitionTypeBrand]: true;
  readonly id: string;
  readonly display: string;
}
export interface DefinitionSpec {
  readonly [definitionSpecBrand]: true;
  readonly name: string;
  readonly kind: DefinitionKind;
  readonly mutable: boolean;
  readonly type: DefinitionType;
  readonly origins: readonly DefinitionOrigin[];
}
export interface Definition {
  readonly [definitionBrand]: true;
  readonly id: string;
  readonly spec: DefinitionSpec;
}
export interface StateSnapshot {
  readonly [snapshotBrand]: true;
  readonly state: ApplicationState;
  readonly revision: number;
  readonly definitions: readonly Definition[];
}
export interface StateChange {
  readonly before: number;
  readonly after: number;
  readonly added: readonly Definition[];
  readonly removed: readonly Definition[];
}
export type StateErrorKind =
  | "foreign" | "stale" | "missing-value" | "duplicate" | "busy" | "closed" | "invalid-publication";
export interface ApplicationState {
  readonly [stateBrand]: true;
  readonly id: string;
  readonly revision: number;
  readonly definitions: readonly Definition[];
  snapshot(): StateSnapshot;
  find(name: string): Definition | undefined;
  value(definition: Definition): unknown;
  aliases(target: object): readonly Definition[];
  remove(...definitions: readonly Definition[]): StateChange;
}


// 编译执行产生的真实绑定；不接受手填的回调或类型字符串。
export interface LiveBinding {
  readonly [liveBindingBrand]: true;
  readonly spec: DefinitionSpec;
  read(): unknown;
  write?(value: unknown): void;
}
