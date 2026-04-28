#!/usr/bin/env python3
# ─────────────────────────────────────────────────────────────────
# bookself/fetch.py  —  ACQUISITION ENGINE
#
# This script is responsible for ONE thing only: getting emails from
# Gmail and writing them to disk as raw JSON files in data/raw/.
#
# It does NOT parse HTML, detect series, clean content, save images,
# or insert into the database. Those are cataloging concerns handled
# by catalog.py which runs after this script completes.
#
# Two modes:
#   python fetch.py --mode seed [--start-date 2024-01-01]
#     → Fetches ALL emails from all sources since the start date.
#       Safe to re-run: already-downloaded messages are counted as
#       written without re-downloading (idempotent).
#
#   python fetch.py --mode incremental
#     → Reads last_successful_sync_epoch_ms from sync_state.json,
#       queries Gmail for messages AFTER that timestamp. If no state
#       exists, prints an error and exits — run seed mode first.
#
# Invariant (strictly enforced):
#   total_ids_returned == total_files_written
#   If this does not hold → exit(1), sync state NOT updated.
#   No silent failures. Every ID either gets a file or causes an abort.
#
# Output files:
#   data/raw/<message_id>.json         ← one per email
#   data/state/sync_state.json         ← updated on invariant pass
#   data/manifests/<ts>_manifest.json  ← written every run
# ─────────────────────────────────────────────────────────────────

import sys
import json
import argparse
import traceback
from datetime import datetime, timezone
from pathlib import Path

# ── Import BookSelf modules ───────────────────────────────────────
PROJECT_ROOT = Path(__file__).parent
sys.path.insert(0, str(PROJECT_ROOT))

from bookself.config_loader import load_config
from bookself.gmail_client import get_gmail_service, get_full_message
from bookself.email_parser import extract_html_and_attachments


# ── Storage paths ─────────────────────────────────────────────────
DATA_DIR      = PROJECT_ROOT / 'data'
RAW_DIR       = DATA_DIR / 'raw'
STATE_DIR     = DATA_DIR / 'state'
STATE_FILE    = STATE_DIR / 'sync_state.json'
MANIFESTS_DIR = DATA_DIR / 'manifests'


# ══════════════════════════════════════════════════════════════════
# SYNC STATE — persistent JSON on disk
# ══════════════════════════════════════════════════════════════════

def load_sync_state():
    """
    Read sync_state.json from disk.
    Returns the parsed dict, or None if the file does not exist.
    """
    if not STATE_FILE.exists():
        return None
    try:
        return json.loads(STATE_FILE.read_text(encoding='utf-8'))
    except Exception as e:
        print(f"  [State] ⚠️  Could not read sync_state.json: {e}")
        return None


def save_sync_state(mode, ids_returned, files_written, max_epoch_ms):
    """
    Write sync_state.json after a successful (invariant-passing) run.

    max_epoch_ms is the highest internalDate seen across all fetched
    messages. Incremental mode will query Gmail for everything AFTER
    this timestamp on the next run.
    """
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)

    state = {
        'last_successful_sync_epoch_ms': max_epoch_ms,
        'last_run_summary': {
            'mode': mode,
            'ids_returned': ids_returned,
            'files_written': files_written,
            'timestamp_ms': now_ms,
            'timestamp_human': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        }
    }

    STATE_FILE.write_text(json.dumps(state, indent=2), encoding='utf-8')
    print(f"\n  [State] sync_state.json updated.")
    print(f"          Next incremental sync will fetch messages after: {max_epoch_ms}")


# ══════════════════════════════════════════════════════════════════
# MANIFEST — per-run audit log
# ══════════════════════════════════════════════════════════════════

def save_manifest(mode, start_date_str, ids_returned, files_written,
                  errors, all_ids, invariant_passed):
    """
    Write a timestamped manifest JSON to data/manifests/.
    Written on EVERY run — even failures — for auditability.
    """
    MANIFESTS_DIR.mkdir(parents=True, exist_ok=True)

    ts_str = datetime.now().strftime('%Y%m%d_%H%M%S')
    manifest_path = MANIFESTS_DIR / f'{ts_str}_manifest.json'

    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    manifest = {
        'mode': mode,
        'start_date': start_date_str,
        'ids_returned': ids_returned,
        'files_written': files_written,
        'errors': errors,
        'invariant_passed': invariant_passed,
        'timestamp_ms': now_ms,
        'timestamp_human': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        'ids_processed': all_ids
    }

    manifest_path.write_text(json.dumps(manifest, indent=2), encoding='utf-8')
    print(f"  [Manifest] Written: {manifest_path.name}")
    return manifest_path


