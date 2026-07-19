# BookSelf — Agent & Developer Entry Point

You are working on **BookSelf**, a local-first newsletter library (Python/Flask + SQLite + vanilla
JS + PyInstaller macOS app). This file is the vendor-neutral entry point — it works the same whether
you are Claude, Codex, another AI stack, or a human developer joining cold.

## Read these first, in order

1. [docs/BookSelf_PRD.md](docs/BookSelf_PRD.md) — vision, feature inventory, **Decision Log**
   (chronological, append-only — do NOT re-litigate locked decisions), Open Questions, roadmap.
2. [docs/BookSelf_BackendDoc.md](docs/BookSelf_BackendDoc.md) — architecture, data model, **the API
   seam** (backend owns it; frontend consumes it), pipeline + AI plumbing.
3. [docs/BookSelf_FrontendDoc.md](docs/BookSelf_FrontendDoc.md) — UI structure, design tokens/themes,
   UX conventions, regression watchlist.
4. [docs/BookSelf_DevOpsDoc.md](docs/BookSelf_DevOpsDoc.md) — dev vs prod environments, packaging,
   CI/CD, release policy, git hygiene.

These are LIVING docs governed by the LivingDocs Protocol: unversioned canonical filenames, version
history inside each doc, one Decision Log (PRD only). **If your change makes a decision, append a
Decision Log row. If it touches another doc's territory, update that doc in the same session.**

## Non-negotiable working rules (vendor-neutral distillation)

1. **Verify before claiming.** Never say done/fixed/committed without proof in the same session:
   `git log` for commits, test output for tests, an HTTP request or screenshot for behavior.
2. **Never regress a working feature.** The owner's hardest rule. When touching shared CSS/JS, check
   the neighbors (FrontendDoc §5 watchlist).
3. **Multi-item requests → numbered checklist, per-item status.** Items silently dropped will be caught.
4. **Diagnose before fixing.** Read the actual code/markup first; after 2 failed attempts on the same
   bug, stop and reassess the approach — don't try a third variation blind.
5. **UI work cannot self-certify.** The owner's eyes are the verifier; say so and show screenshots.
   Proactively audit touched screens for cropping/alignment/contrast — the owner will not enumerate these.
6. **Data hygiene is sacred**: `newsletters/ assets/ data/ briefs/ *.db` and all credentials are never
   committed. Credentials live at `~/.config/bookself/`, outside the repo.
7. **No AI co-author trailers in commit messages.**
8. **Owner profile**: Product manager, strong SQL/product thinking, NOT a developer — explain in
   plain language, give exact commands to type, no unexplained jargon.

## Quick start (dev)

```bash
cd bookself && source .venv/bin/activate && python app.py   # UI at 127.0.0.1:5001
```

Flask has no auto-reload — restart after Python changes. Full setup for a new machine: README.md.

## Current focus (2026-07-19)

Roadmap in PRD §6. Next up: **web clipper** (PRD Decision #23, Open Question #1), then the Daily
Brief mail + scheduler layer (Open Question #2).
