---
name: bs-fix
description: Diagnostic-first bug fix protocol for BookSelf. READ before you code. Never assume root cause.
---

# BookSelf Bug Fix Protocol

**Invoke this skill before fixing any bug in this project. No code until every step is done.**

## Step 1 — Read the actual files

Before forming any hypothesis, read:
- The exact file and line where the error originates (not a guess — the actual traceback or error message)
- The function/component that calls it
- Any config or state it reads at runtime

**NEVER** start from "this is probably caused by X." Start from the files.

## Step 2 — State the root cause in one sentence

Write it out before writing code. Example:
> "The `_call_ollama` function raises `urllib.error.HTTPError` when Ollama returns 404 (model not found), but the caller only catches `URLError` — so the HTTPError propagates as an unhandled 500, and the JS swallows the body before showing 'Network error'."

If you cannot write this sentence without guessing, go back to Step 1.

## Step 3 — Check if the fix is Python-side or JS-side

- **Python-side**: Requires `Ctrl+C → python app.py` restart. Tell the user this BEFORE making the change.
- **JS/CSS-side**: Requires `Cmd+Shift+R` only. Much faster to verify.
- **Both**: Restart first, then reload.

## Step 4 — State exactly what you will change

List every file and every line range you intend to touch. Do NOT touch anything outside this list.

## Step 5 — Make the minimal change

Fix the specific root cause. Do not:
- Refactor adjacent code
- "Clean up" related functions
- Add features that weren't asked for
- Change error messages the user didn't complain about

## Step 6 — Tell the user what to do to verify

Give the exact steps: which button to click, what to look for, what the correct output should be.

---

## BookSelf-specific gotchas (from actual failures)

### urllib error handling
`urllib.request.urlopen` raises `HTTPError` (subclass of `URLError`) for non-200 responses.
Catching only `URLError` means HTTP 404/500 from Ollama gets caught with the wrong message.
**Always catch `HTTPError` first, then `URLError`:**
```python
except urllib.error.HTTPError as e:
    body = json.loads(e.read().decode('utf-8'))
    err_msg = body.get('error', str(e))
    return jsonify({'ok': False, 'error': err_msg}), 400
except urllib.error.URLError:
    return jsonify({'ok': False, 'error': 'Service not reachable'}), 503
```

### JS API error chain
`API.post()` and `API.get()` throw on non-2xx BEFORE reading the response body.
If you return `{'ok': False, 'error': 'useful message'}` from Python but the status is 400/500,
the JS catch block only has the status code — not the message.
**Fix:** `API.post()` must read JSON body before throwing (already fixed as of this session).

### Flask has NO auto-reload
`debug=False, use_reloader=False` — Python changes do NOTHING until manual restart.
DO NOT declare a Python fix "done" without telling the user to restart.
**Template for every Python fix:**
> "Python change — you need to `Ctrl+C` then `python app.py` before testing."

### `<input list="datalist">` filters by current value
Browser-native behaviour: datalist only shows options matching what's typed.
If the input has a value, the dropdown is pre-filtered. User cannot browse all options.
**Fix:** Use `<select>` when showing a bounded list of server-fetched options.

### init_db must run at app startup
Migrations added to `database.py` are only applied when `init_db()` is called.
`catalog.py` calls it, but `app.py` did not (until fixed this session).
**Rule:** Any new column or schema change → verify `init_db()` is called in `app.py` startup.

### Dark mode / Light mode iframe
Newsletters with no `background-color` on `<body>` use the OS "Canvas" system color.
On macOS dark mode, Canvas is dark — even if the newsletter has no dark mode CSS.
Fix: inject `html,body{background:#fff!important;color-scheme:light!important}` as `#_bs_light` stylesheet.
Do NOT rely on `<meta name="color-scheme">` alone — it doesn't override Canvas.
