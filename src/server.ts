import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { MatchingEngine } from "./engine.js";
import { apply, type Command, Journal } from "./journal.js";
import { orderRequestSchema, toOrderRequest } from "./schema.js";

const MAX_BODY_BYTES = 64 * 1024;
const MAX_DEPTH = 100;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * HTTP adapter over the engine, built on node:http with no framework.
 * Every command, including rejected ones, is journaled before it executes; replay reproduces rejections too.
 *
 *   GET    /health
 *   GET    /book?depth=10
 *   POST   /orders          body: OrderRequest
 *   DELETE /orders/:id
 *   GET    /journal         newline-delimited JSON of all commands
 */
export function createApp(engine = new MatchingEngine(), journal = new Journal()): Server {
  const execute = (command: Command) => {
    journal.record(command);
    return apply(engine, command);
  };

  return createServer((req, res) => {
    route(req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError ? error.message : "internal error";
      send(res, status, { error: message });
    });
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (req.method === "GET" && path === "/health") {
      send(res, 200, { status: "ok", openOrders: engine.openOrderCount });
      return;
    }
    if (req.method === "GET" && path === "/book") {
      const depth = Number(url.searchParams.get("depth") ?? 10);
      if (!Number.isInteger(depth) || depth < 1 || depth > MAX_DEPTH) {
        throw new HttpError(400, `depth must be an integer from 1 to ${MAX_DEPTH}`);
      }
      send(res, 200, engine.snapshot(depth));
      return;
    }
    if (req.method === "GET" && path === "/journal") {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.end(journal.toJsonl());
      return;
    }
    if (req.method === "POST" && path === "/orders") {
      const parsed = orderRequestSchema.safeParse(await readJson(req));
      if (!parsed.success)
        throw new HttpError(400, parsed.error.issues[0]?.message ?? "invalid order");
      const events = execute({ op: "submit", order: toOrderRequest(parsed.data) });
      send(res, events[0]?.type === "rejected" ? 422 : 200, { events });
      return;
    }
    const cancel = /^\/orders\/([^/]+)$/.exec(path);
    if (req.method === "DELETE" && cancel?.[1]) {
      const events = execute({ op: "cancel", orderId: decodeURIComponent(cancel[1]) });
      send(res, events[0]?.type === "rejected" ? 404 : 200, { events });
      return;
    }
    throw new HttpError(404, "not found");
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "body must be valid JSON");
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
