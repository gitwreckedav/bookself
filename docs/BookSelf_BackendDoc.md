# BookSelf — Backend Doc

**Version:** 1.0   **Date:** 2026-07-19   **Owner:** AV
**Status:** locked   **Companion to:** BookSelf_PRD.md, BookSelf_FrontendDoc.md, BookSelf_DevOpsDoc.md
**Governed by:** LivingDocs Protocol v1.1

## §0.1 Version History

| Version | Date | Chat | Changes |
|---|---|---|---|
| 1.0 | 2026-07-19 | Fable checkpoint | First formalization from live codebase. |

## §0.2 Section Status Legend

`[locked]` / `[draft]` / `[needs-review]` per protocol.

## §0.3 Cross-Doc Contracts

| This doc owns | Consumes from |
|---|---|
| **The FE–BE seam**: every API route, request/response shape, SSE token vocabulary. Data model, file layout, pipeline semantics, AI plumbing. | PRD: decisions #1-9, 12-13, 17-19, 21-22. DevOpsDoc: frozen-mode path rules. |

---

## §1. Architecture `[locked]`

```
Gmail API ──> fetch.py ──> data/raw/*.json  (immutable source of truth)
                              │
              catalog.py ─────┴──> bookself.db (SQLite + FTS5)
                                   newsletters/<folder>/[series/]*.html (+ .notes.md sidecars)
                                   assets/<folder>/*  (localized images)
                              │
              app.py (Flask, 127.0.0.1:5001) ──> two-pane SPA (vanilla JS)
              desktop.py (pywebview shell + multi-call dispatch)   [packaged app only]
```

- `bookself/` package: `config_loader.py` (config + **path resolution choke point**), `gmail_client.py`
  (OAuth; creds at `~/.config/bookself/`), `email_parser.py` (HTML clean, series detect, tracking-pixel
  strip), `database.py` (all SQL), `storage.py` (image extraction, file paths).
