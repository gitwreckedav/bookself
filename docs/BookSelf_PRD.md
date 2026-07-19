# BookSelf — Product Requirements Document

**Version:** 1.0   **Date:** 2026-07-19   **Owner:** AV
**Status:** locked   **Companion to:** BookSelf_BackendDoc.md, BookSelf_FrontendDoc.md, BookSelf_DevOpsDoc.md
**Governed by:** LivingDocs Protocol v1.1 (skill + reference live in `Speakeezy/Pre-Build Docs/`)

> **Provenance note:** BookSelf predates the LivingDocs protocol. This stack was created 2026-07-19
> as a formalization checkpoint ("retcon"). The Decision Log below is **backfilled** from git history,
> CLAUDE.md learned patterns, session memory, and the build conversations — dates are accurate where
> known, approximate (month-level) where reconstructed. From this point forward the log is append-only
> per protocol.

## §0.1 Version History

| Version | Date | Chat | Changes |
|---|---|---|---|
| 1.0 | 2026-07-19 | Fable checkpoint | First formalization. Full backfill of vision, feature inventory, decision log, open questions. |

## §0.2 Section Status Legend

`[locked]` = changing this requires a new Decision Log row. `[draft]` = still forming. `[needs-review]` = AV has not confirmed.

## §0.3 Cross-Doc Contracts

| This doc owns | Consumes from |
|---|---|
| Vision, scope, feature inventory, Decision Log, Open Questions, roadmap | Nothing — PRD is the root. All other docs consume decisions from here. |

---

## §1. Vision `[locked]`

**BookSelf is a local-first, privacy-first library for long-form reading.** It rescues paid/valued
newsletters from inbox death: pulls them from Gmail, stores them as offline HTML + images on the
user's machine, and serves a focused two-pane reading UI with notes, AI summaries (local LLM), and
reading stats. No cloud, no tracking, no third-party servers — the user owns every byte.

