# Changelog

## 0.2.0 — 2026-10-28

### Added

- `MatchingEngine.amend(orderId, { price?, quantity? })` with exchange priority rules:
  - Reducing quantity at the same price keeps queue priority.
  - Increasing quantity or changing price loses priority.
  - Re-pricing across the spread trades immediately.
- `amended` event with `previousRemaining`, `remaining`, and `priorityKept`.
- `PATCH /orders/:id` endpoint and an `amend` journal command.
- Property tests now include amendments in random order flow, and quantity conservation accounts for amended quantity.

### Fixed

- The journal could record an amend that its own parser would not read back. Schemas now check shape only, and the engine enforces business rules, so every recorded command replays.

## 0.1.0 — 2026-10-23

- Initial release: price-time priority matching with limit (GTC/IOC/FOK) and market orders, event-sourced journal with deterministic replay, HTTP API, property-based tests, and CI.
