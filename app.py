#!/usr/bin/env python3
# ─────────────────────────────────────────────────────────────────
# bookself/app.py
#
# The Flask web server that powers the BookSelf reading UI.
# Run this to open your newsletter library in the browser.
#
# Usage:
#   python app.py
#   → Opens http://127.0.0.1:5001 automatically
#
# What it does:
#   - Serves the single-page reading UI
#   - Provides API endpoints for the JavaScript frontend
#   - Streams fetch.py output in real-time when "Sync Now" is clicked
#   - Opens newsletter folders in Finder/Explorer on request
#
# This server only runs locally (localhost). It is NOT accessible
# from the internet or other devices on your network.
# ─────────────────────────────────────────────────────────────────

import sys
import os
import json
import platform
import subprocess
import threading
import webbrowser
from datetime import datetime
from pathlib import Path

from flask import Flask, jsonify, request, Response, send_from_directory

# ── Path setup ────────────────────────────────────────────────────
# Everything is computed relative to THIS file's location.
# This ensures the app works correctly no matter where you run it from.
PROJECT_ROOT = Path(__file__).parent
sys.path.insert(0, str(PROJECT_ROOT))

import yaml
from bookself.config_loader import (
    load_config, get_db_path, get_newsletters_dir, get_assets_dir, get_project_root
)
from bookself.database import (
    get_all_publications, get_series_for_publication, get_newsletters,
    get_newsletter_by_id, search_newsletters, get_recent_for_publication,
    get_recent_for_series, get_total_count, get_last_fetched_at, get_source_count,
    toggle_read, init_db
)

# ── Load config once at startup ───────────────────────────────────
try:
    config = load_config()
    db_path = get_db_path(config)
    newsletters_dir = get_newsletters_dir(config)
    assets_dir = get_assets_dir(config)
except Exception as e:
    print(f"\n❌  Could not load config: {e}")
    sys.exit(1)

# ── Run DB migrations every startup (idempotent — safe to re-run) ─
if db_path.exists():
    init_db(db_path)

# ── User data persistence path ────────────────────────────────────
USER_DATA_PATH = PROJECT_ROOT / 'data' / 'state' / 'user_data.json'

# ── AI config (separate from newsletter config) ───────────────────
AI_CONFIG_PATH = PROJECT_ROOT / 'ai_config.yaml'

_DEFAULT_SUMMARY_PROMPT = (
    "You are a newsletter summarizer. Extract the substance so the reader gets 75% of the value in 25% of the time.\n\n"
    "Rules:\n"
    "- Mirror the article's tone and register (analytical, investigative, casual — match it)\n"
    "- Target 150–250 words regardless of article length\n"
    "- Lead with the single most important fact, number, or development — not a generic sentence\n"
    "- Include every key number, date, name, and causal chain — these are non-negotiable\n"
    "- Preserve chronology where events are sequential\n"
    "- Cut entirely: anecdotes, analogies, personal asides, rhetorical questions, repetition\n"
    "- Do NOT write meta-commentary like \"This article discusses...\" or \"The author argues...\" — just the substance\n"
    "- Output ONLY the summary. No preamble, no sign-off, no thinking."
)

_AI_CONFIG_DEFAULTS = {
    'provider':       'ollama',
    'model':          '',          # blank → user must pick from their installed models
    'base_url':       'http://localhost:11434',
    'api_key':        '',
    'max_words':      6000,
    'summary_prompt': _DEFAULT_SUMMARY_PROMPT,
}

def load_ai_config() -> dict:
    """Load ai_config.yaml, returning defaults for any missing keys."""
    try:
        if AI_CONFIG_PATH.exists():
            raw = yaml.safe_load(AI_CONFIG_PATH.read_text(encoding='utf-8')) or {}
            return {**_AI_CONFIG_DEFAULTS, **raw}
    except Exception:
        pass
    return dict(_AI_CONFIG_DEFAULTS)


def _update_user_data(msg_id: str, **kwargs):
    """
    Merge kwargs into the user_data.json entry for this gmail_message_id.
    Creates the file if it doesn't exist. Thread-safe enough for single-user local app.
    """
    try:
        path = USER_DATA_PATH
        path.parent.mkdir(parents=True, exist_ok=True)
        data = json.loads(path.read_text(encoding='utf-8')) if path.exists() else {}
        entry = data.setdefault(msg_id, {})
        entry.update(kwargs)
        path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding='utf-8')
    except Exception:
        pass  # Non-fatal — persistence is best-effort

# ── Create Flask app ──────────────────────────────────────────────
# We tell Flask explicitly where to find templates and static files,
# so it works correctly regardless of working directory.
app = Flask(
    __name__,
    template_folder=str(PROJECT_ROOT / 'app' / 'templates'),
    static_folder=str(PROJECT_ROOT / 'app' / 'static'),
    static_url_path='/static'
)


# ══════════════════════════════════════════════════════════════════
# PAGE ROUTE — serves the main UI
# ══════════════════════════════════════════════════════════════════

@app.route('/')
def index():
    """Serve the main single-page app shell."""
    template_path = PROJECT_ROOT / 'app' / 'templates' / 'index.html'
    return template_path.read_text(encoding='utf-8')


# ══════════════════════════════════════════════════════════════════
# STATIC ASSET ROUTES
# ══════════════════════════════════════════════════════════════════

@app.route('/newsletter-assets/<path:filename>')
def serve_newsletter_asset(filename):
    """
    Serve locally saved newsletter images (photos, charts, logos).

    These are images extracted from newsletter emails during fetch.
    The fetch script rewrites img src attributes to point here,
    so newsletters display with their original images even offline.
    """
    return send_from_directory(str(assets_dir), filename)


# ══════════════════════════════════════════════════════════════════
# API — APP STATUS
# ══════════════════════════════════════════════════════════════════

@app.route('/api/status')
def get_status():
    """
    Return app status information shown in the left pane footer.

    Returns:
        total_newsletters: total count of newsletters in the library
        last_synced: formatted timestamp of last fetch (yyyy-mm-dd hh:mm)
        platform: OS name — used by JS to label context menu correctly
    """
    total = get_total_count(db_path) if db_path.exists() else 0
    last_synced_raw = get_last_fetched_at(db_path) if db_path.exists() else None

    last_synced_display = None
    if last_synced_raw:
        try:
            dt = datetime.fromisoformat(last_synced_raw)
            last_synced_display = dt.strftime('%Y-%m-%d %H:%M')
        except Exception:
            last_synced_display = last_synced_raw[:16]

    return jsonify({
        'total_newsletters': total,
        'last_synced': last_synced_display,
        'platform': platform.system()   # 'Darwin' (Mac), 'Windows', or 'Linux'
    })


