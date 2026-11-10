# ADR 0001: Persisted asynchronous jobs

- Status: accepted
- Date: 2026-11-11

## Context

Media conversion, offline speech recognition, transcript normalization, and note generation can take longer than a normal HTTP request. Clients need a stable way to submit work and retrieve its status and result after reconnecting. Workers must be restartable and multiple workers must be safe when PostgreSQL is used.

## Decision

The API stores a job and returns `202 Accepted` with a job ID. The API and worker run as separate containers from the same image. Job state and worker leases live in the configured database. SQLite is the single-worker local option; PostgreSQL is the multi-worker option. Workers periodically recover expired leases and retry failed jobs up to a configured limit.

## Consequences

- Clients poll the status and result endpoints.
- Restarted workers resume queued work from the database.
- A worker must share the upload volume with the API.
- SQLite remains intended for one local worker; PostgreSQL provides concurrent claims using row locks.