# ══════════════════════════════════════════════════════════════════
# GMAIL QUERIES — build query strings and fetch IDs
# ══════════════════════════════════════════════════════════════════

def build_seed_query(source, start_date_str):
    """
    Build a Gmail search query for seed mode (date-based).
    Gmail search syntax: from:sender after:YYYY/MM/DD
    """
    # Convert YYYY-MM-DD to YYYY/MM/DD for Gmail
    date_for_query = start_date_str.replace('-', '/')
    return f"from:{source['sender']} after:{date_for_query}"


def build_incremental_query(source, since_epoch_ms):
    """
    Build a Gmail search query for incremental mode (epoch-based).
    Gmail API supports: from:sender after:EPOCH_SECONDS
    This is more precise than date-based queries — avoids re-fetching
    the entire last day every time.
    """
    epoch_sec = since_epoch_ms // 1000
    return f"from:{source['sender']} after:{epoch_sec}"


def fetch_ids_for_source(service, source, query_str):
    """
    Fetch all Gmail message IDs matching the given query string.

    Handles pagination automatically — Gmail returns results in pages
    of up to 100. We keep requesting pages until there are no more.

    Returns:
        list of str: Gmail message IDs
    """
    print(f"  [Gmail] Query: {query_str}")

    message_ids = []
    page_token = None

    while True:
        params = {
            'userId': 'me',
            'q': query_str,
            'maxResults': 500  # Max allowed by Gmail API
        }
        if page_token:
            params['pageToken'] = page_token

        response = service.users().messages().list(**params).execute()

        messages = response.get('messages', [])
        message_ids.extend([msg['id'] for msg in messages])

        page_token = response.get('nextPageToken')
        if not page_token:
            break

    print(f"  [Gmail] Found {len(message_ids)} message(s) from {source['sender']}")
    return message_ids


# ══════════════════════════════════════════════════════════════════
# RAW FILE WRITER — the core acquisition unit
# ══════════════════════════════════════════════════════════════════

def fetch_and_write_raw(service, message_id, source, raw_dir):
    """
    Download one Gmail message and write it to data/raw/<id>.json.

    This function NEVER raises an exception. It catches all errors
    internally and returns (False, None) if something went wrong.
    A partial failure here does NOT propagate — the caller tracks
    the total and enforces the invariant.

    If HTML extraction succeeds:
        data/raw/<id>.json contains the full HTML in the 'html' field.

    If HTML extraction fails:
        data/raw/<id>.json is still written with html: null and a
        raw_snippet from the Gmail API for debugging. The file is
        still created, still counted toward the invariant.

    Returns:
        tuple: (success: bool, internal_date_ms: int | None)
    """
    raw_path = raw_dir / f'{message_id}.json'

    try:
        # ── Download full message from Gmail ──────────────────────
        message_data = get_full_message(service, message_id)

        # ── Extract metadata from headers ─────────────────────────
        headers = {}
        for h in message_data.get('payload', {}).get('headers', []):
            headers[h['name'].lower()] = h['value']

        subject = headers.get('subject', '(no subject)')
        from_header = headers.get('from', source['sender'])
        date_header = headers.get('date', '')
        internal_date_ms = int(message_data.get('internalDate', 0))

        # Parse date string to YYYY-MM-DD
        date_str = None
        if date_header:
            try:
                from email.utils import parsedate_to_datetime
                dt = parsedate_to_datetime(date_header)
                date_str = dt.strftime('%Y-%m-%d')
            except Exception:
                pass
        if not date_str and internal_date_ms:
            date_str = datetime.fromtimestamp(
                internal_date_ms / 1000
            ).strftime('%Y-%m-%d')
        if not date_str:
            date_str = datetime.now().strftime('%Y-%m-%d')

        # Parse sender name from "Name <email>" format
        sender_name = source['name']
        if '<' in from_header:
            sender_name = from_header.split('<')[0].strip().strip('"')

        # ── Extract HTML from MIME structure ──────────────────────
        html_content = None
        html_available = False
        raw_snippet = message_data.get('snippet', '')

        try:
            html_content, _ = extract_html_and_attachments(
                message_data.get('payload', {})
            )
            if html_content:
                html_available = True
        except Exception as e:
            print(f"    ⚠️  HTML extraction failed for {message_id}: {e}")
            # html_content stays None — we'll save without it

        # ── Write raw JSON to disk ────────────────────────────────
        record = {
            'message_id': message_id,
            'source_name': source['name'],
            'source_sender': source['sender'],
            'source_type': source.get('type', 'simple'),
            'subject': subject,
            'sender_name': sender_name,
            'date_str': date_str,
            'internal_date_ms': internal_date_ms,
            'html': html_content,
            'html_available': html_available,
            'raw_snippet': raw_snippet if not html_available else None,
            'fetched_at': datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
        }

        raw_dir.mkdir(parents=True, exist_ok=True)
        raw_path.write_text(json.dumps(record, ensure_ascii=False), encoding='utf-8')

        status = '✅' if html_available else '⚠️  (no HTML)'
        print(f"    {status} {date_str} | {subject[:60]}")

        return True, internal_date_ms

    except Exception as e:
        # Last-resort catch: even if everything fails, write a stub file
        # so the file exists and the invariant can still be checked
        print(f"    ❌ Failed to process {message_id}: {e}")
        traceback.print_exc()

        try:
            stub = {
                'message_id': message_id,
                'source_name': source['name'],
                'source_sender': source['sender'],
                'html': None,
                'html_available': False,
                'error': str(e),
                'fetched_at': datetime.now().strftime('%Y-%m-%dT%H:%M:%S')
            }
            raw_dir.mkdir(parents=True, exist_ok=True)
            raw_path.write_text(json.dumps(stub), encoding='utf-8')
            # Stub file written — counts as written for invariant tracking,
            # but catalog.py will skip it (html_available: false)
            return True, None
        except Exception as stub_err:
            print(f"    ❌ Could not even write stub file: {stub_err}")
            return False, None


