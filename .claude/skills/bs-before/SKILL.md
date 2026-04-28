---
name: bs-before
description: Pre-change checklist for BookSelf. Run before any feature or fix to document current state and scope the change.
---

# BookSelf Pre-Change Checklist

**Run this before implementing any feature or fix. The purpose is to lock down scope and prevent collateral damage.**

## 1 — What is currently working that I must NOT break?

List the features that are working right now that touch the same code area.
Example: "Light mode toggle works for Finshots. Zoom works. Mark as done records read_at correctly."

If you don't know what's currently working, ask the user.

## 2 — What files will I touch?

List every file. This is a commitment. If you end up needing to touch a file not on this list, stop and explain why before proceeding.

Format:
- `app.py` — lines ~XXX: change Y
- `app/static/js/app.js` — function `foo()`: change Z
- `app/static/css/style.css` — `.some-class`: change W

## 3 — What files will I NOT touch?

Explicitly name files adjacent to the change area that you are leaving alone.
Example: "I will NOT touch `bookself/database.py`, `fetch.py`, or the reader pane CSS."

## 4 — Does this require a server restart?

- Yes (Python changed) → Tell user before AND after
- No (JS/CSS only) → Just Cmd+Shift+R

## 5 — What is the acceptance criteria?

One sentence per thing that must be true when done.
Example:
- "Clicking ↺ Load shows all installed models in a dropdown regardless of current value"
- "Selecting qwen3:8b and clicking Save writes qwen3:8b to ai_config.yaml"
- "Generate Summary uses the saved model"

Get user sign-off on this list before writing code.

---

## BookSelf architecture quick-ref

```
bookself/
├── app.py              Flask server — 49 API routes, ~1400 lines
├── app/static/js/app.js   Single-page UI — ~3200 lines, no framework
├── app/static/css/style.css  ~2600 lines, CSS variables in :root
├── bookself/
│   ├── database.py     SQLite schema + queries
│   ├── gmail_client.py Gmail OAuth
│   └── config_loader.py  Reads config.yaml
├── config.yaml         Newsletter sources (user edits this)
├── ai_config.yaml      AI provider settings (written by Settings UI)
└── bookself.db         SQLite (gitignored, local only)
```

**Port:** 5001 (not 5000 — macOS AirPlay owns 5000)  
**Auth:** None — localhost only  
**Credentials:** `~/.config/bookself/credentials.json` and `token.json` — NOT in project  
**Auto-reload:** NONE. Python changes need `Ctrl+C → python app.py`.  
**DB migrations:** `init_db()` in `database.py`, called from `app.py` startup and `catalog.py`  
**Notes files:** `newsletters/{folder}/{date}.notes.md` alongside HTML  
**AI summaries:** stored in `## AI Summary` section of notes files  

## CSS variable palette (do not hardcode hex values)

```css
--bg-dark     /* app background — darkest */
--bg-mid      /* left pane */
--bg-surface  /* cards, modals */
--bg-item     /* interactive items, inputs */
--text-main   /* #e0e0e0 — primary text on dark */
--text-dim    /* secondary text */
--accent      /* red/highlight */
--border      /* subtle dividers */
```

Layering: `--bg-dark` → `--bg-mid` → `--bg-surface` → `--bg-item` (darkest to lightest, each visibly distinct)