# ══════════════════════════════════════════════════════════════════
# API — NAVIGATION TREE DATA
# ══════════════════════════════════════════════════════════════════

@app.route('/api/publications')
def api_publications():
    """
    Return a list of all publication names in the library.
    Used to build the top level of the left pane navigation tree.
    """
    if not db_path.exists():
        return jsonify([])
    pubs = get_all_publications(db_path)
    return jsonify(pubs)


@app.route('/api/publications/<path:publication>/series')
def api_series(publication):
    """
    Return a list of series names for one publication.
    Used to expand a publication node in the nav tree.
    """
    if not db_path.exists():
        return jsonify([])
    series = get_series_for_publication(db_path, publication)
    return jsonify(series)


# ══════════════════════════════════════════════════════════════════
# API — NEWSLETTER LISTING
# ══════════════════════════════════════════════════════════════════

@app.route('/api/newsletters')
def api_newsletters():
    """
    Return a filtered, sorted list of newsletters.

    Query parameters (all optional):
        pub    — filter by publication name
        series — filter by series name (use with pub)
        limit  — max results (default 50)
        offset — for pagination (default 0)
        sort   — 'date_desc' (default), 'date_asc', or 'title_asc'
    """
    if not db_path.exists():
        return jsonify([])

    publication = request.args.get('pub')
    series = request.args.get('series')
    limit = int(request.args.get('limit', 50))
    offset = int(request.args.get('offset', 0))
    sort = request.args.get('sort', 'date_desc')

    results = get_newsletters(
        db_path,
        publication=publication,
        series=series,
        limit=limit,
        offset=offset,
        sort=sort
    )
    return jsonify(results)


@app.route('/api/newsletters/<int:newsletter_id>')
def api_newsletter_by_id(newsletter_id):
    """Return metadata for a single newsletter."""
    if not db_path.exists():
        return jsonify({'error': 'No database'}), 404

    record = get_newsletter_by_id(db_path, newsletter_id)
    if not record:
        return jsonify({'error': 'Not found'}), 404
    return jsonify(record)


@app.route('/api/newsletters/<int:newsletter_id>/toggle-read', methods=['POST'])
def api_toggle_read(newsletter_id):
    """
    Flip the is_read flag for a newsletter (unread→read or read→unread).

    Called automatically when a newsletter is opened (auto-mark as read),
    and when the user manually clicks the read-dot in the nav list.

    Returns:
        JSON: {"is_read": 0 or 1}
    """
    if not db_path.exists():
        return jsonify({'error': 'Database not found'}), 404

    new_state = toggle_read(db_path, newsletter_id)

    # Keep user_data.json in sync so read flags survive full-purge
    record = get_newsletter_by_id(db_path, newsletter_id)
    if record:
        _update_user_data(record['gmail_message_id'],
                          is_read=new_state,
                          file_path=record['file_path'])

    return jsonify({'is_read': new_state})


@app.route('/api/newsletters/<int:newsletter_id>/content')
def api_newsletter_content(newsletter_id):
    """
    Serve the full HTML of a newsletter for display in the reading iframe.

    The HTML is read from disk and served with the correct MIME type.
    Because the HTML was cleaned during fetch (scripts stripped, base target
    added, images rewritten to local paths), it renders safely and correctly.
    """
    if not db_path.exists():
        return "Database not found", 404

    record = get_newsletter_by_id(db_path, newsletter_id)
    if not record:
        return "Newsletter not found", 404

    file_path = PROJECT_ROOT / record['file_path']
    if not file_path.exists():
        return (
            f"<html><body style='font-family:sans-serif;padding:2em;color:#666'>"
            f"<h3>File not found on disk</h3>"
            f"<p>Expected at: {record['file_path']}</p>"
            f"<p>Try running fetch.py again to re-download this newsletter.</p>"
            f"</body></html>"
        ), 404

    content = file_path.read_text(encoding='utf-8', errors='replace')
    # Force newsletters to display in light mode regardless of OS dark-mode preference.
    # Substack and other senders include @media (prefers-color-scheme: dark) CSS that
    # would auto-darken the article when macOS/browser is in dark mode.
    # The color-scheme meta tag suppresses this without touching any colours.
    # Our JS dark-mode toggle (applyArticleDarkMode) handles darkness explicitly on demand.
    cs_meta = '<meta name="color-scheme" content="light only">'
    if '<head>' in content:
        content = content.replace('<head>', f'<head>{cs_meta}', 1)
    elif '<html' in content:
        # No <head> — prepend before <html>
        idx = content.index('<html')
        content = content[:idx] + cs_meta + content[idx:]
    else:
        content = cs_meta + content
    return Response(content, mimetype='text/html')


# ══════════════════════════════════════════════════════════════════
# API — OVERVIEW CARDS
# ══════════════════════════════════════════════════════════════════

@app.route('/api/overview/publication/<path:publication>')
def api_overview_publication(publication):
    """Return the 8 most recent newsletters from a publication (for overview cards)."""
    if not db_path.exists():
        return jsonify([])
    results = get_recent_for_publication(db_path, publication, limit=8)
    return jsonify(results)


@app.route('/api/overview/series/<path:pub_and_series>')
def api_overview_series(pub_and_series):
    """
    Return the 8 most recent newsletters from a specific series.

    URL format: /api/overview/series/<publication>/<series>
    We use a single path parameter and split on the first slash.
    """
    # Split "The Ken/Ka-Ching!" into ("The Ken", "Ka-Ching!")
    parts = pub_and_series.split('/', 1)
    if len(parts) != 2:
        return jsonify({'error': 'Invalid path'}), 400

    publication, series = parts
    if not db_path.exists():
        return jsonify([])
    results = get_recent_for_series(db_path, publication, series, limit=8)
    return jsonify(results)


# ══════════════════════════════════════════════════════════════════
# API — SEARCH
# ══════════════════════════════════════════════════════════════════