**Positioning (AV's brand thesis):** differentiation through privacy/security, adaptability, and
modularity — a platform that can grow across use cases (email newsletters today; clipped web
articles, daily AI digests, and email distribution next) without OS or vendor lock-in.

**User:** AV (single-user today). Architecture must not preclude "someone else clones and runs it."

## §2. Product principles `[locked]`

1. **Local-first**: all data on the user's machine. AI defaults to local Ollama. Localhost-only server.
2. **The user's data outlives the app**: user data lives outside the app bundle, survives updates, is never committed to git, and is rebuildable from Gmail (the de-facto remote backup).
3. **Modular platform**: acquisition (fetch) / cataloging (catalog) / serving (app) are separate, independently runnable stages.
4. **Two tracks**: dev (`python app.py`, repo data) and prod (`BookSelf.app`, Application Support data) — independent libraries, shared credentials.
5. **Never regress a working feature.** Polishing must not break function.

## §3. Feature inventory (current state, v1.3.3-dev) `[locked]`

| Area | Features | Status |
|---|---|---|
| Acquisition | Gmail OAuth (readonly), seed + incremental + per-sender sync, invariant-checked sync state, manifests | Shipped, stable |
| Cataloging | Series detection, HTML cleaning, image localization, tracking-pixel strip, FTS index, word counts, preview detection | Shipped, stable |
| Reading UI | Two-pane library, search (FTS), date/read filters, collapsible nav tree with family separators, reader with iframe isolation, dark/light article mode, per-article My Notes + AI Summary tabs, ⚡ quick-access marks, read tracking | Shipped, stable |
| AI | Per-article summaries via configurable provider (Ollama default; OpenAI-compatible; Anthropic), user-editable prompt with presets, model auto-discovery, think-tag stripping | Shipped, stable |
| Daily Brief | One AI digest per day (articles received that day), map-reduce over per-article summaries, briefs/ storage, pinned nav section, generate/read/delete UI | Shipped 2026-07-18, needs AV UAT |
| Stats | Streaks, word counts (7d/month/last month), GitHub-style heatmap calendar, monthly trend, per-publication counts | Shipped, stable |
| Theming | 6 themes via CSS variables (incl. theme-aware buttons, toggle, article background) | Shipped, stable |
| App shell | Native macOS window (pywebview), auto-update banner vs GitHub releases, launch-at-login toggle, multi-call binary | Shipped, stable |
| Settings | Collapsible sections + master collapser, in-app config.yaml editor, AI config editor with test, display scales, theme picker | Shipped, stable |

## §4. Decision Log `[locked]` — append-only

> Backfilled 2026-07-19. §Links use doc abbreviations: BE=BackendDoc, FE=FrontendDoc, DO=DevOpsDoc.

| # | Date | Decision | Alternatives | Rationale | Status | Links |
|---|---|---|---|---|---|---|
| 1 | 2026-02 | Local-first stack: Python/Flask + SQLite + files, localhost UI | Cloud app; Electron | Privacy thesis; zero infra; AV's SQL strength | locked | BE §1 |
| 2 | 2026-02 | Port 5001 | 5000 | macOS AirPlay squats 5000 | locked | BE §3 |
| 3 | 2026-02 | Two-stage pipeline: fetch.py (acquisition → data/raw) then catalog.py (indexing → db + newsletters/) | Single script | data/raw is immutable source of truth; catalog is re-runnable (`--full-purge`) without touching Gmail | locked | BE §2 |
| 4 | 2026-04 | Credentials at `~/.config/bookself/` — outside the repo | In-project + gitignore | Even careless `git add -A` cannot leak; survives repo deletion | locked | DO §5 |
| 5 | 2026-04 | User data (newsletters/, assets/, data/, *.db) gitignored; each machine rebuilds from Gmail | Commit data; LFS | Repo = code only; Gmail is the backup; privacy | locked | DO §5 |
| 6 | 2026-04 | Config split by concern: config.yaml (sources) vs ai_config.yaml (AI) | One file | Separate concerns = separate files (learned pattern) | locked | BE §4 |
| 7 | 2026-05 | AI provider plumbing is provider-agnostic; default Ollama (local) | Hardcode one provider | Privacy default + flexibility; never hardcode a model name (list via /api/tags) | locked | BE §6 |
| 8 | 2026-05 | Strip `<think>…</think>` from ALL provider output | Only known reasoning models | No-op when absent; qwen3/deepseek-r1 leak otherwise | locked | BE §6 |
| 9 | 2026-05 | Notes + AI summary in `.notes.md` sidecar next to the article HTML, not DB columns | DB columns | Human-readable, portable, survives DB rebuilds (`--full-purge` keeps user data) | locked | BE §5 |
| 10 | 2026-06 | Theming via CSS variables exclusively; THEMES map in JS; buttons/toggles/article bg all var-driven | Per-theme CSS classes | One mechanism; CSS vars can hold full gradient strings | locked | FE §4 |
| 11 | 2026-07-12 | Native app = pywebview shell + PyInstaller `.app` (desktop.py entry) | Electron/Tauri; browser-only | Zero new stack; wraps existing Flask; real window/dock/⌘Q | locked | DO §2 |
| 12 | 2026-07-12 | Frozen app re-invokes its own binary with `--run-fetch` / `--run-catalog` (multi-call dispatch) | Bundle Python; in-process threads | No interpreter inside .app; preserves subprocess/SSE streaming architecture | locked | BE §2, DO §2 |
| 13 | 2026-07-12 | Dual data roots: dev = repo folder; packaged = `~/Library/Application Support/BookSelf/`. Single choke point: `get_project_root()` in config_loader.py | Shared data dir | Prod library safe from dev experiments; app updates can never touch data | locked | BE §3, DO §3 |
| 14 | 2026-07-12 | Updates: GitHub Releases + CI on tag push + in-app banner (`/api/update-check`); manual replace | Sparkle-style self-update | True self-update needs code signing; banner+download is honest scope | locked | DO §4 |
| 15 | 2026-07-12 | Ship unsigned; user runs `xattr -cr` per downloaded update | $99/yr Apple Developer ID | Cost not justified single-user; revisit if distributing | locked | DO §4 |
| 16 | 2026-07-12 | No Claude co-author trailers in commits (history rewritten); "Built with Claude Code" in README only | Keep trailers | AV's professional positioning | locked | DO §6 |
| 17 | 2026-07-13 | Scheduled jobs run in-app only (timer + catch-up on launch), NOT launchd | launchd background job | AV's explicit choice — simplicity over background execution | locked | BE §7 |
| 18 | 2026-07-13 | Daily Brief scope = articles **received** that calendar day | Unread-only | Deterministic; re-generation stable; "catch me up" value prop | locked | BE §7 |
| 19 | 2026-07-13 | Brief email via Gmail API send scope (one-time re-consent) | SMTP app password | Same credential file; no stored passwords; privacy posture | locked | BE §7 |
| 20 | 2026-07-15 | GitHub releases ONLY at real product milestones; iteration = dev mode / local builds | Release per fix round | Download+replace+xattr per iteration wasted AV's time (his call) | locked | DO §4 |
| 21 | 2026-07-15 | lxml bundled in the app; html.parser is fallback only | html.parser only (lean build) | html.parser crashes on malformed attrs (2 lost editions); +15MB is fine | locked | DO §2 |
| 22 | 2026-07-17 | Brief generation = map-reduce: reuse/persist per-article sidecar summaries, then one synthesis pass | Single giant prompt | Bounded context on 8B local models; summaries cached for future briefs + ⚡ marks | locked | BE §7 |
| 23 | 2026-07-18 | Web clipper = Chromium MV3 extension (primary; Brave-native) + in-app "Add from URL" fallback | Bookmarklet; macOS share ext | Extension captures the RENDERED, logged-in page (AV's core requirement); bookmarklet blocked by mixed-content; URL-fetch can't see paywalled pages | locked | Open Q #1 |
| 24 | 2026-07-15 | App icon = glyph-on-transparency until a proper Icon Composer icon exists | Fight the plate | macOS 26 plates ALL legacy .icns; plateless needs Xcode's Icon Composer (not installed) | locked | DO §2 |
| 25 | 2026-07-19 | Living docs stack adopted: PRD + BackendDoc + FrontendDoc + DevOpsDoc in /docs/, unversioned canonical names; AGENTS.md for vendor portability | Keep CLAUDE.md-only | Continuity across models/vendors/humans; CLAUDE.md is Claude-specific | locked | all |

## §5. Open Questions `[draft]`

| # | Question | Context | Owner |
|---|---|---|---|
| 1 | Web clipper: fixed port for the packaged app (extension needs a predictable address) — which port, and what fallback discovery? | Decision #23; task queue #1 | Next build chat |
| 2 | Brief email layer: brief_config.yaml schema (recipients, schedule time, auto-send toggle) + Gmail scope migration UX (re-consent flow) | Decisions #17-19 | Next build chat |
| 3 | Configurable data folder with in-app migration (pointer file surviving updates) | Task queue; AV wants copy-from-within-app | Backlog |
| 4 | Keyboard shortcuts + ⌥-hold hotkey overlay + ribbon keyboard icon | AV specced 2026-07-13 | Backlog |
| 5 | Storage: assets/ is 3.2GB ×2 copies — image cache cap? slim dev library? | AV accepted duplication but flagged disk pressure | Backlog |
| 6 | CI builds on Python 3.12; dev venv is 3.14 — converge? | Works today; first suspect if CI-only bugs appear | Backlog |
| 7 | Proper app icon (AV designs; needs Icon Composer format for plateless look) | Decision #24 | AV |
| 8 | Monthly "Wrapped" stat card | AV: "sure, if not much work" | Backlog |

## §6. Roadmap (agreed order) `[locked]`

1. **Web clipper** (Open Q #1) — MV3 extension + hierarchy picker + `source='web'` editions + fixed port.
2. **Brief mailing + scheduler** (Open Q #2) — in-app timer w/ catch-up, Gmail send, recipients config.
3. Data-folder relocation, hotkeys/overlay, Wrapped card (Open Q #3, #4, #8).
4. Milestone release when 1+2 land and pass AV's UAT (per Decision #20).

## §7. Explicitly rejected (do not re-propose)

- macOS notifications for new arrivals — "just adds backlog" (AV, 2026-07-13).
- "Next up" reading queue — "unneeded and presumptuous" (AV, 2026-07-13).
- launchd background scheduling — see Decision #17.
- Human-recorded audio clips, notification-driven engagement patterns — against product ethos.

---

**End of BookSelf PRD v1.0**
