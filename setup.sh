#!/bin/bash
# ─────────────────────────────────────────────────────────────────
# bookself/setup.sh
# One-command setup script for Mac and Linux.
#
# What this does:
#   1. Checks that Python 3.10+ is available
#   2. Creates a virtual environment (.venv) inside this folder
#   3. Installs all dependencies from requirements.txt
#   4. Tells you what to do next
#
# Usage:
#   bash setup.sh
# ─────────────────────────────────────────────────────────────────

set -e  # Stop immediately if any command fails

echo ""
echo "╔══════════════════════════════════════╗"
echo "║       BookSelf — Setup Script        ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ── Check Python ─────────────────────────────────────────────────
# Find python3 command (some systems only have 'python')
PYTHON_CMD=""
if command -v python3 &> /dev/null; then
    PYTHON_CMD="python3"
elif command -v python &> /dev/null; then
    PYTHON_CMD="python"
else
    echo "❌  Python not found."
    echo "    Please install Python 3.10 or newer from https://www.python.org"
    exit 1
fi

# Check the Python version (need 3.10+)
PYTHON_VERSION=$($PYTHON_CMD -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
PYTHON_MAJOR=$($PYTHON_CMD -c "import sys; print(sys.version_info.major)")
PYTHON_MINOR=$($PYTHON_CMD -c "import sys; print(sys.version_info.minor)")

if [ "$PYTHON_MAJOR" -lt 3 ] || ([ "$PYTHON_MAJOR" -eq 3 ] && [ "$PYTHON_MINOR" -lt 10 ]); then
    echo "❌  Python $PYTHON_VERSION found, but BookSelf needs 3.10 or newer."
    echo "    Please upgrade Python from https://www.python.org"
    exit 1
fi

echo "✅  Python $PYTHON_VERSION found"

# ── Create virtual environment ────────────────────────────────────
# The .venv folder stays inside this project folder and is gitignored.
# It isolates BookSelf's dependencies from your system Python.
if [ ! -d ".venv" ]; then
    echo "📦  Creating virtual environment (.venv)..."
    $PYTHON_CMD -m venv .venv
    echo "✅  Virtual environment created"
else
    echo "✅  Virtual environment already exists — skipping creation"
fi

# ── Install dependencies ──────────────────────────────────────────
echo "📥  Installing dependencies (this may take a minute)..."
.venv/bin/pip install --upgrade pip --quiet

# Try to install with lxml. If lxml fails (Python version too new for pre-built wheels),
# install everything else and note the fallback.
if .venv/bin/pip install -r requirements.txt --quiet; then
    echo "✅  All dependencies installed"
else
    echo "⚠️   lxml may have failed (common on newer Python versions)."
    echo "    Trying without lxml — BookSelf will use the built-in HTML parser instead..."
    .venv/bin/pip install -r requirements.txt --quiet --no-deps
    .venv/bin/pip install google-auth google-auth-oauthlib google-auth-httplib2 \
        google-api-python-client flask pyyaml beautifulsoup4 requests --quiet
    echo "✅  Dependencies installed (without lxml — html.parser will be used)"
fi

# ── Check for credentials.json (stored outside project for security) ──────────
CREDS_DIR="$HOME/.config/bookself"
mkdir -p "$CREDS_DIR"
echo ""
if [ -f "$CREDS_DIR/credentials.json" ]; then
    echo "✅  credentials.json found at ~/.config/bookself/ — you're ready to sync!"
elif [ -f "credentials.json" ]; then
    echo "⚠️   Found credentials.json in the project folder (old location)."
    echo "    Moving it to ~/.config/bookself/ for security..."
    mv credentials.json "$CREDS_DIR/credentials.json"
    [ -f "token.json" ] && mv token.json "$CREDS_DIR/token.json"
    echo "✅  Moved! Future syncs will use ~/.config/bookself/"
else
    echo "⚠️   credentials.json not found."
    echo "    Place it at: ~/.config/bookself/credentials.json"
    echo "    (Download from Google Cloud Console → APIs & Services → Credentials)"
fi

# ── Done ──────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════╗"
echo "║            Setup complete!           ║"
echo "╚══════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo ""
echo "  1. Activate the environment:"
echo "     source .venv/bin/activate"
echo ""
echo "  2. Pull your newsletters from Gmail:"
echo "     python fetch.py"
echo "     (A browser window will open for Google login on first run)"
echo ""
echo "  3. Open the reading app:"
echo "     python app.py"
echo ""
