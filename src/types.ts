/**
 * Prices and quantities are integers (price in ticks, quantity in lots) so matching is exact:
 * no floating-point rounding can create or destroy quantity.
 */

export type Side = "buy" | "sell";

/** GTC rests any remainder; IOC cancels it; FOK executes in full immediately or not at all. */
export type TimeInForce = "GTC" | "IOC" | "FOK";

export interface LimitOrderRequest {
  readonly type: "limit";
  readonly id: string;
  readonly side: Side;
  readonly price: number;
  readonly quantity: number;
  readonly timeInForce?: TimeInForce;
}

export interface MarketOrderRequest {
  readonly type: "market";
  readonly id: string;
  readonly side: Side;
  readonly quantity: number;
}

export type OrderRequest = LimitOrderRequest | MarketOrderRequest;

export interface RestingOrder {
  readonly id: string;
  readonly side: Side;
  readonly price: number;
  readonly quantity: number;
  remaining: number;
  /** Arrival sequence number; lower means earlier, which sets time priority. */
  readonly sequence: number;
}

export type CancelReason = "user" | "ioc" | "fok" | "market-unfilled";

export type EngineEvent =
  | { readonly type: "accepted"; readonly orderId: string; readonly sequence: number }
  | { readonly type: "rejected"; readonly orderId: string; readonly reason: string }
  | {
      readonly type: "trade";
      readonly tradeId: number;
      readonly price: number;
      readonly quantity: number;
      readonly takerOrderId: string;
      readonly makerOrderId: string;
      readonly takerSide: Side;
    }
  | {
      readonly type: "rested";
      readonly orderId: string;
      readonly price: number;
      readonly remaining: number;
    }
  | {
      readonly type: "cancelled";
      readonly orderId: string;
      readonly remaining: number;
      readonly reason: CancelReason;
    }
  | { readonly type: "filled"; readonly orderId: string };

export interface LevelSnapshot {
  readonly price: number;
  readonly quantity: number;
  readonly orders: number;
}

export interface BookSnapshot {
  readonly bids: LevelSnapshot[];
  readonly asks: LevelSnapshot[];
}
