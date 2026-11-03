import { BookSide } from "./bookSide.js";
import type { OrderNode, PriceLevel } from "./priceLevel.js";
import type {
  AmendRequest,
  BookSnapshot,
  EngineEvent,
  LevelSnapshot,
  OrderRequest,
  RestingOrder,
  Side,
  TimeInForce,
} from "./types.js";

export const UNKNOWN_ORDER = "unknown or inactive order";

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

    const remaining = this.match(
      request.id,
      request.side,
      request.quantity,
      opposite,
      limit,
      events,
    );

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
    if (!live) return [{ type: "rejected", orderId, reason: UNKNOWN_ORDER }];
    const { remaining } = live.node.order;
    this.unlink(live);
    return [{ type: "cancelled", orderId, remaining, reason: "user" }];
  }

  /**
   * Change a resting order's price and/or open quantity, following standard exchange
   * priority rules:
   *
   * - Reducing quantity at the same price keeps the order's place in the queue.
   * - Any price change or quantity increase loses priority: the order is re-sequenced as if
   *   newly arrived, and if the new price crosses the spread it trades immediately.
   */
  amend(orderId: string, changes: AmendRequest): EngineEvent[] {
    const live = this.live.get(orderId);
    if (!live) return [{ type: "rejected", orderId, reason: UNKNOWN_ORDER }];
    const order = live.node.order;
    const price = changes.price ?? order.price;
    const quantity = changes.quantity ?? order.remaining;
    const rejection = !isPositiveInteger(price)
      ? "price must be a positive integer number of ticks"
      : !isPositiveInteger(quantity)
        ? "quantity must be a positive integer; use cancel to remove an order"
        : price === order.price && quantity === order.remaining
          ? "amend changes nothing"
          : undefined;
    if (rejection) return [{ type: "rejected", orderId, reason: rejection }];

    const previousRemaining = order.remaining;
    const amended = {
      type: "amended" as const,
      orderId,
      price,
      previousRemaining,
      remaining: quantity,
    };
    if (price === order.price && quantity < previousRemaining) {
      live.level.reduce(live.node, previousRemaining - quantity);
      return [{ ...amended, priorityKept: true }];
    }

    this.unlink(live);
    const sequence = ++this.sequence;
    const events: EngineEvent[] = [{ ...amended, priorityKept: false }];
    const opposite = order.side === "buy" ? this.asks : this.bids;
    const remaining = this.match(orderId, order.side, quantity, opposite, price, events);
    if (remaining === 0) {
      events.push({ type: "filled", orderId });
    } else {
      this.rest({ ...order, price, remaining, sequence });
      events.push({ type: "rested", orderId, price, remaining });
    }
    return events;
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
    takerId: string,
    side: Side,
    quantity: number,
    opposite: BookSide,
    limit: number | undefined,
    events: EngineEvent[],
  ): number {
    let remaining = quantity;
    while (remaining > 0) {
      const level = opposite.best();
      if (!level || !crosses(side, limit, level.price)) break;

      while (remaining > 0 && level.head) {
        const makerNode = level.head;
        const maker = makerNode.order;
        const traded = Math.min(remaining, maker.remaining);
        level.reduce(makerNode, traded);
        remaining -= traded;
        events.push({
          type: "trade",
          tradeId: ++this.tradeId,
          price: level.price,
          quantity: traded,
          takerOrderId: takerId,
          makerOrderId: maker.id,
          takerSide: side,
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
