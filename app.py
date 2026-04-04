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
    get_recent_for_series, get_total_count, get_last_fetched_at, get_source_count
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

    body       = request.get_json(silent=True) or {}
    mode       = body.get('mode', 'incremental')
    start_date = body.get('start_date')  # optional, seed mode only

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

            # ── Stage 2: Cataloging ───────────────────────────────
            yield "data: \n\n"
            yield "data: ═══════════════════════════════════════\n\n"
            yield "data: 📚 Stage 2: Cataloging\n\n"
            yield "data: ═══════════════════════════════════════\n\n"

            # Build catalog.py command — pass --start-date in seed mode
            # so it purges pre-start-date entries and date-filters the raw files.
            seed_start_date = config.get('settings', {}).get('seed_start_date', '2024-01-01')
            catalog_cmd = [sys.executable, '-u', str(catalog_script)]
            if mode == 'seed':
                catalog_cmd += ['--start-date', seed_start_date]

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

    Combines data from config.yaml (name, sender email) with the database
    (count of newsletters per publication). Safe to call even if DB doesn't exist yet.

    Returns a list of:
        { name: str, sender: str, count: int }
    """
    sources = config.get('sources', [])
    result = []
    for source in sources:
        count = get_source_count(db_path, source['name']) if db_path.exists() else 0
        result.append({
            'name': source['name'],
            'sender': source.get('sender', ''),
            'count': count
        })
    return jsonify(result)


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
