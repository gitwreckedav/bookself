#!/usr/bin/env python3
# ─────────────────────────────────────────────────────────────────
# bookself/desktop.py
#
# Native macOS app entry point. This is what the packaged BookSelf.app
# runs. It does two jobs:
#
#   1. Multi-call dispatch: when the Sync button runs, the packaged app
#      has no Python interpreter — so app.py re-invokes THIS binary with
#      --run-fetch / --run-catalog, and we route to the right script.
#
#   2. GUI shell: starts the Flask server on a background thread, then
#      opens a native window (pywebview / WKWebView) pointed at it.
#      Closing the window quits the server — like a real app.
#
# Dev mode is unchanged: `python app.py` still works exactly as before.
# ─────────────────────────────────────────────────────────────────

import sys
import socket
import threading


def _dispatch_cli():
    """Route --run-fetch / --run-catalog invocations to the scripts."""
    argv = sys.argv[1:]
    if '--run-fetch' in argv or '--run-catalog' in argv:
        # Line-buffer stdout so SSE streaming in the UI stays real-time
        try:
            sys.stdout.reconfigure(line_buffering=True)
        except Exception:
            pass
        if '--run-fetch' in argv:
            sys.argv = [sys.argv[0]] + [a for a in argv if a != '--run-fetch']
            import fetch
            fetch.main()
        else:
            sys.argv = [sys.argv[0]] + [a for a in argv if a != '--run-catalog']
            import catalog
            catalog.main()
        sys.exit(0)


def _find_port(preferred=5001):
    """Use 5001 if free (matches dev habit); otherwise grab any free port."""
    for port in (preferred, 0):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind(('127.0.0.1', port))
                return s.getsockname()[1]
        except OSError:
            continue
    return 0


def main():
    _dispatch_cli()

    # Import AFTER dispatch — subprocess calls shouldn't pay GUI import cost
    import webview
    from app import app as flask_app, APP_VERSION

    port = _find_port()
    server = threading.Thread(
        target=lambda: flask_app.run(
            host='127.0.0.1', port=port, debug=False, use_reloader=False
        ),
        daemon=True,
    )
    server.start()

    webview.create_window(
        f'BookSelf',
        f'http://127.0.0.1:{port}',
        width=1440,
        height=900,
        min_size=(1000, 680),
    )
    webview.start()  # Blocks until the window is closed; daemon server dies with us


if __name__ == '__main__':
    main()
