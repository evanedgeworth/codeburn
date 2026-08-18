# Cursor

Cursor IDE chat history.

- **Source:** `src/providers/cursor.ts`
- **Loading:** lazy (`src/providers/index.ts:44-57`). The `node:sqlite` import is the heavy dependency that justifies lazy loading.
- **Test:** `tests/providers/cursor.test.ts` (77 lines), `tests/providers/cursor-bubble-dedup.test.ts` (176 lines)

## Where it reads from

A single SQLite database per platform:

| Platform | Path |
|---|---|
| macOS | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |
| Windows | `%APPDATA%/Cursor/User/globalStorage/state.vscdb` |
| Linux | `~/.config/Cursor/User/globalStorage/state.vscdb` |

## Storage format

SQLite. Two parallel sources within the same db:

1. **Bubbles** (`cursor.ts:201-331`): per-message rows. The richer source.
2. **agentKv** (`cursor.ts:350-460`): per-conversation key-value blobs. The fallback for older sessions.

The parser tries both and dedupes via `seenKeys`.

## Caching

`src/cursor-cache.ts` writes `~/.cache/codeburn/cursor-results.v<n>.json` (override with `$CODEBURN_CACHE_DIR`). The unsuffixed `cursor-results.json` is left for older binaries; a matching-version copy is adopted once and never overwritten. The fingerprint is `dbMtimeMs + dbSizeBytes` of `state.vscdb`. Atomic write via temp + rename.

The optional server-export store lives at `~/.config/codeburn/cursor-usage.json` (override with `$CODEBURN_CURSOR_USAGE_STORE`). Its file metadata participates in the session and daily-cache fingerprints, so a new import invalidates stale local estimates without touching Cursor's database.

## Server export reconciliation

Cursor does not write output and cache-token billing details into the local database. CodeBurn can reconcile local session attribution with a usage CSV exported from the Cursor dashboard:

```bash
codeburn cursor-import ~/Downloads/usage-events.csv
codeburn cursor-import                  # show current import status
```

The importer requires date or timestamp and model columns, plus at least one token or cost column. It accepts common header variants for input, output, cache-read, cache-write, total cost, and total cents. Quoted CSV cells are supported.

Reconciliation rules:

- Server-export totals are authoritative by local day and normalized model through the latest imported event.
- Matching local calls retain their project, session, tool, and shell-command attribution. Server token and cost totals are distributed across those calls without changing the aggregate.
- Server rows with no matching local call are emitted once under the orphan Cursor project so usage is not lost.
- Local calls after the latest imported event remain estimated until a later export is imported.
- Overlapping exports are safe to import repeatedly. Stable row identities deduplicate them.
- The normalized store contains usage fields, timestamps, model names, and the optional usage kind. It does not copy prompts, generated text, account email, or browser credentials. The file is written privately with mode `0600`.

The menubar reports the share of Cursor tokens that is server-measured and labels the remainder locally estimated. CodeBurn does not scrape browser cookies or Cursor's private APIs. Individual subscriptions use the CSV path; a future team-admin connector can use the same reconciliation layer without changing local attribution.

## Deduplication

- Bubbles: per `bubbleId` (`cursor.ts:282`).
- agentKv: per `requestId` (`cursor.ts:429`).

## Quirks

- **180-day lookback.** The bubbles query bounds itself to the trailing 180 days (`cursor.ts:205`). Older history is ignored. If a user reports "Cursor data missing", confirm the date range first.
- **250 000 bubble cap.** Power users with massive history are capped to prevent unbounded memory. If you need to raise this, also raise the cache size budget.
- **Per-conversation user-message queue.** The parser caches the user-message stream per conversation to avoid an O(n) shift on every turn (`cursor.ts:171-191`).
- **agentKv has no per-message timestamp.** The DB file's mtime is used as the timestamp for every agentKv-derived call (`cursor.ts:358-363`). This is wrong but consistent.
- **Cursor v3 can report zero token counts.** The parser uses the conversation context meter when present and falls back to char-counting (`CHARS_PER_TOKEN = 4`) when no usable meter exists.

## When fixing a bug here

1. **Always reproduce against a fixture, not a real db.** SQLite over the live db is racy; the user might be using Cursor while you read.
2. If the bug is "tokens are zero", check whether the row is a v3 zero-token bubble, in which case the char-fallback should kick in.
3. If the bug is "duplicate counts", check both `bubbleId` dedup and the cross-provider `seenKeys` dedup.
4. Cache poisoning is the most common failure mode after a Cursor schema change. Bump `CURSOR_CACHE_VERSION` in `src/cursor-cache.ts` so old caches are invalidated.
