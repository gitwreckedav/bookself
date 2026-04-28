#!/bin/bash
# ─────────────────────────────────────────────────────────────────
# BookSelf pre-flight smoke test
#
# Run this any time before launching app.py to catch common issues.
# Usage: bash scripts/preflight.sh
# ─────────────────────────────────────────────────────────────────
set -e

cd "$(dirname "$0")/.."   # run from project root

PASS=0
FAIL=0

ok()   { echo "  ✅  $1"; ((PASS++)); }
fail() { echo "  ❌  $1"; ((FAIL++)); }
warn() { echo "  ⚠️   $1"; }

echo ""
echo "╔══════════════════════════════════════╗"
echo "║     BookSelf — Pre-flight Check      ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ── Python environment ────────────────────────────────────────────
echo "▸ Environment"
if [ -f ".venv/bin/python" ]; then
    ok ".venv exists"
else
    fail ".venv missing — run: bash setup.sh"
fi

if .venv/bin/python -c "import flask, yaml, google.auth" 2>/dev/null; then
    ok "Core dependencies importable (flask, yaml, google.auth)"
else
    fail "Missing dependencies — run: .venv/bin/pip install -r requirements.txt"
fi

# ── Config files ──────────────────────────────────────────────────
echo ""
echo "▸ Config files"
if [ -f "config.yaml" ]; then
    ok "config.yaml found"
else
    fail "config.yaml missing"
fi

if [ -f "ai_config.yaml" ]; then
    ok "ai_config.yaml found"
else
    warn "ai_config.yaml missing — will use defaults (not an error)"
fi

if [ -f "$HOME/.config/bookself/credentials.json" ]; then
    ok "credentials.json found at ~/.config/bookself/"
else
    warn "credentials.json missing at ~/.config/bookself/ — Gmail sync will not work"
fi

# ── Database ──────────────────────────────────────────────────────
echo ""
echo "▸ Database"
DB_PATH=$(.venv/bin/python -c "
import yaml, sys
cfg = yaml.safe_load(open('config.yaml'))
storage = cfg.get('storage', {})
print(storage.get('db', 'bookself.db'))
" 2>/dev/null)

if [ -z "$DB_PATH" ]; then
    DB_PATH="bookself.db"
fi

if [ -f "$DB_PATH" ]; then
    ok "Database found: $DB_PATH"
    # Check read_at column exists
    COL=$(.venv/bin/python -c "
import sqlite3
con = sqlite3.connect('$DB_PATH')
cols = [r[1] for r in con.execute('PRAGMA table_info(newsletters)').fetchall()]
print('yes' if 'read_at' in cols else 'no')
con.close()
" 2>/dev/null)
    if [ "$COL" = "yes" ]; then
        ok "read_at column present"
    else
        fail "read_at column MISSING — restart app.py to run migrations"
    fi
else
    warn "No database yet — will be created on first sync"
fi

# ── Newsletters directory ─────────────────────────────────────────
echo ""
echo "▸ Newsletter files"
NL_DIR=$(.venv/bin/python -c "
import yaml
cfg = yaml.safe_load(open('config.yaml'))
storage = cfg.get('storage', {})
print(storage.get('newsletters', 'newsletters'))
" 2>/dev/null)

if [ -d "$NL_DIR" ]; then
    COUNT=$(find "$NL_DIR" -name '*.html' 2>/dev/null | wc -l | tr -d ' ')
    ok "newsletters/ directory exists ($COUNT HTML files)"
else
    warn "newsletters/ not found — empty library until first sync"
fi

# ── Port availability ─────────────────────────────────────────────
echo ""
echo "▸ Port"
if lsof -ti:5001 > /dev/null 2>&1; then
    warn "Port 5001 already in use — another BookSelf instance may be running"
else
    ok "Port 5001 free"
fi

# ── Functional tests ──────────────────────────────────────────────
echo ""
echo "▸ Functional tests"
if [ -d "tests" ]; then
    if .venv/bin/python -m pytest tests/ -q --tb=short 2>&1; then
        ok "All tests passed"
    else
        fail "Test failures — see output above"
    fi
else
    warn "No tests/ directory found"
fi

# ── Summary ───────────────────────────────────────────────────────
echo ""
echo "────────────────────────────────────────"
echo "  Passed: $PASS  |  Failed: $FAIL"
echo "────────────────────────────────────────"
echo ""
if [ "$FAIL" -eq 0 ]; then
    echo "✅  All checks passed. Safe to start:"
    echo "    source .venv/bin/activate && python app.py"
else
    echo "❌  $FAIL check(s) failed. Fix the issues above before starting."
fi
echo ""
