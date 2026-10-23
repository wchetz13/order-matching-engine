import type { RestingOrder } from "./types.js";

export class OrderNode {
  prev: OrderNode | null = null;
  next: OrderNode | null = null;

  constructor(readonly order: RestingOrder) {}
}

/**
 * FIFO queue of orders at one price, as a doubly linked list so that
 * append, pop-front, and cancel-from-anywhere are all O(1).
 */
export class PriceLevel {
  head: OrderNode | null = null;
  private tail: OrderNode | null = null;
  private quantity = 0;
  private count = 0;

  constructor(readonly price: number) {}

  get totalQuantity(): number {
    return this.quantity;
  }

  get orderCount(): number {
    return this.count;
  }

  get isEmpty(): boolean {
    return this.count === 0;
  }

  push(order: RestingOrder): OrderNode {
    const node = new OrderNode(order);
    if (this.tail) {
      this.tail.next = node;
      node.prev = this.tail;
    } else {
      this.head = node;
    }
    this.tail = node;
    this.quantity += order.remaining;
    this.count += 1;
    return node;
  }

  /** Reduce an order's remaining quantity, keeping the level total in sync. */
  fill(node: OrderNode, quantity: number): void {
    node.order.remaining -= quantity;
    this.quantity -= quantity;
  }

  remove(node: OrderNode): void {
    if (node.prev) node.prev.next = node.next;
    else this.head = node.next;
    if (node.next) node.next.prev = node.prev;
    else this.tail = node.prev;
    node.prev = node.next = null;
    this.quantity -= node.order.remaining;
    this.count -= 1;
  }
}
