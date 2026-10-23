import { BookSide } from "./bookSide.js";
import type { OrderNode, PriceLevel } from "./priceLevel.js";
import type {
  BookSnapshot,
  EngineEvent,
  LevelSnapshot,
  OrderRequest,
  RestingOrder,
  Side,
  TimeInForce,
} from "./types.js";

interface LiveOrder {
  readonly node: OrderNode;
  readonly level: PriceLevel;
  readonly side: BookSide;
}

/**
 * A single-instrument limit order book with price-time priority.
 *
 * The engine is deterministic: it reads no clocks or randomness, so the same sequence of
 * commands always produces the same events and the same book. That is what makes
 * journal replay (see journal.ts) a valid recovery mechanism.
 */
export class MatchingEngine {
  private readonly bids = new BookSide("buy");
  private readonly asks = new BookSide("sell");
  private readonly live = new Map<string, LiveOrder>();
  private readonly seenIds = new Set<string>();
  private sequence = 0;
  private tradeId = 0;

  submit(request: OrderRequest): EngineEvent[] {
    const rejection = this.validate(request);
    if (rejection) return [{ type: "rejected", orderId: request.id, reason: rejection }];

    this.seenIds.add(request.id);
    const sequence = ++this.sequence;
    const events: EngineEvent[] = [{ type: "accepted", orderId: request.id, sequence }];
    const opposite = request.side === "buy" ? this.asks : this.bids;
    const limit = request.type === "limit" ? request.price : undefined;
    const timeInForce: TimeInForce =
      request.type === "market" ? "IOC" : (request.timeInForce ?? "GTC");

    if (timeInForce === "FOK" && !this.canFill(opposite, request.side, limit, request.quantity)) {
      events.push({
        type: "cancelled",
        orderId: request.id,
        remaining: request.quantity,
        reason: "fok",
      });
      return events;
    }

    const remaining = this.match(request, opposite, limit, events);

    if (remaining === 0) {
      events.push({ type: "filled", orderId: request.id });
    } else if (timeInForce === "GTC" && limit !== undefined) {
      this.rest({
        id: request.id,
        side: request.side,
        price: limit,
        quantity: request.quantity,
        remaining,
        sequence,
      });
      events.push({ type: "rested", orderId: request.id, price: limit, remaining });
    } else {
      events.push({
        type: "cancelled",
        orderId: request.id,
        remaining,
        reason: request.type === "market" ? "market-unfilled" : "ioc",
      });
    }
    return events;
  }

  cancel(orderId: string): EngineEvent[] {
    const live = this.live.get(orderId);
    if (!live) return [{ type: "rejected", orderId, reason: "unknown or inactive order" }];
    const { remaining } = live.node.order;
    this.unlink(live);
    return [{ type: "cancelled", orderId, remaining, reason: "user" }];
  }

  snapshot(depth = 10): BookSnapshot {
    return { bids: this.depth(this.bids, depth), asks: this.depth(this.asks, depth) };
  }

  bestBid(): number | undefined {
    return this.bids.best()?.price;
  }

  bestAsk(): number | undefined {
    return this.asks.best()?.price;
  }

  getOrder(orderId: string): Readonly<RestingOrder> | undefined {
    return this.live.get(orderId)?.node.order;
  }

  get openOrderCount(): number {
    return this.live.size;
  }

  private validate(request: OrderRequest): string | undefined {
    if (request.id.length === 0) return "order id must be non-empty";
    if (this.seenIds.has(request.id)) return "duplicate order id";
    if (!isPositiveInteger(request.quantity)) return "quantity must be a positive integer";
    if (request.type === "limit" && !isPositiveInteger(request.price)) {
      return "price must be a positive integer number of ticks";
    }
    return undefined;
  }

  /** Walk the opposite side best-first, filling against makers in FIFO order. */
  private match(
    request: OrderRequest,
    opposite: BookSide,
    limit: number | undefined,
    events: EngineEvent[],
  ): number {
    let remaining = request.quantity;
    while (remaining > 0) {
      const level = opposite.best();
      if (!level || !crosses(request.side, limit, level.price)) break;

      while (remaining > 0 && level.head) {
        const makerNode = level.head;
        const maker = makerNode.order;
        const quantity = Math.min(remaining, maker.remaining);
        level.fill(makerNode, quantity);
        remaining -= quantity;
        events.push({
          type: "trade",
          tradeId: ++this.tradeId,
          price: level.price,
          quantity,
          takerOrderId: request.id,
          makerOrderId: maker.id,
          takerSide: request.side,
        });
        if (maker.remaining === 0) {
          level.remove(makerNode);
          this.live.delete(maker.id);
          events.push({ type: "filled", orderId: maker.id });
        }
      }
      if (level.isEmpty) opposite.removeLevel(level.price);
    }
    return remaining;
  }

  private canFill(
    opposite: BookSide,
    side: Side,
    limit: number | undefined,
    quantity: number,
  ): boolean {
    let available = 0;
    for (const level of opposite.bestFirst()) {
      if (!crosses(side, limit, level.price)) break;
      available += level.totalQuantity;
      if (available >= quantity) return true;
    }
    return false;
  }

  private rest(order: RestingOrder): void {
    const side = order.side === "buy" ? this.bids : this.asks;
    const level = side.getOrCreate(order.price);
    this.live.set(order.id, { node: level.push(order), level, side });
  }

  private unlink({ node, level, side }: LiveOrder): void {
    level.remove(node);
    this.live.delete(node.order.id);
    if (level.isEmpty) side.removeLevel(level.price);
  }

  private depth(side: BookSide, depth: number): LevelSnapshot[] {
    const levels: LevelSnapshot[] = [];
    for (const level of side.bestFirst()) {
      if (levels.length >= depth) break;
      levels.push({
        price: level.price,
        quantity: level.totalQuantity,
        orders: level.orderCount,
      });
    }
    return levels;
  }
}

/** Whether an incoming order on `side` with this limit can trade at `price`. */
function crosses(side: Side, limit: number | undefined, price: number): boolean {
  if (limit === undefined) return true;
  return side === "buy" ? price <= limit : price >= limit;
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