@app.route('/api/search')
def api_search():
    """
    Full-text search across all newsletter titles and body text.

    Query parameter:
        q — the search query (multiple words = AND logic, all must match)
    """
    query = request.args.get('q', '').strip()
    if not query or not db_path.exists():
        return jsonify([])

    results = search_newsletters(db_path, query)
    return jsonify(results)


# ══════════════════════════════════════════════════════════════════
# API — CONFIG (read and write config.yaml from the UI)
# ══════════════════════════════════════════════════════════════════

@app.route('/api/config', methods=['GET'])
def api_config_get():
    """
    Return the raw contents of config.yaml as a string.
    Used to populate the in-app YAML editor in the Settings panel.
    """
    config_path = get_project_root() / 'config.yaml'
    try:
        content = config_path.read_text(encoding='utf-8')
        return jsonify({'content': content})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/config', methods=['POST'])
def api_config_post():
    """
    Save updated config.yaml content submitted from the in-app YAML editor.

    Validates the YAML before writing:
    - Must be parseable YAML (not corrupt)
    - Must pass load_config() field validation (required fields present)

    If validation fails, the file is NOT touched and the error is returned.
    If it passes, the file is written and a success response is returned.

    Note: Changes take effect on the next fetch.py run. The running Flask
    server does not reload config automatically (restart app.py for that).
    """
    data = request.get_json() or {}
    new_content = data.get('content', '').strip()

    if not new_content:
        return jsonify({'error': 'No content provided'}), 400

    # ── Step 1: Parse YAML (catches syntax errors) ────────────────
    try:
        parsed = yaml.safe_load(new_content)
    except yaml.YAMLError as e:
        return jsonify({'error': f'YAML syntax error: {e}'}), 400

    # ── Step 2: Validate required fields ─────────────────────────
    # Write to a temp location in memory, then run load_config validation
    try:
        import io, tempfile
        with tempfile.NamedTemporaryFile(
            mode='w', suffix='.yaml', delete=False, encoding='utf-8'
        ) as tmp:
            tmp.write(new_content)
            tmp_path = Path(tmp.name)

        load_config(config_path=tmp_path)   # raises ValueError on invalid structure
        tmp_path.unlink(missing_ok=True)
    except ValueError as e:
        tmp_path.unlink(missing_ok=True)
        return jsonify({'error': f'Config validation error: {e}'}), 400
    except Exception as e:
        return jsonify({'error': f'Unexpected error during validation: {e}'}), 500

    # ── Step 3: Write the validated config to disk ────────────────
    config_path = get_project_root() / 'config.yaml'
    try:
        config_path.write_text(new_content, encoding='utf-8')
    except Exception as e:
        return jsonify({'error': f'Could not write file: {e}'}), 500

    return jsonify({
        'ok': True,
        'message': 'config.yaml saved. Changes take effect on the next sync.'
    })


# ══════════════════════════════════════════════════════════════════
# API — SYNC STATE (read the persistent sync state file)
# ══════════════════════════════════════════════════════════════════

@app.route('/api/sync/state')
def api_sync_state():
    """
    Return the contents of data/state/sync_state.json.
    Used by the Settings panel to show when the last seed/incremental
    sync ran and what it found.
    """
    state_path = PROJECT_ROOT / 'data' / 'state' / 'sync_state.json'
    if not state_path.exists():
        return jsonify({'exists': False, 'state': None})

    try:
        state = json.loads(state_path.read_text(encoding='utf-8'))
        return jsonify({'exists': True, 'state': state})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ══════════════════════════════════════════════════════════════════
# API — SYNC (streams fetch.py + catalog.py output via SSE)
# ══════════════════════════════════════════════════════════════════

@app.route('/api/sync', methods=['POST'])
def api_sync():
    """
    Run the two-stage sync pipeline and stream output back to the browser.

    Stage 1 — Acquisition (fetch.py):
        Downloads emails from Gmail into data/raw/ as JSON files.
        Enforces the invariant: every Gmail ID must produce a file.

    Stage 2 — Cataloging (catalog.py):
        Reads raw files, parses HTML, organises into newsletters/ folder,
        inserts metadata into the SQLite database for the UI to query.

    The browser listens using Server-Sent Events (SSE). Both scripts'
    stdout is streamed line-by-line in real time.

    Request body (JSON):
        mode        — 'seed' | 'incremental' (required)
        start_date  — 'YYYY-MM-DD' (optional, seed mode only)
    """
    fetch_script   = PROJECT_ROOT / 'fetch.py'
    catalog_script = PROJECT_ROOT / 'catalog.py'

    if not fetch_script.exists():
        return jsonify({'error': 'fetch.py not found'}), 404
    if not catalog_script.exists():
        return jsonify({'error': 'catalog.py not found'}), 404

    body            = request.get_json(silent=True) or {}
    mode            = body.get('mode', 'incremental')
    start_date      = body.get('start_date')       # optional, seed mode only
    sender_filter   = body.get('sender', '').strip()  # optional, per-sender seed
    wipe_user_data  = bool(body.get('wipe_user_data', False))

    # Validate mode
    if mode not in ('seed', 'incremental'):
        return jsonify({'error': f"Invalid mode '{mode}'. Must be 'seed' or 'incremental'."}), 400

    def run_script(cmd):
        """Run a script and yield each output line as an SSE data event."""
        process = subprocess.Popen(
            cmd,
            cwd=str(PROJECT_ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            encoding='utf-8',
            errors='replace'
        )
        for line in process.stdout:
            clean = line.rstrip()
            if clean:
                yield clean
        process.wait()
        return process.returncode

    def stream_output():
        """Generator that runs fetch.py then catalog.py, streaming both outputs."""
        try:
            # ── Stage 1: Acquisition ──────────────────────────────
            yield "data: ═══════════════════════════════════════\n\n"
            yield f"data: 📥 Stage 1: Acquisition ({mode} mode)\n\n"
            yield "data: ═══════════════════════════════════════\n\n"

            cmd = [sys.executable, '-u', str(fetch_script), '--mode', mode]
            if mode == 'seed' and start_date:
                # Validate date format
                try:
                    datetime.strptime(str(start_date), '%Y-%m-%d')
                    cmd += ['--start-date', str(start_date)]
                except ValueError:
                    pass  # Use fetch.py's default (from config.yaml)
            if sender_filter:
                cmd += ['--sender', sender_filter]

            acquisition_failed = False
            process1 = subprocess.Popen(
                cmd,
                cwd=str(PROJECT_ROOT),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True, bufsize=1, encoding='utf-8', errors='replace'
            )
            for line in process1.stdout:
                clean = line.rstrip()
                if clean:
                    yield f"data: {clean}\n\n"
            process1.wait()

            if process1.returncode != 0:
                yield "data: \n\n"
                yield "data: ❌ Acquisition failed (invariant check did not pass).\n\n"
                yield "data: [SYNC_ERROR] Acquisition stage failed.\n\n"
                return

            # Signal JS to refresh the nav tree NOW so new newsletters
            # appear immediately — catalog.py hasn't run yet but the DB
            # already has the new records inserted by fetch.py.
            yield "data: [STAGE_1_COMPLETE]\n\n"

            # ── Stage 2: Cataloging ───────────────────────────────
            yield "data: \n\n"
            yield "data: ═══════════════════════════════════════\n\n"
            yield "data: 📚 Stage 2: Cataloging\n\n"
            yield "data: ═══════════════════════════════════════\n\n"

            # Build catalog.py command — pass --start-date in seed mode
            # so it purges pre-start-date entries and date-filters the raw files.
            seed_start_date = config.get('settings', {}).get('seed_start_date', '2024-01-01')
            catalog_cmd = [sys.executable, '-u', str(catalog_script)]
            if mode == 'seed' and not sender_filter:
                # Date-based cleanup only for full seed, not per-sender
                catalog_cmd += ['--start-date', seed_start_date]
            if sender_filter:
                catalog_cmd += ['--sender', sender_filter]
            if wipe_user_data:
                catalog_cmd += ['--wipe-user-data']

            process2 = subprocess.Popen(
                catalog_cmd,
                cwd=str(PROJECT_ROOT),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True, bufsize=1, encoding='utf-8', errors='replace'
            )
            for line in process2.stdout:
                clean = line.rstrip()
                if clean:
                    yield f"data: {clean}\n\n"
            process2.wait()

            if process2.returncode == 0:
                yield "data: \n\n"
                yield "data: [SYNC_COMPLETE]\n\n"
            else:
                yield "data: [SYNC_ERROR] Cataloging stage failed.\n\n"

        except Exception as e:
            yield f"data: [SYNC_ERROR] {str(e)}\n\n"

    return Response(
        stream_output(),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
            'Connection': 'keep-alive'
        }
    )


