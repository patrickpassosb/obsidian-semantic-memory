# ADR-0001: Ledger-first durable memory

## Status
Accepted (2026-09-08). Proven in production on the VPS brain.

## Context
Agents need facts that survive index deletion, tool changes, and model changes.
The obvious design (facts live in the index DB, notes live in the vault) makes
the database authoritative — so the database becomes a thing that can be lost,
and vendor lock-in creeps back in.

## Decision
The append-only ledger (markdown, in the Vault, git-tracked) is the only
authoritative store of memory events. SQLite facts are a derived cache,
rebuilt by replaying the ledger. `supersede` closes the old fact (valid_to)
and stores the new one; history stays queryable; current-state reads are the
default.

## Consequences
+ Deleting the index is harmless: replay reconstructs full history (proven live).
+ The entire memory is human-readable and portable — grandma can own her memory.
+ Cross-agent writes converge in one place (git), not per-tool databases.
− Every durable write costs a file append + git commit (write amplification).
− Rebuild time grows with ledger size (fine: a life is small; see CONTEXT.md).
− Idempotency and ordering must be handled in application code.
