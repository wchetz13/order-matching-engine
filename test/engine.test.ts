import { beforeEach, describe, expect, it } from "vitest";

import { MatchingEngine } from "../src/engine.js";
import type { EngineEvent, LimitOrderRequest, Side } from "../src/types.js";

let engine: MatchingEngine;
let nextId = 0;

function limit(
  side: Side,
  price: number,
  quantity: number,
  extra: Partial<LimitOrderRequest> = {},
): EngineEvent[] {
  return engine.submit({ type: "limit", id: `o${++nextId}`, side, price, quantity, ...extra });
}

function trades(events: EngineEvent[]) {
  return events.flatMap((e) =>
    e.type === "trade" ? [{ price: e.price, quantity: e.quantity, maker: e.makerOrderId }] : [],
  );
}

beforeEach(() => {
  engine = new MatchingEngine();
  nextId = 0;
});

describe("resting and snapshots", () => {
  it("rests non-crossing orders and aggregates levels", () => {
    limit("buy", 99, 5);
    limit("buy", 99, 3);
    limit("buy", 98, 1);
    limit("sell", 101, 4);

    expect(engine.bestBid()).toBe(99);
    expect(engine.bestAsk()).toBe(101);
    expect(engine.snapshot()).toEqual({
      bids: [
        { price: 99, quantity: 8, orders: 2 },
        { price: 98, quantity: 1, orders: 1 },
      ],
      asks: [{ price: 101, quantity: 4, orders: 1 }],
    });
  });

  it("limits snapshot depth", () => {
    for (let price = 90; price < 100; price++) limit("buy", price, 1);
    expect(engine.snapshot(3).bids.map((l) => l.price)).toEqual([99, 98, 97]);
  });
});

describe("matching", () => {
  it("fills at the maker's price, not the taker's", () => {
    limit("sell", 100, 5);
    const events = limit("buy", 105, 5);
    expect(trades(events)).toEqual([{ price: 100, quantity: 5, maker: "o1" }]);
    expect(events.at(-1)).toEqual({ type: "filled", orderId: "o2" });
  });

  it("enforces price priority, then time priority", () => {
    limit("sell", 101, 2); // o1
    limit("sell", 100, 2); // o2: better price
    limit("sell", 100, 2); // o3: same price, later
    const events = limit("buy", 101, 5);
    expect(trades(events)).toEqual([
      { price: 100, quantity: 2, maker: "o2" },
      { price: 100, quantity: 2, maker: "o3" },
      { price: 101, quantity: 1, maker: "o1" },
    ]);
    expect(engine.getOrder("o1")?.remaining).toBe(1);
  });

  it("rests the unfilled remainder of a GTC order", () => {
    limit("sell", 100, 3);
    const events = limit("buy", 100, 10);
    expect(events.at(-1)).toEqual({ type: "rested", orderId: "o2", price: 100, remaining: 7 });
    expect(engine.bestBid()).toBe(100);
    expect(engine.bestAsk()).toBeUndefined();
  });

  it("works symmetrically for sell takers", () => {
    limit("buy", 99, 2);
    limit("buy", 100, 2);
    const events = limit("sell", 99, 3);
    expect(trades(events)).toEqual([
      { price: 100, quantity: 2, maker: "o2" },
      { price: 99, quantity: 1, maker: "o1" },
    ]);
  });
});

describe("time in force and market orders", () => {
  it("IOC cancels the unfilled remainder instead of resting", () => {
    limit("sell", 100, 3);
    const events = limit("buy", 100, 5, { timeInForce: "IOC" });
    expect(events.at(-1)).toEqual({
      type: "cancelled",
      orderId: "o2",
      remaining: 2,
      reason: "ioc",
    });
    expect(engine.openOrderCount).toBe(0);
  });

  it("FOK executes nothing when it cannot fill completely", () => {
    limit("sell", 100, 3);
    limit("sell", 102, 3);
    const events = limit("buy", 101, 4, { timeInForce: "FOK" });
    expect(trades(events)).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: "cancelled", reason: "fok", remaining: 4 });
    expect(engine.getOrder("o1")?.remaining).toBe(3);
  });

  it("FOK fills across levels when liquidity suffices", () => {
    limit("sell", 100, 3);
    limit("sell", 101, 3);
    const events = limit("buy", 101, 5, { timeInForce: "FOK" });
    expect(trades(events).map((t) => t.quantity)).toEqual([3, 2]);
    expect(events.at(-1)).toEqual({ type: "filled", orderId: "o3" });
  });

  it("market orders sweep the book and never rest", () => {
    limit("sell", 100, 2);
    limit("sell", 150, 2);
    const events = engine.submit({ type: "market", id: "m", side: "buy", quantity: 5 });
    expect(trades(events).map((t) => t.price)).toEqual([100, 150]);
    expect(events.at(-1)).toMatchObject({
      type: "cancelled",
      remaining: 1,
      reason: "market-unfilled",
    });
    expect(engine.bestAsk()).toBeUndefined();
  });
});