# ══════════════════════════════════════════════════════════════════
# API — LIBRARY SUMMARY (per-source newsletter counts)
# ══════════════════════════════════════════════════════════════════

@app.route('/api/library/summary')
def api_library_summary():
    """
    Return per-source newsletter counts for the library summary table in Settings.

    Returns a list of:
        { name, sender, count, read_count, ai_summary_count }
    """
    import sqlite3 as _sql
    sources = config.get('sources', [])
    result = []

    # Build read counts in one query for efficiency
    read_by_pub = {}
    if db_path.exists():
        con = _sql.connect(db_path)
        rows = con.execute(
            'SELECT publication, COUNT(*) as n FROM newsletters WHERE is_read=1 GROUP BY publication'
        ).fetchall()
        con.close()
        read_by_pub = {r[0]: r[1] for r in rows}

    for source in sources:
        pub_name = source['name']
        folder   = source.get('folder', '')
        count    = get_source_count(db_path, pub_name) if db_path.exists() else 0
        read_count = read_by_pub.get(pub_name, 0)

        # Count .notes.md files that have a non-empty ## AI Summary section
        ai_count = 0
        if folder:
            pub_dir = newsletters_dir / folder
            if pub_dir.exists():
                for notes_file in pub_dir.rglob('*.notes.md'):
                    try:
                        content = notes_file.read_text(encoding='utf-8', errors='ignore')
                        if '## AI Summary' in content:
                            after = content.split('## AI Summary', 1)[1].lstrip('\n').strip()
                            if after:
                                ai_count += 1
                    except Exception:
                        pass

        result.append({
            'name':             pub_name,
            'sender':           source.get('sender', ''),
            'count':            count,
            'read_count':       read_count,
            'ai_summary_count': ai_count,
        })
    return jsonify(result)


# ══════════════════════════════════════════════════════════════════
# API — NEWSLETTER NOTES (.notes.md companion files)
#
# File format (two-section markdown):
#
#   ## My Notes
#
#   <user's custom text>
#
#   ---
#
#   ## AI Summary
#
#   <AI-generated summary — empty until user generates one>
#
# ══════════════════════════════════════════════════════════════════

import re as _re

def _parse_notes(content):
    """Split a .notes.md file into (my_notes, ai_summary) strings."""
    parts = _re.split(r'\n---\n', content, maxsplit=1)
    def _extract(chunk, heading):
        m = _re.search(rf'{heading}\s*\n(.*)', chunk, _re.DOTALL)
        return m.group(1).strip() if m else chunk.strip()
    my_notes   = _extract(parts[0], '## My Notes')
    ai_summary = _extract(parts[1], '## AI Summary') if len(parts) > 1 else ''
    return my_notes, ai_summary


def _build_notes(my_notes, ai_summary):
    """Serialise two sections back to the .notes.md format."""
    return (
        f"## My Notes\n\n{my_notes}\n\n"
        f"---\n\n"
        f"## AI Summary\n\n{ai_summary or ''}"
    )


@app.route('/api/newsletters/<int:newsletter_id>/note', methods=['GET'])
def api_get_note(newsletter_id):
    """
    Return the parsed notes for a newsletter.
    Response: {"my_notes": "...", "ai_summary": "...", "has_note": bool}
    """
    if not db_path.exists():
        return jsonify({'error': 'Database not found'}), 404
    record = get_newsletter_by_id(db_path, newsletter_id)
    if not record:
        return jsonify({'error': 'Not found'}), 404

    notes_path     = (PROJECT_ROOT / record['file_path']).with_suffix('.notes.md')
    content        = notes_path.read_text(encoding='utf-8') if notes_path.exists() else ''
    my_notes, ai_summary = _parse_notes(content)
    return jsonify({
        'my_notes':   my_notes,
        'ai_summary': ai_summary,
        'has_note':   bool(my_notes.strip() or ai_summary.strip()),
        'notes_path': str(notes_path.relative_to(PROJECT_ROOT))
    })


