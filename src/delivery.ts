import {
  type MemoryConfig,
  MemoryError,
  type MemoryWriter,
} from "./contracts.ts";
import {
  fingerprint,
  Outbox,
  type Receipt,
  type RetainItem,
} from "./outbox.ts";

export class Delivery {
  private readonly outbox: Outbox;
  private readonly client: MemoryWriter;
  private readonly controller = new AbortController();
  private flight: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private error: string | undefined;

  private constructor(outbox: Outbox, client: MemoryWriter) {
    this.outbox = outbox;
    this.client = client;
  }
  static async open(
    config: MemoryConfig,
    client: MemoryWriter,
  ): Promise<Delivery> {
    if (!config.outboxPath) throw new MemoryError("delivery-disabled");
    return new Delivery(
      await Outbox.open(
        config.outboxPath,
        client.destinationIdentity ??
          fingerprint([config.endpoint, config.bankId, config.apiKeyEnv]),
      ),
      client,
    );
  }
  enqueue(key: string, item: RetainItem): Receipt {
    if (this.closed) throw new MemoryError("delivery-closed");
    if (
      item.metadata.scope_type !== undefined &&
      item.metadata.scope_type !== "current"
    )
      throw new MemoryError("unsupported-legacy-scope");
    const receipt = this.outbox.enqueue(key, item);
    this.kick();
    return receipt;
  }
  status() {
    return {
      ...this.outbox.stats(),
      ...(this.error ? { error: this.error } : {}),
    };
  }
  hasPendingChanges(scopes: readonly string[][]): boolean {
    return this.outbox.hasPendingChanges(scopes);
  }
  kick(): void {
    void this.flush().catch(() => {
      this.error = "outbox-unavailable";
    });
  }
  flush(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (!this.flight) {
      this.flight = this.drain().finally(() => {
        this.flight = undefined;
        if (!this.closed) {
          try {
            const next = this.outbox.nextAttempt();
            if (next !== undefined) {
              if (this.timer) clearTimeout(this.timer);
              this.timer = setTimeout(
                () => this.kick(),
                Math.max(1000, next - Date.now()),
              );
              this.timer.unref();
            }
          } catch {
            this.error = "outbox-unavailable";
          }
        }
      });
    }
    return this.flight;
  }
  private async drain(): Promise<void> {
    const signal = this.controller.signal;
    for (let count = 0; count < 4 && !signal.aborted; count++) {
      const item = this.outbox.claim();
      if (!item) return;
      try {
        if (
          item.request.items.some(
            (entry) =>
              entry.metadata.scope_type !== undefined &&
              entry.metadata.scope_type !== "current",
          )
        ) {
          this.outbox.defer(item.id, "unsupported-legacy-scope", true);
          continue;
        }
        let status = await this.client.operation(item.id, signal);
        if (status === "not_found") {
          if (item.state === "submitted") {
            this.outbox.defer(item.id, "operation-missing", true);
            continue;
          }
          const operationId = await this.client.retain(item.request, signal);
          if (operationId !== item.id)
            throw new MemoryError("operation-mismatch");
          this.outbox.submitted(item.id);
          status = await this.client.operation(item.id, signal);
        }
        if (status === "completed") this.outbox.finish(item.id);
        else if (status === "failed" || status === "cancelled")
          this.outbox.defer(item.id, "operation-failed", true);
        else if (status === "not_found")
          this.outbox.defer(item.id, "operation-missing", true);
        else this.outbox.defer(item.id, "operation-pending");
      } catch (error) {
        const code =
          error instanceof MemoryError ? error.code : "delivery-failed";
        this.outbox.defer(
          item.id,
          code,
          code === "operation-mismatch" ||
            /http-(400|401|403|409|422)$/.test(code),
        );
      }
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.controller.abort();
    try {
      await this.flight;
    } finally {
      this.outbox.close();
    }
  }
}
