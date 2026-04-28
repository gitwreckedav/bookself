---
name: bs-verify
description: Post-change verification for BookSelf. Screenshot, test the exact user flow, confirm no regressions.
---

# BookSelf Post-Change Verification

**Run after every change — before declaring it done.**

## Step 1 — Restart / reload as needed

| What changed | What to do |
|---|---|
| Any `.py` file | `Ctrl+C` → `python app.py` → wait for "Running on http://127.0.0.1:5001" |
| Any `.js` or `.css` file | `Cmd+Shift+R` in browser |
| Both | Restart server first, then reload browser |

## Step 2 — Take a screenshot of the affected area

Use `mcp__Claude_Preview__preview_screenshot` to capture the current state.
Look for:
- [ ] Does the changed element render correctly?
- [ ] Is anything cropped or overflowing?
- [ ] Are adjacent elements unaffected?
- [ ] Does contrast look readable?

## Step 3 — Test the exact user flow end-to-end

Don't just verify the changed piece in isolation. Walk the full flow:

**For AI Summary changes:**
1. Open Settings → AI Summary
2. Click ↺ Load → models populate
3. Select a model from the dropdown
4. Click Save → "Saved to ai_config.yaml" appears
5. Open an article → click AI Summary tab → click Generate
6. Summary appears (or a specific, readable error — not "Network error")

**For read tracking changes:**
1. Open an article
2. Click Mark as Done → article marked read
3. Go to Stats — count increased by 1
4. Unmark → stats decremented

**For UI layout changes:**
1. Take screenshot at the page/panel that changed
2. Check: no content cropped, all buttons reachable, fonts readable
3. If there's a zoom/scale involved: test at 100% and 150%

**For dark/light mode changes:**
1. Toggle sun icon → newsletter background goes white, text readable
2. Toggle moon icon → dark CSS applies
3. Switch article → mode persists on new article

## Step 4 — Explicitly state what you checked

End every response with:
> "Verified: [specific thing tested]. Did not regress: [list of adjacent features checked]."

## Step 5 — Known regression traps in this codebase

Things that have been accidentally broken before — always check these when nearby:

| Area touched | Check these too |
|---|---|
| CSS layout (grid, flex) | Does settings panel still show at correct width? Does stats sidebar not crush the form? |
| AI config form | Does Load still populate correctly? Does Save write the right model? |
| iframe light mode | Does `#_bs_light` stylesheet inject on sun toggle? Does eye-on-china look white? |
| `database.py` | Did you run `init_db()`? Is the migration actually applied to the live `.db` file? |
| Stats endpoint | Is `read_at` populated? Does `date(read_at)` work in SQLite? |
| Notes panel | Does switching articles clear the panel? Does AI Summary tab not corrupt My Notes? |