@app.route('/api/newsletters/<int:newsletter_id>/note', methods=['POST'])
def api_save_note(newsletter_id):
    """
    Save the two-section notes file.
    Body: {"my_notes": "...", "ai_summary": "..."}
    Passing both empty strings deletes the file.
    """
    if not db_path.exists():
        return jsonify({'error': 'Database not found'}), 404
    record = get_newsletter_by_id(db_path, newsletter_id)
    if not record:
        return jsonify({'error': 'Not found'}), 404

    data       = request.get_json() or {}
    my_notes   = data.get('my_notes',   '')
    ai_summary = data.get('ai_summary', '')

    notes_path = (PROJECT_ROOT / record['file_path']).with_suffix('.notes.md')
    has_note   = bool(my_notes.strip() or ai_summary.strip())

    if has_note:
        notes_path.write_text(_build_notes(my_notes, ai_summary), encoding='utf-8')
        # Persist to user_data.json so notes survive full-purge
        _update_user_data(record['gmail_message_id'],
                          file_path=record['file_path'],
                          notes_rel_path=str(notes_path.relative_to(PROJECT_ROOT)),
                          notes_content=_build_notes(my_notes, ai_summary))
    elif notes_path.exists():
        notes_path.unlink()
        # Clear from user_data.json
        _update_user_data(record['gmail_message_id'],
                          file_path=record['file_path'],
                          notes_rel_path=None,
                          notes_content=None)

    return jsonify({'ok': True, 'has_note': has_note})


# ══════════════════════════════════════════════════════════════════
# API — AI SUMMARY GENERATION
# ══════════════════════════════════════════════════════════════════

def _strip_html_to_text(html_content):
    """Strip HTML tags and return plain text for LLM consumption."""
    from html.parser import HTMLParser

    class _Stripper(HTMLParser):
        def __init__(self):
            super().__init__()
            self.parts = []
            self._skip = False
        def handle_starttag(self, tag, attrs):
            if tag in ('script', 'style', 'head'):
                self._skip = True
            elif tag in ('p', 'div', 'br', 'li', 'h1', 'h2', 'h3', 'h4', 'tr'):
                self.parts.append('\n')
        def handle_endtag(self, tag):
            if tag in ('script', 'style', 'head'):
                self._skip = False
        def handle_data(self, data):
            if not self._skip:
                self.parts.append(data)

    parser = _Stripper()
    parser.feed(html_content)
    text = ''.join(parser.parts)
    # Collapse excessive whitespace
    import re as _re2
    text = _re2.sub(r'\n{3,}', '\n\n', text)
    text = _re2.sub(r' {2,}', ' ', text)
    return text.strip()


def _truncate_to_words(text, max_words):
    words = text.split()
    if len(words) <= max_words:
        return text
    return ' '.join(words[:max_words]) + '\n\n[Article truncated for summary]'


def _strip_thinking(text: str) -> str:
    """Strip <think>...</think> reasoning blocks from model output (qwen3, deepseek-r1, etc.)."""
    import re as _re2
    text = _re2.sub(r'<think>.*?</think>', '', text, flags=_re2.DOTALL | _re2.IGNORECASE)
    return text.strip()


def _call_ollama(prompt, model, base_url):
    import urllib.request
    payload = json.dumps({
        'model': model,
        'prompt': prompt,
        'stream': False
    }).encode('utf-8')
    req = urllib.request.Request(
        f"{base_url.rstrip('/')}/api/generate",
        data=payload,
        headers={'Content-Type': 'application/json'},
        method='POST'
    )
    # 300s: first call loads the model into memory, which can take 30-60s on top of generation
    with urllib.request.urlopen(req, timeout=300) as resp:
        result = json.loads(resp.read().decode('utf-8'))
        return _strip_thinking(result.get('response', ''))


def _call_openai_compatible(prompt, model, base_url, api_key):
    """Works for OpenAI, Groq, Together, and any OpenAI-compatible API."""
    import urllib.request
    payload = json.dumps({
        'model': model,
        'messages': [{'role': 'user', 'content': prompt}],
        'max_tokens': 800,
    }).encode('utf-8')
    headers = {'Content-Type': 'application/json'}
    if api_key:
        headers['Authorization'] = f'Bearer {api_key}'
    url = f"{base_url.rstrip('/')}/chat/completions" if base_url else 'https://api.openai.com/v1/chat/completions'
    req = urllib.request.Request(url, data=payload, headers=headers, method='POST')
    with urllib.request.urlopen(req, timeout=60) as resp:
        result = json.loads(resp.read().decode('utf-8'))
        return _strip_thinking(result['choices'][0]['message']['content'])


