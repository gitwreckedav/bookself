# BookSelf — Session Audit

A permanent record of what went wrong, why, and what was learned.
Updated after each session with significant failures.

---

## Session 2 — UI Redesign (wood theme, zoom, read tracking)
**Result:** Furious. 5 hours. UI ended up worse than start.

### What went wrong

| Failure | Root cause |
|---|---|
| Wood theme muddy, low contrast | No palette specified upfront. Claude interpreted "wood-themed" freely |
| Zoom cropped settings panel | CSS transform without container overflow handling |
| Inconsistent font scaling | No rem scale defined; one-off values throughout |
| 48 edits, nothing working | Patching on top of broken state instead of reverting |
| Visual bugs survived 3 preview screenshots | Screenshots taken only at end, not after each component |

### Lessons learned
- Specify hex palette and font scale BEFORE implementing a theme
- Screenshot after every meaningful CSS change, not just at the end
- After 2 failed attempts at the same bug: stop, explain the approach, get approval
- Use git diff to see scope before each edit

---

## Session 3 — Bug Fixes, Features, Eval Setup
**Result:** Mixed. Most features fixed. AI generate summary broken by indirect cause.

### What went wrong

| Failure | Root cause | Lesson |
|---|---|---|
| Light mode took 2 hours | Diagnosed without reading the actual newsletter HTML. Assumed media queries. Actual cause: no body background + OS Canvas system color | **Read the file first. Always.** |
| Stats 500 error | Added `read_at` queries without checking if `init_db()` runs at Flask startup (it didn't) | Migrations only run where `init_db()` is called. Check `app.py` startup. |
| Settings still squished after CSS fix | Set `max-width: 1400px`; user's 1440p screen has ~2560 CSS px. Had to escalate to `1800px` | Check actual viewport before setting layout constraints |
| "Network error" on generate | `HTTPError` (model not found) caught as `URLError` (not running). JS `API.post()` threw before reading JSON body. Error was swallowed twice. | Catch `HTTPError` first. Make JS read error body before throwing. |
| Model dropdown showed no models | `<input list="datalist">` filters by current input value. Input had "llama3" → all other models hidden | Use `<select>` for bounded server-fetched model lists |
| Test connection showed wrong model | Test endpoint reads saved config. Form showed unsaved value. Confused user. | Don't mix saved state and form state in the same status line |

### Patterns across sessions

1. **Code before reading** — Every significant failure started with an assumption instead of reading the file
2. **Error swallowing** — `except Exception: pass` and JS `catch(e) { hardcodedMsg }` hide the real problem
3. **Scope creep** — Changes to unrelated areas (test connection when fixing load models) cause confusion
4. **No restart reminder** — Python changes declared "done" without telling user to restart Flask
5. **Layout without context** — Setting `max-width`, fixed widths, zoom without knowing the actual screen size

---

## Rules derived from failures

### Before any change
- Read the actual file, function, and line — not a guess
- List every file you will touch (and explicitly name files you won't)
- If Python-side: warn user about restart before AND after

### During implementation
- One problem at a time. Don't touch adjacent code.
- No `except Exception: pass` without a `print(f"[WARN] {e}")` minimum
- Catch `HTTPError` before `URLError` for all `urllib.urlopen` calls
- Use `<select>` for bounded lists; `<input>` only for free text

### After implementation
- Screenshot the affected area
- Walk the full user flow, not just the changed piece
- State explicitly: "verified X. Did not regress: Y."

---

## Skills in this project

| Skill | When to use |
|---|---|
| `/bs-fix` | Before fixing any bug |
| `/bs-before` | Before any feature implementation |
| `/bs-verify` | After every change, before declaring done |
| `/bs-context` | At the start of any new session |
