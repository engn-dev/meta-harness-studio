---
name: api-conventions
description: How to add a new endpoint to acme-api the right way (routes, services, schemas, tests).
---

# Adding an endpoint to acme-api

1. Define the request/response shape in `src/schemas/` (zod).
2. Add the handler in `src/routes/` — keep it thin; delegate to a service.
3. Put business logic in `src/services/` with a unit test.
4. Access data only through `src/db/` repositories.
5. Add an integration test under `test/routes/`.
