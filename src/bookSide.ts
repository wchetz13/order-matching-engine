import { PriceLevel } from "./priceLevel.js";
import type { Side } from "./types.js";

/**
 * One side of the book. Prices are kept in an array sorted worst-to-best, so the best
 * price is always at the end: reading or removing it is O(1). Inserting a new price level
 * is a binary search plus a splice; books rarely hold more than a few hundred levels,
 * where a contiguous array beats a balanced tree in practice.
 */
export class BookSide {
  private readonly prices: number[] = [];
  private readonly levels = new Map<number, PriceLevel>();

  constructor(readonly side: Side) {}

  /** True when price `a` is strictly better than `b` for this side. */
  isBetter(a: number, b: number): boolean {
    return this.side === "buy" ? a > b : a < b;
  }

  best(): PriceLevel | undefined {
    const price = this.prices.at(-1);
    return price === undefined ? undefined : this.levels.get(price);
  }

  getOrCreate(price: number): PriceLevel {
    const existing = this.levels.get(price);
    if (existing) return existing;
    const level = new PriceLevel(price);
    this.levels.set(price, level);
    this.prices.splice(this.insertionIndex(price), 0, price);
    return level;
  }

  removeLevel(price: number): void {
    if (!this.levels.delete(price)) return;
    const index = this.prices.at(-1) === price ? this.prices.length - 1 : this.indexOf(price);
    this.prices.splice(index, 1);
  }

  /** Levels from best to worst. */
  *bestFirst(): IterableIterator<PriceLevel> {
    for (let i = this.prices.length - 1; i >= 0; i--) {
      yield this.levels.get(this.prices[i] as number) as PriceLevel;
    }
  }

  private insertionIndex(price: number): number {
    let lo = 0;
    let hi = this.prices.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.isBetter(price, this.prices[mid] as number)) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private indexOf(price: number): number {
    const index = this.insertionIndex(price);
    if (this.prices[index] !== price) throw new Error(`price level ${price} not found`);
    return index;
  }
}