- **Path rule (PRD #13):** NEVER derive data paths from `__file__`. Always `get_project_root()`
  (dev → repo; frozen → `~/Library/Application Support/BookSelf`). Bundle assets (templates/static)
  come from `get_bundle_root()`. Violating this broke prod sync once already (fixed 2026-07-15).

## §2. Pipeline semantics `[locked]`

- **fetch.py**: `--mode seed` (from `seed_start_date`) | `--mode incremental` (after
  `last_successful_sync_epoch_ms` in `data/state/sync_state.json`) | `--sender X` (one source).
  Writes raw JSON + manifest; updates sync state ONLY if the invariant check passes.
- **catalog.py**: idempotent; skips already-cataloged (by `gmail_message_id`); `--audit` dry-run;
  `--full-purge` wipes db+files and rebuilds from data/raw (user data in sidecars survives);
  `--start-date` purges pre-date entries (seed cleanup); `--wipe-user-data` also clears sidecars.
- **Frozen mode (PRD #12):** app.py builds subprocess commands as
  `[sys.executable, '--run-fetch'|'--run-catalog', …args]`; desktop.py dispatches before importing
  GUI. Dev mode uses `[sys.executable, '-u', script.py, …]`. The `-u` flag must NOT be passed to the
  frozen binary.

## §3. Data model `[locked]`

**newsletters** (SQLite): `id, gmail_message_id (UNIQUE), publication, series (NULL for flat),
title, author, date_received (YYYY-MM-DD), file_path (relative to data root), word_count,
has_images, is_preview, preview_label, fetched_at, is_read, read_at`.
**newsletters_fts** (FTS5, title + full_text) with sync triggers.
Migrations: `init_db()` runs idempotently on every app start (PRD principle: data outlives app).

**File-side user data** (not in DB): `<article>.notes.md` sidecars — format
`## My Notes\n…\n---\n## AI Summary\nGenerated: <ts> · <model> via <provider>\n\n…`
(parse/build via `_parse_notes`/`_build_notes` in app.py). `data/state/user_data.json` = misc
per-message state. `briefs/YYYY-MM-DD.md` = daily briefs with YAML-ish front-matter
(date/articles/generated/model).

## §4. Configuration `[locked]`

- `config.yaml` (sources): `settings.{seed_start_date, db_path, newsletters_dir, assets_dir}` +
  `sources[]` (`name, folder, sender, type: simple|series, known_series, skip_truncated, full_content`).
  Paths are relative to the data root. Editable in-app (Settings → Configuration).
- `ai_config.yaml`: `provider (ollama|openai|anthropic|custom), model, base_url, api_key, max_words,
  summary_prompt`. Defaults merged in `load_ai_config()`. First run of packaged app seeds both files
  from bundle copies.

## §5. API surface — the seam (FE consumes, never redefines) `[locked]`

| Route | Notes |
|---|---|
| `GET /` , `/newsletter-assets/<path>` | SPA shell; localized images |
| `GET /api/status` | `{total_newsletters, last_synced, platform}` |
| `GET /api/publications`, `/api/publications/<pub>/series` | Nav tree; includes counts + `ai_summary_count` |
| `GET /api/newsletters?pub&series&limit&offset&sort` | Each record includes `has_ai_summary` (sidecar check) |
| `GET /api/newsletters/<id>`, `/content` | Record; reader HTML |
| `POST /api/newsletters/<id>/toggle-read` | Sets `read_at`; returns `{is_read}` |
| `GET /api/overview/publication/<pub>`, `/series/<pub_and_series>` | Landing summaries |
| `GET /api/search?q=` | FTS5 |
| `GET/POST /api/config` | Raw YAML in/out; validates before save |
| `GET /api/sync/state`, `POST /api/sync` | Sync = **SSE stream**; tokens: `[STAGE_1_COMPLETE]`, `[SYNC_COMPLETE]`, `[SYNC_ERROR] <msg>`; body `{mode: seed|incremental, start_date?, sender?, wipe_user_data?}` |
| `GET/POST /api/newsletters/<id>/note` | `{my_notes, ai_summary, has_note}`; POST writes sidecar |
| `POST /api/newsletters/<id>/generate-summary` | Blocking; returns `{ok, ai_summary}` or `{ok:false, error}` |
| `GET/POST /api/ai-config`, `POST /test`, `GET /models` | AI settings; test connection; installed-model discovery |
| `GET /api/stats` | All stats incl. `words_last_7/this_month/last_month`, streaks, `read_by_date` |
| `POST /api/reveal` | Show file in Finder/Explorer |
| `POST /api/briefs/generate` `{date?}` | 409 if running; background thread; poll `GET /api/briefs/status` (`{running, date, stage, done, total, error}`) |
| `GET /api/briefs`, `GET/DELETE /api/briefs/<date>` | List; `{date, meta, content}` |
| `GET /api/version`, `/api/update-check`, `POST /api/open-release` | `{version, packaged}`; GitHub latest-release compare |
| `GET/POST /api/autostart` | LaunchAgent plist write/remove (login launch, NOT scheduling) |

## §6. AI plumbing `[locked]`

`_ai_complete(prompt, cfg)` routes to `_call_ollama` (uses `/api/chat` with `think:false`) /
`_call_openai_compatible` / `_call_anthropic`. Rules: never hardcode a model (discover via Ollama
`/api/tags`); strip `<think>…</think>` from ALL output (PRD #8); empty-model → clear user-facing
error BEFORE the call; user's `summary_prompt` is the instruction, backend appends title/publication/
text (truncated to `max_words`).

## §7. Daily Brief engine `[locked]` (PRD #17-19, #22)

`_generate_brief_worker(date)` in a daemon thread, single job (`_brief_status` dict is the contract):
1. `_articles_for_date` — received that day (PRD #18).
2. `_get_or_make_summary` per article — sidecar reuse; generates + persists if missing (⚡ appears).
3. One synthesis call (`_BRIEF_SYNTHESIS_PROMPT`): "Top of the day" + per-article sections.
4. Writes `briefs/<date>.md` with front-matter.
**Next (Open Q #2):** mail layer (Gmail `gmail.send` scope, `brief_config.yaml`) + in-app scheduler
with catch-up-on-launch (PRD #17). Scheduler must drive both sync and briefs.

---

**End of BookSelf BackendDoc v1.0**