describe("cancellation", () => {
  it("cancels from the middle of a queue without disturbing priority", () => {
    limit("sell", 100, 1); // o1
    limit("sell", 100, 1); // o2
    limit("sell", 100, 1); // o3
    expect(engine.cancel("o2")).toEqual([
      { type: "cancelled", orderId: "o2", remaining: 1, reason: "user" },
    ]);
    const events = limit("buy", 100, 2);
    expect(trades(events).map((t) => t.maker)).toEqual(["o1", "o3"]);
  });

  it("removes the price level when its last order is cancelled", () => {
    limit("buy", 99, 1);
    limit("buy", 98, 1);
    engine.cancel("o1");
    expect(engine.bestBid()).toBe(98);
    engine.cancel("o2");
    expect(engine.snapshot().bids).toEqual([]);
  });

  it("rejects cancelling unknown or already-filled orders", () => {
    limit("sell", 100, 1);
    limit("buy", 100, 1);
    expect(engine.cancel("o1")[0]).toMatchObject({ type: "rejected" });
    expect(engine.cancel("nope")[0]).toMatchObject({ type: "rejected" });
  });
});

describe("validation", () => {
  it.each([
    [{ quantity: 0 }, "quantity"],
    [{ quantity: 1.5 }, "quantity"],
    [{ price: -1 }, "price"],
    [{ price: 100.25 }, "price"],
    [{ id: "" }, "non-empty"],
  ])("rejects %o", (overrides, reason) => {
    const events = engine.submit({
      type: "limit",
      id: "x",
      side: "buy",
      price: 100,
      quantity: 1,
      ...overrides,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "rejected" });
    expect(JSON.stringify(events[0])).toContain(reason);
  });

  it("rejects duplicate ids, even after the first order is gone", () => {
    engine.submit({ type: "market", id: "dup", side: "buy", quantity: 1 });
    const events = engine.submit({ type: "market", id: "dup", side: "buy", quantity: 1 });
    expect(events[0]).toMatchObject({ type: "rejected", reason: "duplicate order id" });
  });
});

describe("amend", () => {
  it("keeps queue priority when only reducing quantity", () => {
    limit("sell", 100, 5); // o1
    limit("sell", 100, 5); // o2
    expect(engine.amend("o1", { quantity: 2 })).toEqual([
      {
        type: "amended",
        orderId: "o1",
        price: 100,
        previousRemaining: 5,
        remaining: 2,
        priorityKept: true,
      },
    ]);
    expect(engine.snapshot().asks).toEqual([{ price: 100, quantity: 7, orders: 2 }]);
    expect(trades(limit("buy", 100, 3)).map((t) => [t.maker, t.quantity])).toEqual([
      ["o1", 2],
      ["o2", 1],
    ]);
  });

  it("loses priority when increasing quantity", () => {
    limit("sell", 100, 1); // o1
    limit("sell", 100, 1); // o2
    expect(engine.amend("o1", { quantity: 3 })[0]).toMatchObject({ priorityKept: false });
    expect(trades(limit("buy", 100, 2)).map((t) => t.maker)).toEqual(["o2", "o1"]);
  });

  it("moves the order to a new price level and back of its queue", () => {
    limit("buy", 99, 1); // o1
    limit("buy", 98, 1); // o2
    engine.amend("o1", { price: 98 });
    expect(engine.snapshot().bids).toEqual([{ price: 98, quantity: 2, orders: 2 }]);
    expect(trades(limit("sell", 98, 1)).map((t) => t.maker)).toEqual(["o2"]);
  });

  it("trades immediately when re-priced across the spread", () => {
    limit("sell", 101, 2); // o1
    limit("buy", 99, 5); // o2
    const events = engine.amend("o2", { price: 101 });
    expect(trades(events)).toEqual([{ price: 101, quantity: 2, maker: "o1" }]);
    expect(events.at(-1)).toEqual({ type: "rested", orderId: "o2", price: 101, remaining: 3 });
    expect(engine.bestBid()).toBe(101);
    expect(engine.bestAsk()).toBeUndefined();
  });

  it("reports a full fill when the re-priced order is consumed", () => {
    limit("sell", 101, 5);
    limit("buy", 99, 2);
    const events = engine.amend("o2", { price: 102 });
    expect(trades(events)).toEqual([{ price: 101, quantity: 2, maker: "o1" }]);
    expect(events.at(-1)).toEqual({ type: "filled", orderId: "o2" });
    expect(engine.getOrder("o2")).toBeUndefined();
  });

  it.each([
    [{ quantity: 0 }, "use cancel"],
    [{ quantity: 2.5 }, "quantity"],
    [{ price: 0 }, "price"],
    [{ price: 100, quantity: 5 }, "changes nothing"],
  ])("rejects %o", (changes, reason) => {
    limit("buy", 100, 5);
    const [event] = engine.amend("o1", changes);
    expect(event).toMatchObject({ type: "rejected" });
    expect(JSON.stringify(event)).toContain(reason);
    expect(engine.getOrder("o1")?.remaining).toBe(5);
  });

  it("rejects unknown orders", () => {
    expect(engine.amend("missing", { quantity: 1 })[0]).toMatchObject({ type: "rejected" });
  });
});