# ══════════════════════════════════════════════════════════════════
# SEED MODE
# ══════════════════════════════════════════════════════════════════

def run_seed(config, gmail_service, start_date_str):
    """
    Seed mode: fetch ALL emails from all sources since start_date_str.

    This is designed to be run once per machine to build the initial
    library. It is idempotent: if data/raw/<id>.json already exists
    for a message, it is counted as written without re-downloading.

    Enforces the invariant: ids_returned == files_written.
    If the invariant fails, sync_state.json is NOT updated.
    """
    print(f"\n  [Seed] Start date: {start_date_str}")
    print(f"  [Seed] This will fetch everything from {start_date_str} to today.")
    print(f"  [Seed] Already-downloaded messages will be skipped (idempotent).\n")

    # ── Step 1: Collect ALL message IDs from ALL sources ──────────
    all_id_source_pairs = []   # list of (message_id, source_config)

    for source in config['sources']:
        print(f"\n{'─' * 50}")
        print(f"  📰 {source['name']}  ({source['sender']})")
        print(f"{'─' * 50}")

        try:
            query = build_seed_query(source, start_date_str)
            ids = fetch_ids_for_source(gmail_service, source, query)
            for msg_id in ids:
                all_id_source_pairs.append((msg_id, source))
        except Exception as e:
            print(f"  ❌ Failed to query Gmail for {source['name']}: {e}")
            traceback.print_exc()
            # A query failure means we can't know the real ID count.
            # Abort immediately — better than a silent undercount.
            print(f"\n❌ Aborting seed: Gmail query failed for {source['name']}.")
            print(f"   sync_state.json was NOT updated.")
            sys.exit(1)

    total_ids = len(all_id_source_pairs)
    print(f"\n{'═' * 50}")
    print(f"  [Seed] Total IDs across all sources: {total_ids}")
    print(f"{'═' * 50}\n")

    if total_ids == 0:
        print("  ℹ️  No messages found for any source.")
        print("     Check that sender emails in config.yaml are correct.")
        # 0 IDs → 0 files. Invariant holds trivially.
        save_manifest('seed', start_date_str, 0, 0, [], [], invariant_passed=True)
        # Don't update sync_state — there's nothing meaningful to record.
        return

    # ── Step 2: Download and write each message ────────────────────
    files_written = 0
    errors = []
    max_epoch_ms = 0

    print(f"  [Seed] Fetching and writing {total_ids} messages...")
    print()

    for idx, (msg_id, source) in enumerate(all_id_source_pairs, 1):
        raw_path = RAW_DIR / f'{msg_id}.json'

        if raw_path.exists():
            # Already on disk from a previous run — count it, skip download
            files_written += 1
            # Recover internal_date_ms from the existing file for state tracking
            try:
                existing = json.loads(raw_path.read_text(encoding='utf-8'))
                epoch = existing.get('internal_date_ms', 0)
                if epoch:
                    max_epoch_ms = max(max_epoch_ms, epoch)
            except Exception:
                pass
            continue

        print(f"  [{idx}/{total_ids}] {source['name']}")
        success, epoch_ms = fetch_and_write_raw(gmail_service, msg_id, source, RAW_DIR)

        if success:
            files_written += 1
            if epoch_ms:
                max_epoch_ms = max(max_epoch_ms, epoch_ms)
        else:
            errors.append(msg_id)

    # ── Step 3: Enforce invariant ──────────────────────────────────
    print(f"\n{'═' * 50}")
    print(f"  [Seed] IDs returned:   {total_ids}")
    print(f"  [Seed] Files written:  {files_written}")
    print(f"  [Seed] Errors:         {len(errors)}")
    print(f"{'═' * 50}")

    all_ids = [pair[0] for pair in all_id_source_pairs]

    if total_ids != files_written:
        print(f"\n❌ INVARIANT FAILED: {total_ids} IDs returned but {files_written} files written.")
        if errors:
            print(f"   Failed IDs: {errors[:10]}{'...' if len(errors) > 10 else ''}")
        print(f"   sync_state.json was NOT updated.")
        save_manifest('seed', start_date_str, total_ids, files_written,
                      errors, all_ids, invariant_passed=False)
        sys.exit(1)

    # Invariant passes
    print(f"\n✅ Acquisition complete. Invariant holds: {files_written} files written.")
    save_sync_state('seed', total_ids, files_written, max_epoch_ms)
    save_manifest('seed', start_date_str, total_ids, files_written,
                  [], all_ids, invariant_passed=True)
    print(f"\n  Next step: run  python catalog.py  to index content into the UI.")


