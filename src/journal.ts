import { MatchingEngine } from "./engine.js";
import { commandSchema, toCommand } from "./schema.js";
import type { EngineEvent, OrderRequest } from "./types.js";

/**
 * Event-sourcing support. Every state change is driven by a command; because the engine
 * is deterministic, replaying the command journal rebuilds the exact same book and
 * reproduces every event. This doubles as crash recovery and as an audit trail.
 */

export type Command =
  | { readonly op: "submit"; readonly order: OrderRequest }
  | { readonly op: "cancel"; readonly orderId: string };

export function apply(engine: MatchingEngine, command: Command): EngineEvent[] {
  return command.op === "submit" ? engine.submit(command.order) : engine.cancel(command.orderId);
}

export class Journal {
  private readonly commands: Command[] = [];

  record(command: Command): void {
    this.commands.push(command);
  }

  get length(): number {
    return this.commands.length;
  }

  toJsonl(): string {
    return this.commands.map((command) => JSON.stringify(command)).join("\n");
  }

  static fromJsonl(text: string): Command[] {
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line, index) => {
        const parsed = commandSchema.safeParse(JSON.parse(line));
        if (!parsed.success) {
          throw new Error(`invalid journal entry on line ${index + 1}: ${parsed.error.message}`);
        }
        return toCommand(parsed.data);
      });
  }
}

export function replay(commands: Iterable<Command>): {
  engine: MatchingEngine;
  events: EngineEvent[];
} {
  const engine = new MatchingEngine();
  const events: EngineEvent[] = [];
  for (const command of commands) events.push(...apply(engine, command));
  return { engine, events };
}
