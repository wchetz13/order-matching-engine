import { z } from "zod";

import type { Command } from "./journal.js";
import type { OrderRequest } from "./types.js";

/**
 * Wire-format schemas. These check shape and types at the system boundary;
 * business rules (positive quantities, unique ids) are enforced by the engine itself
 * so that library callers get the same guarantees as HTTP clients.
 */

const side = z.enum(["buy", "sell"]);

export const orderRequestSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("limit"),
      id: z.string(),
      side,
      price: z.number(),
      quantity: z.number(),
      timeInForce: z.enum(["GTC", "IOC", "FOK"]).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("market"),
      id: z.string(),
      side,
      quantity: z.number(),
    })
    .strict(),
]);

export const commandSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("submit"), order: orderRequestSchema }).strict(),
  z.object({ op: z.literal("cancel"), orderId: z.string() }).strict(),
]);

/** Convert parsed wire data to the engine's types, dropping absent optional fields. */
export function toOrderRequest(data: z.infer<typeof orderRequestSchema>): OrderRequest {
  if (data.type === "limit" && data.timeInForce === undefined) {
    const { timeInForce: _omitted, ...order } = data;
    return order;
  }
  return data as OrderRequest;
}

export function toCommand(data: z.infer<typeof commandSchema>): Command {
  return data.op === "submit" ? { op: "submit", order: toOrderRequest(data.order) } : data;
}