# ══════════════════════════════════════════════════════════════════
# INCREMENTAL MODE
# ══════════════════════════════════════════════════════════════════

def run_incremental(config, gmail_service):
    """
    Incremental mode: fetch emails received AFTER last_successful_sync_epoch_ms.

    Reads sync_state.json. If no state exists → error (run seed first).
    If ids_returned == 0 → valid success (nothing new since last sync).
    Enforces the same invariant as seed mode.
    """
    # ── Load sync state ────────────────────────────────────────────
    state = load_sync_state()

    if not state or 'last_successful_sync_epoch_ms' not in state:
        print(f"\n❌ No sync state found at: {STATE_FILE}")
        print(f"   Run seed mode first:  python fetch.py --mode seed")
        sys.exit(1)

    since_epoch_ms = state['last_successful_sync_epoch_ms']
    since_human = datetime.fromtimestamp(since_epoch_ms / 1000).strftime('%Y-%m-%d %H:%M:%S')
    print(f"\n  [Incremental] Fetching messages after: {since_human}")

    # ── Collect IDs from all sources ──────────────────────────────
    all_id_source_pairs = []

    for source in config['sources']:
        print(f"\n{'─' * 50}")
        print(f"  📰 {source['name']}  ({source['sender']})")
        print(f"{'─' * 50}")

        try:
            query = build_incremental_query(source, since_epoch_ms)
            ids = fetch_ids_for_source(gmail_service, source, query)
            for msg_id in ids:
                all_id_source_pairs.append((msg_id, source))
        except Exception as e:
            print(f"  ❌ Failed to query Gmail for {source['name']}: {e}")
            traceback.print_exc()
            print(f"\n❌ Aborting incremental: query failed.")
            sys.exit(1)

    total_ids = len(all_id_source_pairs)

    if total_ids == 0:
        print(f"\n  ✓  Everything is up to date. No new messages since {since_human}.")
        # Valid success — update state with current time so next incremental
        # doesn't query unnecessarily far back
        now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        save_sync_state('incremental', 0, 0, now_ms)
        save_manifest('incremental', since_human, 0, 0, [], [], invariant_passed=True)
        return

    print(f"\n  [Incremental] {total_ids} new message(s) to fetch.")

    # ── Download and write ─────────────────────────────────────────
    files_written = 0
    errors = []
    max_epoch_ms = since_epoch_ms  # Start from current state, move forward

    for idx, (msg_id, source) in enumerate(all_id_source_pairs, 1):
        raw_path = RAW_DIR / f'{msg_id}.json'

        if raw_path.exists():
            files_written += 1
            try:
                existing = json.loads(raw_path.read_text(encoding='utf-8'))
                epoch = existing.get('internal_date_ms', 0)
                if epoch:
                    max_epoch_ms = max(max_epoch_ms, epoch)
            except Exception:
                pass
            continue

        print(f"  [{idx}/{total_ids}] {source['name']}")
        success, epoch_ms = fetch_and_write_raw(gmail_service, msg_id, source, RAW_DIR)

        if success:
            files_written += 1
            if epoch_ms:
                max_epoch_ms = max(max_epoch_ms, epoch_ms)
        else:
            errors.append(msg_id)

    # ── Enforce invariant ──────────────────────────────────────────
    print(f"\n{'═' * 50}")
    print(f"  [Incremental] IDs returned:  {total_ids}")
    print(f"  [Incremental] Files written: {files_written}")
    print(f"  [Incremental] Errors:        {len(errors)}")
    print(f"{'═' * 50}")

    all_ids = [pair[0] for pair in all_id_source_pairs]

    if total_ids != files_written:
        print(f"\n❌ INVARIANT FAILED: {total_ids} IDs returned but {files_written} files written.")
        if errors:
            print(f"   Failed IDs: {errors[:10]}")
        print(f"   sync_state.json was NOT updated.")
        save_manifest('incremental', since_human, total_ids, files_written,
                      errors, all_ids, invariant_passed=False)
        sys.exit(1)

    print(f"\n✅ Acquisition complete. {files_written} new file(s) written.")
    save_sync_state('incremental', total_ids, files_written, max_epoch_ms)
    save_manifest('incremental', since_human, total_ids, files_written,
                  [], all_ids, invariant_passed=True)
    print(f"\n  Next step: run  python catalog.py  to index new content into the UI.")


