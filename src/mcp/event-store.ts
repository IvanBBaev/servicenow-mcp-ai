import type { EventStore, JSONRPCMessage } from "@modelcontextprotocol/server";

/**
 * N-79 — SSE resumability for a stateful HTTP session.
 *
 * One store per session (`http-sessions.ts`), dropped with it; the modern
 * stateless wire has no long-lived stream and no store. The store is a ring:
 * past `maxEvents` or `maxBytes` the oldest events go first, so a client
 * that reconnects with a `Last-Event-ID` the ring no longer holds gets the
 * SDK's 400 and starts over instead of a partial replay. Event ids are a
 * per-store sequence — opaque to the client, ordered for the replay.
 */

/** Events kept per session. */
export const EVENT_STORE_MAX_EVENTS = 256;
/** Serialized bytes kept per session (× SN_HTTP_MAX_SESSIONS in the worst case). */
export const EVENT_STORE_MAX_BYTES = 256 * 1024;

interface StoredEvent {
  seq: number;
  streamId: string;
  message: JSONRPCMessage;
  bytes: number;
}

export interface SessionEventStoreOptions {
  maxEvents?: number;
  maxBytes?: number;
}

export class SessionEventStore implements EventStore {
  private readonly events: StoredEvent[] = [];
  private readonly byId = new Map<string, StoredEvent>();
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private seq = 0;
  private bytes = 0;

  constructor(options: SessionEventStoreOptions = {}) {
    this.maxEvents = options.maxEvents ?? EVENT_STORE_MAX_EVENTS;
    this.maxBytes = options.maxBytes ?? EVENT_STORE_MAX_BYTES;
  }

  /** Events held now (for tests and diagnostics). */
  get size(): number {
    return this.events.length;
  }

  storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
    this.seq += 1;
    const event: StoredEvent = {
      seq: this.seq,
      streamId,
      message,
      bytes: Buffer.byteLength(JSON.stringify(message)),
    };
    const id = String(event.seq);
    this.events.push(event);
    this.byId.set(id, event);
    this.bytes += event.bytes;
    // Keep the newest event even when it alone is over the byte cap.
    while (
      this.events.length > 1 &&
      (this.events.length > this.maxEvents || this.bytes > this.maxBytes)
    ) {
      const old = this.events.shift()!;
      this.byId.delete(String(old.seq));
      this.bytes -= old.bytes;
    }
    return Promise.resolve(id);
  }

  getStreamIdForEventId(eventId: string): Promise<string | undefined> {
    return Promise.resolve(this.byId.get(eventId)?.streamId);
  }

  async replayEventsAfter(
    lastEventId: string,
    {
      send,
    }: { send: (eventId: string, message: JSONRPCMessage) => Promise<void> },
  ): Promise<string> {
    const last = this.byId.get(lastEventId);
    if (!last) return "";
    for (const event of this.events) {
      if (event.seq <= last.seq || event.streamId !== last.streamId) continue;
      // The SDK's priming event is an empty object, not a message to resend.
      if (!("jsonrpc" in event.message)) continue;
      await send(String(event.seq), event.message);
    }
    return last.streamId;
  }
}
