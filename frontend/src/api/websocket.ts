/**
 * WebSocket client with automatic reconnection and message routing.
 *
 * Usage:
 *   const ws = new BrainstormWebSocket(token);
 *   ws.on("job_complete", (msg) => console.log(msg));
 *   ws.send({ action: "subscribe_job", jobId: "..." });
 */

import { getRuntimeConfig } from "./client";

type MessageHandler = (payload: Record<string, unknown>) => void;

export class BrainstormWebSocket {
  private ws: WebSocket | null = null;
  private handlers: Map<string, MessageHandler[]> = new Map();
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private token: string;
  private _closed = false;
  private _queue: string[] = [];

  constructor(token: string) {
    this.token = token;
    this.connect();
  }

  private connect() {
    const { wsUrl } = getRuntimeConfig();
    const url = `${wsUrl}?token=${encodeURIComponent(this.token)}`;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.reconnectDelay = 1000;
      const queued = this._queue.splice(0);
      queued.forEach((msg) => this.ws!.send(msg));
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        const type = msg.type as string;
        const handlers = this.handlers.get(type) ?? [];
        handlers.forEach((h) => h(msg));
        // Also fire wildcard handlers
        (this.handlers.get("*") ?? []).forEach((h) => h(msg));
      } catch {
        // ignore parse errors
      }
    };

    this.ws.onclose = () => {
      if (!this._closed) {
        setTimeout(() => this.connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
      }
    };
  }

  on(type: string, handler: MessageHandler) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type)!.push(handler);
  }

  off(type: string, handler: MessageHandler) {
    const list = this.handlers.get(type) ?? [];
    this.handlers.set(type, list.filter((h) => h !== handler));
  }

  send(payload: Record<string, unknown>) {
    const msg = JSON.stringify(payload);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(msg);
    } else {
      this._queue.push(msg);
    }
  }

  close() {
    this._closed = true;
    this.ws?.close();
  }
}