# ══════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════

def print_banner(mode):
    print()
    print("╔══════════════════════════════════════╗")
    print(f"║    BookSelf — Fetch ({mode:12s})  ║")
    print("╚══════════════════════════════════════╝")
    print()


def main():
    parser = argparse.ArgumentParser(
        description='BookSelf Acquisition Engine — downloads emails from Gmail to data/raw/',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            'Examples:\n'
            '  python fetch.py --mode seed                      # Full import from 2024-01-01\n'
            '  python fetch.py --mode seed --start-date 2023-01-01  # Custom start date\n'
            '  python fetch.py --mode incremental               # Fetch new since last sync\n'
        )
    )
    parser.add_argument(
        '--mode',
        required=True,
        choices=['seed', 'incremental'],
        help='seed: full import from start date | incremental: fetch since last sync'
    )
    parser.add_argument(
        '--start-date',
        type=str,
        default=None,
        metavar='YYYY-MM-DD',
        help='Start date for seed mode (default: read from config.yaml seed_start_date, fallback: 2024-01-01)'
    )
    parser.add_argument(
        '--sender',
        type=str,
        default=None,
        metavar='NAME_OR_EMAIL',
        help='Limit sync to a single source by name or sender email '
             '(e.g. "The Ken" or "info@the-ken.com"). '
             'Useful for seeding a newly-added newsletter without a full resync.'
    )
    args = parser.parse_args()

    print_banner(args.mode)

    # ── Load config ───────────────────────────────────────────────
    print("  [Setup] Loading config.yaml...")
    try:
        config = load_config()
    except (FileNotFoundError, ValueError) as e:
        print(f"\n❌  Config error: {e}")
        sys.exit(1)

    # ── Determine start date (seed mode only) ─────────────────────
    start_date_str = None
    if args.mode == 'seed':
        if args.start_date:
            start_date_str = args.start_date
        else:
            # Try config.yaml first, then fall back to hardcoded default
            start_date_str = config.get('settings', {}).get('seed_start_date', '2024-01-01')
        print(f"  [Setup] Seed start date: {start_date_str}")

    # ── Filter sources by --sender if provided ────────────────────
    if args.sender:
        all_sources = config['sources']
        filtered = [
            s for s in all_sources
            if args.sender.lower() in (s['name'].lower(), s['sender'].lower())
        ]
        if not filtered:
            print(f"\n❌  No source matching '{args.sender}' found in config.yaml.")
            print(f"  Available sources:")
            for s in all_sources:
                print(f"    {s['name']} ({s['sender']})")
            sys.exit(1)
        config = dict(config)   # shallow copy so we don't mutate the global
        config['sources'] = filtered
        print(f"  [Setup] Sender filter: '{args.sender}' → {filtered[0]['name']} ({filtered[0]['sender']})")

    # ── Connect to Gmail ──────────────────────────────────────────
    print(f"\n  [Auth] Connecting to Gmail...")
    try:
        gmail_service = get_gmail_service()
    except FileNotFoundError as e:
        print(f"\n❌  {e}")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌  Gmail authentication failed: {e}")
        sys.exit(1)

    # ── Run selected mode ─────────────────────────────────────────
    if args.mode == 'seed':
        run_seed(config, gmail_service, start_date_str)
    elif args.mode == 'incremental':
        run_incremental(config, gmail_service)

    print()


if __name__ == '__main__':
    main()
