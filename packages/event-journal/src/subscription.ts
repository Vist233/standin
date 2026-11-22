import type { SessionEvent } from "@standin/contracts";

/** The set of live listeners of one session, plus a way to wake all of them when the journal closes. */
export class Listeners {
  private readonly active = new Set<Listener>();

  add(listener: Listener): void {
    this.active.add(listener);
  }

  remove(listener: Listener): void {
    this.active.delete(listener);
  }

  publish(event: SessionEvent): void {
    for (const listener of this.active) listener.push(event);
  }

  wakeAll(): void {
    for (const listener of this.active) listener.wake();
  }
}

/** A buffer that a subscriber drains; `wake` lets an idle subscriber notice new events or closing. */
export class Listener {
  readonly buffer: SessionEvent[] = [];
  private wakeUp: (() => void) | undefined;

  push(event: SessionEvent): void {
    this.buffer.push(event);
    this.wake();
  }

  wake(): void {
    const resume = this.wakeUp;
    this.wakeUp = undefined;
    resume?.();
  }

  /** Resolves at the next push or wake. Check the buffer first: this is only for the empty case. */
  idle(): Promise<void> {
    return new Promise((resolve) => {
      this.wakeUp = resolve;
    });
  }
}

/**
 * Replay-then-follow, shared by every journal. The listener is registered BEFORE history is read, so an event
 * appended in between is in both; the `last` check removes the repeat. That ordering is what makes resume gap-free.
 */
export async function* followSession(options: {
  listeners: Listeners;
  readHistory: () => Promise<SessionEvent[]>;
  after: number;
  isClosed: () => boolean;
}): AsyncGenerator<SessionEvent> {
  const listener = new Listener();
  options.listeners.add(listener);
  try {
    let last = options.after;
    for (const event of await options.readHistory()) {
      if (event.seq <= last) continue;
      last = event.seq;
      yield event;
    }
    while (true) {
      const next = listener.buffer.shift();
      if (next) {
        if (next.seq <= last) continue;
        last = next.seq;
        yield next;
      } else if (options.isClosed()) {
        return;
      } else {
        await listener.idle();
      }
    }
  } finally {
    options.listeners.remove(listener);
  }
}
