import { readFromCycle } from "./cycle.ts";

console.log("workspace evaluated");
const moduleLocal = 900;
export let amount: number = 4;
export function increment(): number {
  amount += 1;
  return readFromCycle() + moduleLocal - 900;
}
export type WorkspaceAmount = typeof amount;