def _call_anthropic(prompt, model, api_key):
    import urllib.request
    payload = json.dumps({
        'model': model or 'claude-haiku-4-5',
        'max_tokens': 800,
        'messages': [{'role': 'user', 'content': prompt}],
    }).encode('utf-8')
    req = urllib.request.Request(
        'https://api.anthropic.com/v1/messages',
        data=payload,
        headers={
            'Content-Type': 'application/json',
            'x-api-key': api_key,
            'anthropic-version': '2023-06-01',
        },
        method='POST'
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        result = json.loads(resp.read().decode('utf-8'))
        return _strip_thinking(result['content'][0]['text'])


@app.route('/api/newsletters/<int:newsletter_id>/generate-summary', methods=['POST'])
def api_generate_summary(newsletter_id):
    """
    Generate an AI summary for a newsletter using the configured provider.
    Writes the result to the ## AI Summary section of the .notes.md file.
    Returns: {"ok": true, "ai_summary": "..."}
    """
    if not db_path.exists():
        return jsonify({'ok': False, 'error': 'Database not found'}), 404

    record = get_newsletter_by_id(db_path, newsletter_id)
    if not record:
        return jsonify({'ok': False, 'error': 'Newsletter not found'}), 404

    # Read AI config (always fresh — user may have changed it via the UI)
    ai_cfg   = load_ai_config()
    provider = ai_cfg.get('provider', 'ollama')
    model    = ai_cfg.get('model', '').strip()
    base_url = ai_cfg.get('base_url', 'http://localhost:11434')
    api_key  = ai_cfg.get('api_key', '') or os.environ.get('AI_API_KEY', '')
    max_words = int(ai_cfg.get('max_words', 6000))

    if not model:
        return jsonify({
            'ok': False,
            'error': (
                'No AI model configured.\n\n'
                'Go to Settings → AI Summary, enter your model name '
                '(e.g. qwen3:8b), and click Save.'
            )
        }), 400

    # Read + strip the newsletter HTML
    html_path = PROJECT_ROOT / record['file_path']
    if not html_path.exists():
        return jsonify({'ok': False, 'error': 'Newsletter file not found on disk'}), 404

    plain_text = _strip_html_to_text(html_path.read_text(encoding='utf-8', errors='replace'))
    plain_text = _truncate_to_words(plain_text, max_words)

    # Use user-configured prompt (or fall back to default)
    summary_instruction = ai_cfg.get('summary_prompt', '').strip() or _DEFAULT_SUMMARY_PROMPT

    prompt = (
        f"{summary_instruction}\n\n"
        f"Article title: {record['title']}\n"
        f"Publication: {record['publication']}\n\n"
        f"Article text:\n{plain_text}"
    )

    try:
        if provider == 'ollama':
            import urllib.error
            import socket
            try:
                summary = _call_ollama(prompt, model, base_url)
            except urllib.error.HTTPError as e:
                # Ollama returned a non-200 (e.g. model not found)
                try:
                    body = json.loads(e.read().decode('utf-8'))
                    err_msg = body.get('error', str(e))
                except Exception:
                    err_msg = str(e)
                # Make "model not found" actionable
                if 'not found' in err_msg.lower() or 'pull' in err_msg.lower():
                    err_msg = (
                        f"Model '{model}' is not installed in Ollama.\n\n"
                        f"Fix: open Terminal and run:\n"
                        f"  ollama pull {model}\n\n"
                        f"Or go to Settings → AI Summary, click ↺ Load, "
                        f"select an installed model, and Save."
                    )
                return jsonify({'ok': False, 'error': err_msg}), 400
            except (TimeoutError, socket.timeout):
                return jsonify({
                    'ok': False,
                    'error': (
                        f"Ollama took too long to respond.\n\n"
                        f"The first summary with a model takes longer because Ollama loads it into memory first.\n\n"
                        f"Fix: pre-load the model by running in Terminal:\n"
                        f"  ollama run {model}\n"
                        f"Then close that session and try Generate again."
                    )
                }), 503
            except urllib.error.URLError:
                return jsonify({
                    'ok': False,
                    'error': 'Ollama is not running.\n\nFix: open Terminal and run:\n  ollama serve'
                }), 503

        elif provider in ('openai', 'custom'):
            if not api_key and provider == 'openai':
                return jsonify({
                    'ok': False,
                    'error': 'No API key configured for OpenAI. Set api_key in ai_config.yaml or the AI_API_KEY env var.'
                }), 400
            openai_url = base_url if provider == 'custom' else 'https://api.openai.com/v1'
            summary = _call_openai_compatible(prompt, model, openai_url, api_key)

        elif provider == 'anthropic':
            if not api_key:
                return jsonify({
                    'ok': False,
                    'error': 'No API key configured for Anthropic. Set api_key in ai_config.yaml or the AI_API_KEY env var.'
                }), 400
            summary = _call_anthropic(prompt, model, api_key)

        else:
            return jsonify({'ok': False, 'error': f"Unknown provider '{provider}'"}), 400

    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500

    # Prepend generation metadata header (timestamp + model attribution)
    ts = datetime.now().strftime('%d %b %Y, %H:%M')
    header = f"Generated: {ts} · {model} via {provider}"
    summary_with_header = f"{header}\n\n{summary}"

    # Save to .notes.md AI Summary section (preserving existing My Notes)
    notes_path = html_path.with_suffix('.notes.md')
    existing_content = notes_path.read_text(encoding='utf-8') if notes_path.exists() else ''
    my_notes, _ = _parse_notes(existing_content)
    notes_path.write_text(_build_notes(my_notes, summary_with_header), encoding='utf-8')

    # Update user_data.json persistence
    _update_user_data(record['gmail_message_id'],
                      file_path=record['file_path'],
                      notes_rel_path=str(notes_path.relative_to(PROJECT_ROOT)),
                      notes_content=_build_notes(my_notes, summary_with_header))

    return jsonify({'ok': True, 'ai_summary': summary_with_header})


# ══════════════════════════════════════════════════════════════════
# API — AI CONFIG (read / write / test ai_config.yaml)
# ══════════════════════════════════════════════════════════════════

@app.route('/api/ai-config', methods=['GET'])
def api_get_ai_config():
    """Return current AI config (never exposes full api_key — masked)."""
    cfg = load_ai_config()
    # Mask the key so it's not exposed in the browser network tab
    if cfg.get('api_key'):
        cfg['api_key_set'] = True
        cfg['api_key']     = '••••••••'
    else:
        cfg['api_key_set'] = False
    return jsonify(cfg)


@app.route('/api/ai-config', methods=['POST'])
def api_save_ai_config():
    """
    Save AI config to ai_config.yaml.
    If api_key is the masked placeholder, preserve the existing value.
    """
    data = request.get_json(force=True) or {}
    allowed = {'provider', 'model', 'base_url', 'api_key', 'max_words', 'summary_prompt'}
    clean = {k: v for k, v in data.items() if k in allowed}

    # Don't overwrite a real key with the masked display value
    if clean.get('api_key', '').startswith('••'):
        existing = load_ai_config()
        clean['api_key'] = existing.get('api_key', '')

    try:
        with open(AI_CONFIG_PATH, 'w', encoding='utf-8') as f:
            yaml.dump(clean, f, default_flow_style=False, allow_unicode=True, sort_keys=True)
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 500


@app.route('/api/ai-config/test', methods=['POST'])
def api_test_ai_config():
    """
    Quick connectivity check for the configured AI provider.
    For Ollama: verifies the local server is reachable.
    For cloud providers: confirms an API key is present (doesn't make a live call).
    """
    import urllib.request
    import urllib.error

    cfg      = load_ai_config()
    provider = cfg.get('provider', 'ollama')
    api_key  = cfg.get('api_key', '') or os.environ.get('AI_API_KEY', '')

    if provider == 'ollama':
        base_url = cfg.get('base_url', 'http://localhost:11434').rstrip('/')
        model = cfg.get('model', '').strip() or '(none set)'
        try:
            req = urllib.request.Request(base_url, method='GET')
            urllib.request.urlopen(req, timeout=3)
            return jsonify({'ok': True, 'message': f'Ollama is running ✓  (model: {model})'})
        except urllib.error.URLError:
            return jsonify({
                'ok': False,
                'error': (
                    f'Ollama is not running.\n\n'
                    f'Fix: open Terminal and run:\n'
                    f'  ollama serve\n\n'
                    f'Leave that window open, then click Test again.\n'
                    f'(If not installed: brew install ollama)'
                )
            })

    elif provider in ('openai', 'anthropic'):
        name = 'OpenAI' if provider == 'openai' else 'Anthropic'
        key_hint = 'platform.openai.com/api-keys' if provider == 'openai' else 'console.anthropic.com → API Keys'
        if not api_key:
            return jsonify({
                'ok': False,
                'error': (
                    f'No API key found for {name}.\n\n'
                    f'Fix:\n'
                    f'1. Get your key from {key_hint}\n'
                    f'2. Paste it in the API Key field above\n'
                    f'3. Click Save, then Test again'
                )
            })
        return jsonify({'ok': True, 'message': f'{name} API key present ✓  (model: {cfg.get("model", "?")})'})

    elif provider == 'custom':
        base_url = cfg.get('base_url', '').rstrip('/')
        if not base_url:
            return jsonify({
                'ok': False,
                'error': 'No Base URL set.\n\nFix: enter your server address in the Base URL field above (e.g. http://localhost:1234/v1)'
            })
        try:
            req = urllib.request.Request(base_url + '/models', method='GET')
            urllib.request.urlopen(req, timeout=4)
            return jsonify({'ok': True, 'message': f'Server reachable at {base_url} ✓'})
        except urllib.error.URLError:
            return jsonify({
                'ok': False,
                'error': (
                    f'Server not reachable at {base_url}\n\n'
                    f'Check:\n'
                    f'• Is the server running?\n'
                    f'• Is the Base URL correct (including /v1 if needed)?\n'
                    f'• Try opening {base_url}/models in your browser'
                )
            })

    return jsonify({'ok': False, 'error': f"Unknown provider '{provider}'"})


@app.route('/api/ai-config/models', methods=['GET'])
def api_list_ai_models():
    """
    List available models for the configured provider.
    For Ollama: hits /api/tags and returns the model names.
    For cloud providers: returns an empty list (user types their own).
    """
    import urllib.request
    import urllib.error

    cfg      = load_ai_config()
    # Allow the UI to pass current (unsaved) values so Load works before Save is clicked
    provider = request.args.get('provider') or cfg.get('provider', 'ollama')

    if provider in ('ollama', 'custom'):
        base_url = (request.args.get('base_url') or cfg.get('base_url', 'http://localhost:11434')).rstrip('/')
        try:
            req = urllib.request.Request(f"{base_url}/api/tags", method='GET')
            with urllib.request.urlopen(req, timeout=4) as resp:
                data = json.loads(resp.read().decode('utf-8'))
                models = [m['name'] for m in data.get('models', [])]
                return jsonify({'ok': True, 'models': models})
        except urllib.error.URLError:
            return jsonify({
                'ok': False,
                'error': 'Ollama not reachable. Run: ollama serve',
                'models': []
            })
        except Exception as e:
            return jsonify({'ok': False, 'error': str(e), 'models': []})

    # Cloud providers: no model list to fetch
    return jsonify({'ok': True, 'models': []})


# ══════════════════════════════════════════════════════════════════
# API — READING STATS
# ══════════════════════════════════════════════════════════════════

@app.route('/api/stats')
def api_reading_stats():
    """
    Return reading habit statistics for the pride/habit view.
    Uses is_read + date_received from the newsletters table.
    """
    if not db_path.exists():
        return jsonify({'error': 'Database not found'}), 404

    import sqlite3 as _sqlite3
    from datetime import date, timedelta

    con = _sqlite3.connect(db_path)
    con.row_factory = _sqlite3.Row

    today     = date.today()
    week_ago  = (today - timedelta(days=7)).isoformat()
    month_str = today.strftime('%Y-%m')

    # Totals
    total_library = con.execute('SELECT COUNT(*) FROM newsletters').fetchone()[0]
    total_read    = con.execute('SELECT COUNT(*) FROM newsletters WHERE is_read=1').fetchone()[0]
    this_week     = con.execute(
        "SELECT COUNT(*) FROM newsletters WHERE is_read=1 AND date(read_at) >= ?",
        (week_ago,)
    ).fetchone()[0]
    this_month    = con.execute(
        "SELECT COUNT(*) FROM newsletters WHERE is_read=1 AND substr(read_at,1,7) = ?",
        (month_str,)
    ).fetchone()[0]

    # Top 5 publications by read count
    top_pubs = con.execute(
        '''SELECT publication, COUNT(*) as cnt
           FROM newsletters WHERE is_read=1
           GROUP BY publication ORDER BY cnt DESC LIMIT 5'''
    ).fetchall()

    # Read counts by month (last 12 months) — keyed on when user marked, not article date
    read_by_month = con.execute(
        '''SELECT substr(read_at,1,7) as month, COUNT(*) as cnt
           FROM newsletters WHERE is_read=1 AND read_at IS NOT NULL
           GROUP BY month ORDER BY month DESC LIMIT 12'''
    ).fetchall()

    # Last calendar month count (for vs-last-month comparison)
    from datetime import date as _date_cls
    first_of_this_month = today.replace(day=1)
    last_month_date = first_of_this_month - timedelta(days=1)
    last_month_str = last_month_date.strftime('%Y-%m')
    read_last_month = con.execute(
        "SELECT COUNT(*) FROM newsletters WHERE is_read=1 AND substr(read_at,1,7) = ?",
        (last_month_str,)
    ).fetchone()[0]

    # Total words read (approximate)
    total_words_row = con.execute(
        "SELECT SUM(word_count) FROM newsletters WHERE is_read=1 AND word_count > 0"
    ).fetchone()
    total_words_read = total_words_row[0] or 0

    # Best day of week (0=Sun through 6=Sat) — based on when user actually marked it read
    best_dow_row = con.execute(
        '''SELECT CAST(strftime('%w', date(read_at)) AS INTEGER) as dow, COUNT(*) as cnt
           FROM newsletters WHERE is_read=1 AND read_at IS NOT NULL
           GROUP BY dow ORDER BY cnt DESC LIMIT 1'''
    ).fetchone()
    dow_names = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    best_day_of_week = dow_names[best_dow_row[0]] if best_dow_row else None

    # Day-level read counts (for calendar heatmap) — keyed on mark-done date
    read_by_date_rows = con.execute(
        '''SELECT date(read_at) as d, COUNT(*) as cnt
           FROM newsletters WHERE is_read=1 AND read_at IS NOT NULL
           GROUP BY d ORDER BY d ASC'''
    ).fetchall()

    # Average words read by day of week (0=Sun … 6=Sat)
    words_by_dow_rows = con.execute(
        '''SELECT CAST(strftime('%w', date(read_at)) AS INTEGER) as dow,
                  ROUND(AVG(word_count)) as avg_words
           FROM newsletters
           WHERE is_read=1 AND read_at IS NOT NULL AND word_count > 0
           GROUP BY dow'''
    ).fetchall()

    # Streak: consecutive days where user marked at least 1 newsletter done
    read_dates = set(
        r[0] for r in con.execute(
            "SELECT DISTINCT date(read_at) FROM newsletters WHERE is_read=1 AND read_at IS NOT NULL"
        ).fetchall()
    )

    # Words read over specific windows
    words_last_7 = con.execute(
        "SELECT COALESCE(SUM(word_count),0) FROM newsletters "
        "WHERE is_read=1 AND word_count > 0 AND date(read_at) >= date('now','-7 days')"
    ).fetchone()[0]
    words_this_month = con.execute(
        "SELECT COALESCE(SUM(word_count),0) FROM newsletters "
        "WHERE is_read=1 AND word_count > 0 "
        "AND strftime('%Y-%m',date(read_at))=strftime('%Y-%m','now')"
    ).fetchone()[0]
    words_last_month = con.execute(
        "SELECT COALESCE(SUM(word_count),0) FROM newsletters "
        "WHERE is_read=1 AND word_count > 0 "
        "AND strftime('%Y-%m',date(read_at))=strftime('%Y-%m',date('now','-1 month'))"
    ).fetchone()[0]

    con.close()

    # Current streak (from today backward)
    current_streak = 0
    check = today
    while check.isoformat() in read_dates:
        current_streak += 1
        check -= timedelta(days=1)

    # Longest streak
    if read_dates:
        sorted_dates = sorted(date.fromisoformat(d) for d in read_dates)
        longest = cur_run = 1
        for i in range(1, len(sorted_dates)):
            if (sorted_dates[i] - sorted_dates[i-1]).days == 1:
                cur_run += 1
                longest = max(longest, cur_run)
            else:
                cur_run = 1
    else:
        longest = 0

    return jsonify({
        'total_read':          total_read,
        'total_library':       total_library,
        'this_week':           this_week,
        'this_month':          this_month,
        'read_last_month':     read_last_month,
        'total_words_read':    total_words_read,
        'words_last_7':        words_last_7,
        'words_this_month':    words_this_month,
        'words_last_month':    words_last_month,
        'best_day_of_week':    best_day_of_week,
        'current_streak_days': current_streak,
        'longest_streak_days': longest,
        'top_publications':    [{'name': r['publication'], 'read': r['cnt']} for r in top_pubs],
        'read_by_month':       [{'month': r['month'], 'count': r['cnt']}
                                for r in reversed(list(read_by_month))],
        'read_by_date':        [{'date': r[0], 'count': r[1]} for r in read_by_date_rows],
        'words_by_dow':        [{'dow': r[0], 'avg': int(r[1] or 0)} for r in words_by_dow_rows],
    })


# ══════════════════════════════════════════════════════════════════
# API — REVEAL IN FINDER / EXPLORER
# ══════════════════════════════════════════════════════════════════

@app.route('/api/reveal', methods=['POST'])
def api_reveal():
    """
    Open a newsletter's folder in the OS file manager (Finder on Mac,
    Explorer on Windows, file manager on Linux).

    Similar to Obsidian's "Reveal in Finder" / "Show in Explorer".

    Request body (JSON):
        path — relative file path (from the database file_path field)
               OR a folder path like 'newsletters/finshots'

    Security: The path is validated to ensure it stays inside the
    newsletters/ directory. Requests for paths outside are rejected.
    """
    data = request.get_json() or {}
    rel_path = data.get('path', '').strip()

    if not rel_path:
        return jsonify({'error': 'No path provided'}), 400

    # Resolve the full absolute path
    target = (PROJECT_ROOT / rel_path).resolve()

    # Security check: path must be inside newsletters/ or assets/
    # This prevents someone from using the API to open arbitrary system folders.
    allowed_roots = [
        newsletters_dir.resolve(),
        assets_dir.resolve(),
        PROJECT_ROOT.resolve()
    ]
    is_allowed = any(
        str(target).startswith(str(root)) for root in allowed_roots
    )
    if not is_allowed:
        return jsonify({'error': 'Path is outside the allowed directory'}), 403

    # If path points to a file, open its parent folder
    if target.is_file():
        target = target.parent

    if not target.exists():
        return jsonify({'error': f'Folder does not exist: {rel_path}'}), 404

    # Open in the OS file manager — command differs by platform
    try:
        system = platform.system()
        if system == 'Darwin':                          # macOS
            subprocess.Popen(['open', str(target)])
        elif system == 'Windows':
            subprocess.Popen(['explorer', str(target)])
        else:                                           # Linux
            subprocess.Popen(['xdg-open', str(target)])

        return jsonify({'ok': True, 'opened': str(target)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ══════════════════════════════════════════════════════════════════
# STARTUP
# ══════════════════════════════════════════════════════════════════

def open_browser():
    """Open the BookSelf UI in the default browser after Flask has started."""
    webbrowser.open('http://127.0.0.1:5001')


if __name__ == '__main__':
    print()
    print("╔══════════════════════════════════════╗")
    print("║         BookSelf — Starting          ║")
    print("╚══════════════════════════════════════╝")
    print()
    print("  Opening http://127.0.0.1:5001 in your browser...")
    print("  Press Ctrl+C to stop the server.")
    print()

    # Open browser 1 second after Flask starts
    # (delay gives Flask time to start listening before the browser connects)
    timer = threading.Timer(1.0, open_browser)
    timer.daemon = True
    timer.start()

    # use_reloader=False prevents Flask from spawning a second process
    # (which would cause the browser to open twice and break SSE)
    app.run(
        host='127.0.0.1',
        port=5001,
        debug=False,
        use_reloader=False
    )

    # TODO: scheduled sync via APScheduler (out of scope for v0.1)
