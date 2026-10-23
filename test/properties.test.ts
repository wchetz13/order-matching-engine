/**
 * Property-based tests: generate random command sequences and check invariants that must
 * hold for any market activity, not just hand-picked scenarios.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { MatchingEngine } from "../src/engine.js";
import { apply, type Command, Journal, replay } from "../src/journal.js";
import type { EngineEvent } from "../src/types.js";

const commandsArb = fc
  .array(
    fc.oneof(
      { weight: 6, arbitrary: fc.constant("submit" as const) },
      { weight: 1, arbitrary: fc.constant("cancel" as const) },
    ),
    { maxLength: 200 },
  )
  .chain((ops) =>
    fc.tuple(
      ...ops.map((op, i) =>
        op === "cancel"
          ? fc.nat({ max: Math.max(i - 1, 0) }).map((j): Command => ({ op, orderId: `o${j}` }))
          : fc
              .record({
                side: fc.constantFrom("buy" as const, "sell" as const),
                price: fc.integer({ min: 95, max: 105 }),
                quantity: fc.integer({ min: 1, max: 20 }),
                kind: fc.constantFrom("GTC", "IOC", "FOK", "market"),
              })
              .map(({ side, price, quantity, kind }): Command => ({
                op: "submit",
                order:
                  kind === "market"
                    ? { type: "market", id: `o${i}`, side, quantity }
                    : { type: "limit", id: `o${i}`, side, price, quantity, timeInForce: kind },
              })),
      ),
    ),
  );

describe("invariants under random order flow", () => {
  it("the book is never crossed and level totals match their orders", () => {
    fc.assert(
      fc.property(commandsArb, (commands) => {
        const engine = new MatchingEngine();
        for (const command of commands) {
          apply(engine, command);
          const bid = engine.bestBid();
          const ask = engine.bestAsk();
          if (bid !== undefined && ask !== undefined) expect(bid).toBeLessThan(ask);
        }
        const { bids, asks } = engine.snapshot(Number.MAX_SAFE_INTEGER);
        const restingFromLevels = [...bids, ...asks].reduce((sum, l) => sum + l.quantity, 0);
        const restingFromOrders = commands
          .map((c) => (c.op === "submit" ? engine.getOrder(c.order.id)?.remaining : 0))
          .reduce<number>((sum, q) => sum + (q ?? 0), 0);
        expect(restingFromLevels).toBe(restingFromOrders);
      }),
    );
  });

  it("conserves quantity: every lot is traded, resting, or cancelled", () => {
    fc.assert(
      fc.property(commandsArb, (commands) => {
        const { engine, events } = replay(commands);
        for (const command of commands) {
          if (command.op !== "submit") continue;
          const id = command.order.id;
          if (events.some((e) => e.type === "rejected" && e.orderId === id)) continue;
          const traded = sum(
            events,
            (e) => e.type === "trade" && (e.takerOrderId === id || e.makerOrderId === id),
          );
          const cancelled = events
            .filter((e) => e.type === "cancelled" && e.orderId === id)
            .reduce((s, e) => s + (e.type === "cancelled" ? e.remaining : 0), 0);
          const resting = engine.getOrder(id)?.remaining ?? 0;
          expect(traded + cancelled + resting).toBe(command.order.quantity);
        }
      }),
    );
  });

  it("never trades through a limit price", () => {
    fc.assert(
      fc.property(commandsArb, (commands) => {
        const limits = new Map<string, { side: string; price: number }>();
        for (const c of commands) {
          if (c.op === "submit" && c.order.type === "limit") {
            limits.set(c.order.id, { side: c.order.side, price: c.order.price });
          }
        }
        for (const event of replay(commands).events) {
          if (event.type !== "trade") continue;
          for (const id of [event.takerOrderId, event.makerOrderId]) {
            const order = limits.get(id);
            if (!order) continue;
            if (order.side === "buy") expect(event.price).toBeLessThanOrEqual(order.price);
            else expect(event.price).toBeGreaterThanOrEqual(order.price);
          }
        }
      }),
    );
  });

  it("is deterministic: replaying a serialized journal reproduces every event and the book", () => {
    fc.assert(
      fc.property(commandsArb, (commands) => {
        const journal = new Journal();
        const engine = new MatchingEngine();
        const live: EngineEvent[] = [];
        for (const command of commands) {
          journal.record(command);
          live.push(...apply(engine, command));
        }
        const rebuilt = replay(Journal.fromJsonl(journal.toJsonl()));
        expect(rebuilt.events).toEqual(live);
        expect(rebuilt.engine.snapshot(1000)).toEqual(engine.snapshot(1000));
      }),
    );
  });
});

function sum(events: EngineEvent[], match: (e: EngineEvent) => boolean): number {
  return events.reduce((s, e) => s + (match(e) && e.type === "trade" ? e.quantity : 0), 0);
}
