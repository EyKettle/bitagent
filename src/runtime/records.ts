/** Only compiler-owned copied metadata reaches this freezer; runtime binding values do not. */
export function freezeRecord<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) freezeRecord(entry);
    Object.freeze(value);
  }
  return value;
}
