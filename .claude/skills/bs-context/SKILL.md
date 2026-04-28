---
name: bs-context
description: Load full BookSelf project context — architecture, past failures, patterns, and active state. Run at the start of any session.
---

# BookSelf Session Context

## What this project is

Local-first newsletter reader. Pulls newsletters from Gmail via OAuth, stores as HTML files + SQLite, serves a two-pane reading UI via Flask.

**Stack:** Python 3.10+ / Flask / SQLite / Vanilla JS (no frameworks) / CSS variables  
**Port:** 5001 (`python app.py`)  
**Auto-reload:** NONE — `debug=False, use_reloader=False`

## Files to read at session start

Always read these before any work:
```
app.py                        # All Flask routes
app/static/js/app.js          # All UI logic — 3200+ lines
app/static/css/style.css      # All styles — CSS variables at top
bookself/database.py          # Schema + queries
config.yaml                   # Newsletter sources
ai_config.yaml                # AI provider settings (if exists)
```

Read the **specific function** being changed, not just the surrounding file.

## Current feature state (as of v0.2)

### Working
- Gmail sync via OAuth (`fetch.py`)
- Two-pane reading UI (left nav tree, right reader iframe)
- Light/dark mode toggle (iframe injection via `applyArticleDarkMode`)
- Mark as Done → records `read_at` timestamp in SQLite
- Stats page — reads from `read_at`, shows streaks/heatmap
- My Notes — persisted in `.notes.md` files alongside HTML
- AI Summary — Ollama local + OpenAI + Anthropic + Custom
- Library table — 5 columns with AI summary counts from filesystem scan
- Settings panel — 5fr/3fr grid, max-width 1800px for 1440p screens
- Functional test suite — 31 tests, `tests/test_api.py`

### Known limitations
- No scheduled sync (manual only via ↻ Sync button)
- AI model select for Ollama is a `<select>` populated by Load — requires clicking Load each session (not persisted across page reloads beyond the saved model name)
- Test connection reads saved config, not current form values

## Error handling patterns

### Python — always catch HTTPError before URLError
```python
except urllib.error.HTTPError as e:
    body = json.loads(e.read().decode('utf-8'))
    return jsonify({'ok': False, 'error': body.get('error', str(e))}), 400
except urllib.error.URLError:
    return jsonify({'ok': False, 'error': 'Service not reachable'}), 503
```

### Python — never use bare `except:` or `except Exception: pass`
Silent swallowing hides bugs. If you must suppress, log first:
```python
except Exception as e:
    print(f"[WARN] {e}")  # visible in Flask console
```

### JS — API.post() now reads JSON body before throwing
After the fix in this session: error messages from Flask propagate to the UI correctly.
The generate summary `catch(e)` shows `e.message` (the real error), not a hardcoded string.

### JS — never hardcode error strings in catch blocks
```javascript
// BAD — swallows the actual error
} catch (e) {
    _showError('Network error — check your connection.');
}
// GOOD — shows what actually went wrong
} catch (e) {
    _showError(e.message || 'Network error — check your connection.');
}
```

## Layout rules

- **Settings grid:** `minmax(0, 5fr) minmax(0, 3fr)`, `max-width: 1800px` — gives settings 62.5% on 1440p
- **Never set fixed px widths** on panel halves — use fr units so it adapts
- **CSS variables only** — no one-off hex values; use `--bg-surface`, `--text-main`, etc.

## DB rules

- Any new column → add migration in `database.py` `init_db()` function
- Verify `init_db(db_path)` is called in `app.py` startup block (line ~62)
- After adding a migration, always restart Flask AND check `PRAGMA table_info(newsletters)` to confirm the column exists in the live DB

## Credentials

- `~/.config/bookself/credentials.json` — Google OAuth app identity
- `~/.config/bookself/token.json` — access token (auto-refreshed)
- Neither file is in the project folder — `gmail_client.py` reads from `~/.config/bookself/`

## Failure history — what went wrong and why

| Bug | Root cause | Lesson |
|---|---|---|
| Light mode broken for Finshots/Eye on China | No `background` on `<body>` → OS Canvas color. Fixed with `#_bs_light` stylesheet injection | Read the actual HTML before diagnosing |
| Stats page 500 after `read_at` migration | `init_db()` not called from `app.py` startup | Migrations only run where `init_db()` is called |
| Settings panel squished | `max-width: 1400px` on a 1440p screen (CSS px ~2560) | Check screen dimensions before setting max-widths |
| Generate summary "Network error" | `HTTPError` caught as `URLError` → wrong message + 503 → JS throws before reading body | Catch `HTTPError` first; make JS read body before throwing |
| Model dropdown showed no options | `<input list="datalist">` filters by current value → "llama3" input hid all other models | Use `<select>` for bounded server-fetched lists |
| Test connection showed wrong model | Test endpoint reads saved config, form shows unsaved value | Don't conflate form state with saved state |

## Session workflow

1. User describes what they want
2. **Run `/bs-before`** — scope the change, list files
3. Read the specific files/functions involved
4. State root cause or design in plain language — get user confirmation
5. Implement the minimal change
6. **Run `/bs-verify`** — screenshot, test the user flow, check regressions
7. Tell user what to restart/reload and exactly how to test
