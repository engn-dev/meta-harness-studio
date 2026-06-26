---
description: Review the current diff for correctness and simplicity.
argument-hint: "[path]"
---

Review the current diff for correctness bugs and obvious simplifications. Check
that request bodies are validated with the shared zod schemas and that no route
imports `src/db` directly. Focus on $ARGUMENTS if provided.
