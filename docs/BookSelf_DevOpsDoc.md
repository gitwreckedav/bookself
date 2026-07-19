# BookSelf — DevOps Doc

**Version:** 1.0   **Date:** 2026-07-19   **Owner:** AV
**Status:** locked   **Companion to:** BookSelf_PRD.md, BookSelf_BackendDoc.md, BookSelf_FrontendDoc.md
**Governed by:** LivingDocs Protocol v1.1

## §0.1 Version History

| Version | Date | Chat | Changes |
|---|---|---|---|
| 1.0 | 2026-07-19 | Fable checkpoint | First formalization. |

## §0.2 Section Status Legend

`[locked]` / `[draft]` / `[needs-review]` per protocol.

## §0.3 Cross-Doc Contracts

| This doc owns | Consumes from |
|---|---|
| Environments, build/packaging, CI/CD, release policy, storage map, git hygiene | PRD decisions #11-16, #20-21, #24. BackendDoc §1-2 path rules. |

---

## §1. Environments `[locked]`

| | Dev / UAT | Prod |
|---|---|---|
| Run | `cd bookself && source .venv/bin/activate && python app.py` | `BookSelf.app` (pywebview window) |
| Data root | repo folder | `~/Library/Application Support/BookSelf/` |
| Library | independent dev copy | independent prod copy — **AV reads here only** |
| Port | 5001 fixed | 5001 if free, else ephemeral |
| Python | .venv 3.14 | CI builds with 3.12 (Open Q #6) |

Credentials shared by both: `~/.config/bookself/credentials.json` + `token.json`. Flask has **no
auto-reload** (`use_reloader=False`) — Python changes need a manual restart; prefer JS/CSS-only
changes for UI iteration (hard-reload only).

## §2. Build & packaging `[locked]`

- Entry: `desktop.py` (multi-call dispatch first, then pywebview window on a Flask daemon thread).
- `pyinstaller bookself.spec --noconfirm` → `dist/BookSelf.app` (~140MB). Spec reads `APP_VERSION`
  from app.py via regex (no drift). Bundles: templates, static, default configs, lxml (PRD #21).
  `console=False`, unsigned.
- Icon: `packaging/BookSelf.icns` — glyph-on-transparency (macOS 26 plates all legacy icons; PRD #24).
  Regeneration script pattern lives in session scratch; artwork decisions are AV's.
- Local builds carry **no quarantine** — open `dist/BookSelf.app` directly for prod-shell UAT.

## §3. Data persistence through updates `[locked]`

Replacing the .app touches only code. `get_project_root()` resolves the same Application Support dir;
`init_db()` migrates schema idempotently on start; configs are seeded only if absent. User data is
never inside the bundle. The un-backed-up asset is the user-generated layer (sidecars, read states,
briefs, `data/state/`) — Gmail can rebuild everything else.

## §4. Release policy & CI `[locked]` (PRD #14-15, #20)

**Releases ONLY at real product milestones (AV directive 2026-07-15).** Iteration = dev mode or local
builds. When a milestone is called:
1. Bump `APP_VERSION` in app.py → commit → push.
2. `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. `.github/workflows/release.yml`: macos runner → guard (tag must equal APP_VERSION, build fails
   otherwise) → pyinstaller → `ditto` zip → Release with `BookSelf-macOS.zip`.
4. Installed apps show the update banner (`/api/update-check` vs latest tag). User downloads,
   replaces in Applications, runs `xattr -cr /Applications/BookSelf.app` (unsigned → quarantined).

## §5. Git & data hygiene `[locked]` (PRD #4-5, #16)

- Never tracked: `newsletters/ assets/ data/ briefs/ *.db credentials token.json .env dist/ build/`.
  Verify with `git ls-files | grep -E "newsletters/|assets/|data/|briefs/|\.db"` → must be empty.
- Credentials live outside the repo entirely (`~/.config/bookself/`).
- **No AI co-author trailers in commits** (PRD #16). Commit per milestone; verify with `git log`
  before claiming a commit exists.
- Remote: `github.com/gitwreckedav/bookself` (source only; binaries via Releases).

## §6. Storage map (2026-07-19) `[locked]`

| Location | ~Size | Notes |
|---|---|---|
| repo (dev data incl. 3.2GB assets/) | 3.7GB | slimmable (Open Q #5) |
| `~/Library/Application Support/BookSelf/` | 3.4GB | prod library |
| `~/.config/bookself/` | 8KB | credentials |
| dist/ + build/ | 0 when cleaned | regenerable; delete freely |

---

**End of BookSelf DevOpsDoc v1.0**
