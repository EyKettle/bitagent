import type { FailureSource } from "./failures.js";

export interface OwnedWork {
  cancel(reason?: unknown): boolean;
  readonly settled: Promise<unknown>;
}

/** Core ownership is independent of the kernel's failure propagation. */
export class Lifetime {
  accepting = true;
  private readonly children = new Set<OwnedWork>();
  private readonly failures: FailureSource[] = [];

  adopt(child: OwnedWork): void {
    if (!this.accepting) throw new TypeError("Execution scope is closing");
    this.children.add(child);
  }

  release(child: OwnedWork, shutdownFailures: readonly FailureSource[]): void {
    this.children.delete(child);
    if (!this.accepting) this.failures.push(...shutdownFailures);
  }

  stop(reason?: unknown): void {
    if (!this.accepting) return;
    this.accepting = false;
    for (const child of [...this.children]) child.cancel(reason);
  }

  async drain(): Promise<readonly FailureSource[]> {
    await Promise.all([...this.children].map((child) => child.settled));
    return this.failures;
  }
}
