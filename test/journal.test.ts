import { describe, expect, it } from "vitest";

import { type Command, Journal, replay } from "../src/journal.js";

describe("Journal", () => {
  it("round-trips commands through JSONL", () => {
    const journal = new Journal();
    const commands: Command[] = [
      { op: "submit", order: { type: "limit", id: "a", side: "sell", price: 100, quantity: 2 } },
      { op: "submit", order: { type: "market", id: "b", side: "buy", quantity: 1 } },
      { op: "amend", orderId: "a", changes: { quantity: 1 } },
      { op: "amend", orderId: "a", changes: { price: 101 } },
      { op: "cancel", orderId: "a" },
    ];
    commands.forEach((c) => {
      journal.record(c);
    });
    expect(journal.length).toBe(5);
    expect(Journal.fromJsonl(journal.toJsonl() + "\n\n")).toEqual(commands);
  });

  it("rejects malformed entries with the offending line number", () => {
    const text = ['{"op":"cancel","orderId":"a"}', '{"op":"submit","order":{"type":"limit"}}'].join(
      "\n",
    );
    expect(() => Journal.fromJsonl(text)).toThrow(/line 2/);
  });

  it("replay rebuilds the book", () => {
    const { engine } = replay([
      { op: "submit", order: { type: "limit", id: "a", side: "buy", price: 99, quantity: 5 } },
      { op: "submit", order: { type: "limit", id: "b", side: "sell", price: 99, quantity: 2 } },
    ]);
    expect(engine.snapshot().bids).toEqual([{ price: 99, quantity: 3, orders: 1 }]);
  });
});

describe("Journal replayability", () => {
  it("replays an empty amend, which the engine rejects but the journal must still accept", () => {
    const journal = new Journal();
    journal.record({
      op: "submit",
      order: { type: "limit", id: "a", side: "buy", price: 99, quantity: 1 },
    });
    journal.record({ op: "amend", orderId: "a", changes: {} });
    const { events } = replay(Journal.fromJsonl(journal.toJsonl()));
    expect(events.at(-1)).toMatchObject({ type: "rejected", reason: "amend changes nothing" });
  });
});
