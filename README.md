# soksak-plugin-clip

Clip — a soksak plugin that manages clipboard history and permanent memos grouped by category. Displayed as a right sidebar tab.
Two item types live inside: **clipboard** (auto-captured) and **memo** (user-written, permanent).

## Item Types

| Type | Behavior |
|---|---|
| **Clipboard** (clip) | Auto-captures system clipboard copy events via core `app.clipboard.watch` — absorbs OS-specific events into a single signal, zero polling. Duplicate content is merged and the copy count (`copyCount`) is incremented. |
| **Memo** (memo) | Written by the user. **Permanent** (not subject to automatic deletion). |

## Retention (Privacy)

Accumulating clipboard history over time is itself a risk (yesterday's copied password appearing in search results is a problem). Therefore:

- **Clipboard items that are not favorited are automatically deleted after the retention period (default 3 days, configurable 1–30 days).** Items remain searchable within the retention window.
- **Favorited** clips and **memos** are exempt from retention (permanent).
- Copying an item again resets its age, so frequently used clips survive while abandoned ones expire.
- The retention period is configured via `retentionDays` (manifest `configuration`).

## Categories

All items belong to a category (default **"Default"**). `category.add/rename/delete`. Deleting a category moves its items to the default category (not deleted); the default category cannot be renamed or deleted. The view supports filtering by category.

## Commands (All Features Exposed — CLI/MCP/View-Agnostic)

- `clip.*` — capture · list · search · favorite · category (move) · delete · restore · clear · count · state · **purge** (retention cleanup)
- `memo.*` — add · update · delete
- `category.*` — add · rename · delete · list

```
sok plugin.soksak-plugin-clip.clip.capture '{"text":"test"}'
sok plugin.soksak-plugin-clip.memo.add '{"content":"remember this","category":"Default"}'
sok plugin.soksak-plugin-clip.clip.purge          # clean up expired clips
```

## Data

Uses only core `app.data` (SQLite, plugin-exclusive namespace) — no raw SQL. Collections: `items` (kind/category/favorite/deleted/copyCount/at, FTS content), `cats` (name/order). CJK full-text search (FTS5 trigram). Soft delete via boolean `deleted`. Age (`at`) = capture or memo creation time, updated on re-copy (retention basis).

## Build / E2E

```
# No bundle — main.js is the entry directly (single ESM).
SOKSAK_SOCKET=~/.soksak/com.soksak.dev.sock node e2e/clip.mjs
```

Drives the app via socket JSON-RPC and asserts idempotent scenarios (capture · dedup · search · memo permanence · category move/rename/delete · retention purge [favorites and memos exempt] · trash). Auto-capture is verified via `clip.capture` (same utility as the watch callback) because the core suppresses self-write echoes in headless mode.

## Future Work (Out of Scope for This Release)

- Per-item selective encryption (user-opt-in) — first-line defense via retention (permanence = favorite); encryption is follow-up.
- Sensitive clip markers (macOS concealed/transient) skip — requires core watcher enhancements (follow-up).
