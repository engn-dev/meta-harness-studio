# acme-api

A TypeScript REST API. These instructions are the single source of truth for any
AI coding agent in this repo — `harness apply` projects them to every tool.

## Commands
- Build: `npm run build`
- Test: `npm test`
- Lint: `npm run lint`
- Typecheck: `npm run typecheck`

## Architecture
- `src/routes/` — HTTP handlers (thin; no business logic)
- `src/services/` — business logic, unit-tested
- `src/db/` — data access; never import `src/db` from `src/routes` directly

## Conventions
- Keep changes minimal and match the existing style.
- Validate all request bodies with the shared zod schemas in `src/schemas/`.
- Never commit secrets; configuration comes from environment variables.

<!-- harness:redundant -->
## Onboarding notes (demo)
This section is intentionally verbose, restating things already covered above in
more words than necessary. It inflates the context the model loads on every turn
without adding task value. Run `harness optimize` to watch the proposer remove it
while keeping the Commands, Architecture and Conventions intact — the eval search
set asserts those survive, so pass-rate stays flat while context tokens drop.
<!-- /harness:redundant -->
