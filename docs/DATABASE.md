# Solo — Database (SQLite, per device)

Planned schema (Phase 5; migrations via numbered SQL files). All synced tables carry `id TEXT PK, updated_at INTEGER, deleted INTEGER, device_id TEXT`.

| Table | Key columns |
|---|---|
| `users` | id, name, kind(personal/guest), created_at |
| `memories` | id, scope, category, title, content, project, excluded, embedding BLOB |
| `conversations` | id, scope, mode, title, excluded_from_memory, summary |
| `messages` | id, conversation_id, role, content, model, tokens_in, tokens_out, cost_usd |
| `tasks` | id, title, target, actions JSON, status, checkpoint JSON |
| `devices` | id, kind, name, public_key, paired_at, last_seen |
| `settings` | key, value JSON (model routes, budget, voice, timeouts) |
| `usage` | id, ts, model, tokens_in, tokens_out, cost_usd |
| `sync_outbox` | id, table, row_id, payload, created_at |

Guest rows: `scope='guest'`, purged on session expiry unless the user promotes them.
PostgreSQL path: repositories behind interfaces; schema is portable (JSON → JSONB, BLOB → pgvector).
