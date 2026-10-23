import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../src/server.js";

let server: Server;
let base: string;

beforeEach(async () => {
  server = createApp();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function call(method: string, path: string, body?: unknown) {
  const init: RequestInit = { method };
  if (body !== undefined) init.body = typeof body === "string" ? body : JSON.stringify(body);
  const response = await fetch(base + path, init);
  const text = await response.text();
  const isJson = response.headers.get("content-type") === "application/json";
  return { status: response.status, body: isJson ? (JSON.parse(text) as unknown) : text };
}

const order = (id: string, side: string, price: number, quantity: number) => ({
  type: "limit",
  id,
  side,
  price,
  quantity,
});

describe("HTTP API", () => {
  it("reports health", async () => {
    expect(await call("GET", "/health")).toEqual({
      status: 200,
      body: { status: "ok", openOrders: 0 },
    });
  });

  it("matches orders and serves the book", async () => {
    await call("POST", "/orders", order("a", "sell", 100, 5));
    const fill = await call("POST", "/orders", order("b", "buy", 100, 2));
    expect(fill.status).toBe(200);
    expect(JSON.stringify(fill.body)).toContain('"type":"trade"');

    const book = await call("GET", "/book?depth=5");
    expect(book.body).toEqual({ bids: [], asks: [{ price: 100, quantity: 3, orders: 1 }] });
  });

  it("cancels orders and 404s unknown ones", async () => {
    await call("POST", "/orders", order("a", "buy", 99, 1));
    expect((await call("DELETE", "/orders/a")).status).toBe(200);
    expect((await call("DELETE", "/orders/a")).status).toBe(404);
  });

  it("records every command in the journal", async () => {
    await call("POST", "/orders", order("a", "buy", 99, 1));
    await call("DELETE", "/orders/a");
    const journal = await call("GET", "/journal");
    expect(String(journal.body).split("\n")).toHaveLength(2);
  });

  it.each([
    ["malformed JSON", "{not json", 400],
    ["wrong shape", { type: "limit", id: "x" }, 400],
    ["unknown field", { ...order("x", "buy", 1, 1), extra: true }, 400],
    ["business rule", order("x", "buy", 1, 0), 422],
  ])("rejects %s", async (_, body, status) => {
    expect((await call("POST", "/orders", body)).status).toBe(status);
  });

  it("rejects bodies over the size limit", async () => {
    const huge = JSON.stringify({ ...order("x", "buy", 1, 1), id: "x".repeat(70_000) });
    expect((await call("POST", "/orders", huge)).status).toBe(413);
  });

  it.each(["0", "abc", "1000"])("rejects depth=%s", async (depth) => {
    expect((await call("GET", `/book?depth=${depth}`)).status).toBe(400);
  });

  it("404s unknown routes", async () => {
    expect((await call("GET", "/nope")).status).toBe(404);
  });
});
