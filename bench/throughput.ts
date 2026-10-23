/**
 * Throughput benchmark: a realistic mix of passive limits, aggressive limits, market orders,
 * and cancels around a mid price. Uses a seeded PRNG so runs are comparable.
 */
import { MatchingEngine } from "../src/engine.js";

const ORDERS = Number(process.env.ORDERS ?? 1_000_000);

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(42);
const engine = new MatchingEngine();
const live: string[] = [];
let trades = 0;

const start = process.hrtime.bigint();
for (let i = 0; i < ORDERS; i++) {
  const r = random();
  const side = random() < 0.5 ? "buy" : "sell";
  const quantity = 1 + Math.floor(random() * 100);
  const id = `o${i}`;
  let events;
  if (r < 0.15 && live.length > 0) {
    const index = Math.floor(random() * live.length);
    const target = live[index] as string;
    live[index] = live[live.length - 1] as string;
    live.pop();
    events = engine.cancel(target);
  } else if (r < 0.2) {
    events = engine.submit({ type: "market", id, side, quantity });
  } else {
    // Passive orders sit up to 50 ticks from mid; ~1 in 5 crosses the spread.
    const offset = Math.floor(random() * 50) - 10;
    const price = side === "buy" ? 10_000 - offset : 10_000 + offset;
    events = engine.submit({ type: "limit", id, side, price, quantity });
    live.push(id);
  }
  for (const e of events) if (e.type === "trade") trades++;
}
const seconds = Number(process.hrtime.bigint() - start) / 1e9;

console.log(`orders:        ${ORDERS.toLocaleString()}`);
console.log(`trades:        ${trades.toLocaleString()}`);
console.log(`resting:       ${engine.openOrderCount.toLocaleString()}`);
console.log(`elapsed:       ${seconds.toFixed(2)} s`);
console.log(`throughput:    ${Math.round(ORDERS / seconds).toLocaleString()} orders/s`);
console.log(`mean latency:  ${((seconds / ORDERS) * 1e6).toFixed(2)} µs/order`);
