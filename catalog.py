#!/usr/bin/env python3
# ─────────────────────────────────────────────────────────────────
# bookself/catalog.py  —  CATALOGING ENGINE
#
# Reads raw acquisition files from data/raw/ and indexes them into:
#   - newsletters/<publication>/<series>/<date>.html  (readable files)
#   - bookself.db  (SQLite index for the UI to query)
#
# This is the second stage of the pipeline. Run it AFTER fetch.py:
#   python fetch.py --mode seed        ← Step 1: download raw files
#   python catalog.py                  ← Step 2: index into UI
#
# Safe to re-run: already-cataloged messages (by gmail_message_id in
# the database) are skipped. New raw files are processed and added.
#
# This script does NOT talk to Gmail — it only reads from data/raw/.
# Exception: it needs the Gmail service for downloading large image
# attachments that are stored separately from the email body.
# ─────────────────────────────────────────────────────────────────

import sys
import json
import shutil
import sqlite3
import traceback
from datetime import datetime
from pathlib import Path

# ── Import BookSelf modules ───────────────────────────────────────
sys.path.insert(0, str(Path(__file__).parent))

import argparse

from bookself.config_loader import (
    load_config, get_db_path, get_newsletters_dir, get_assets_dir, get_project_root
)

# Frozen-aware: repo folder in dev; ~/Library/Application Support/BookSelf
# in the packaged app. Never derive data paths from __file__ — inside the
# .app that resolves into the bundle and cataloging breaks.
PROJECT_ROOT = get_project_root()
from bookself.database import (
    init_db, newsletter_exists, insert_newsletter, update_fts, get_total_count,
    purge_before_date
)
from bookself.gmail_client import get_gmail_service
from bookself.email_parser import detect_series, clean_html, extract_plain_text, count_words
from bookself.storage import extract_and_save_images, build_file_path, save_html_file


# ── Paths ─────────────────────────────────────────────────────────
DATA_DIR       = PROJECT_ROOT / 'data'
RAW_DIR        = DATA_DIR / 'raw'
STATE_DIR      = DATA_DIR / 'state'
USER_DATA_PATH = STATE_DIR / 'user_data.json'


# ══════════════════════════════════════════════════════════════════
# HELPERS
# ══════════════════════════════════════════════════════════════════

def _raw_file_matches_sender(raw_path, sender_lower):
    """Return True if this raw JSON file belongs to the given sender (name or email)."""
    try:
        data = json.loads(raw_path.read_text(encoding='utf-8'))
        name   = data.get('source_name',   '').lower()
        email  = data.get('source_sender', '').lower()
        return sender_lower in (name, email)
    except Exception:
        return False


# ══════════════════════════════════════════════════════════════════
# USER DATA PERSISTENCE (notes + read flags survive purge/seed)
# ══════════════════════════════════════════════════════════════════

def _load_user_data():
    """Load existing user_data.json or return empty dict."""
    if USER_DATA_PATH.exists():
        try:
            return json.loads(USER_DATA_PATH.read_text(encoding='utf-8'))
        except Exception:
            return {}
    return {}


def _save_user_data(data):
    """Write user_data.json atomically."""
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    USER_DATA_PATH.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding='utf-8')


def backup_user_data_before_purge(db_path, newsletters_dir):
    """
    Called immediately before full-purge deletes the DB and newsletters/.
    Snapshots:
      - gmail_message_id → is_read (from DB)
      - gmail_message_id → {notes_path, notes_content} (from .notes.md files)
    Merges with any existing user_data.json so repeated purges don't lose data.
    """
    existing = _load_user_data()

    # 1. Collect is_read flags from DB
    if db_path.exists():
        try:
            con = sqlite3.connect(db_path)
            rows = con.execute(
                'SELECT gmail_message_id, is_read, file_path FROM newsletters'
            ).fetchall()
            con.close()
            for msg_id, is_read, file_path in rows:
                entry = existing.setdefault(msg_id, {})
                # Only update is_read if it was actually marked (don't demote a 1→0)
                if is_read:
                    entry['is_read'] = 1
                elif 'is_read' not in entry:
                    entry['is_read'] = 0
                entry['file_path'] = file_path
        except Exception as e:
            print(f"  [UserData] Warning: could not read DB is_read flags: {e}")

    # 2. Collect .notes.md files from newsletters/
    if newsletters_dir.exists():
        for notes_file in newsletters_dir.rglob('*.notes.md'):
            try:
                content = notes_file.read_text(encoding='utf-8').strip()
                if not content:
                    continue
                # Find the matching DB entry by file_path
                rel_html = str(notes_file.with_suffix('.html').relative_to(PROJECT_ROOT))
                # Find which msg_id maps to this file_path
                matching_id = next(
                    (mid for mid, d in existing.items() if d.get('file_path') == rel_html),
                    None
                )
                if matching_id:
                    existing[matching_id]['notes_content'] = content
                    existing[matching_id]['notes_rel_path'] = str(
                        notes_file.relative_to(PROJECT_ROOT)
                    )
            except Exception:
                pass

    _save_user_data(existing)
    n_read  = sum(1 for d in existing.values() if d.get('is_read'))
    n_notes = sum(1 for d in existing.values() if d.get('notes_content'))
    print(f"  [UserData] Backed up {n_read} read flags, {n_notes} notes → {USER_DATA_PATH}")


def restore_user_data_after_rebuild(db_path):
    """
    Called after full-purge + catalog rebuild completes.
    Re-applies is_read flags to the freshly-built DB.
    Re-creates .notes.md files at their correct paths (looked up via gmail_message_id).
    """
    data = _load_user_data()
    if not data:
        return

    restored_read  = 0
    restored_notes = 0

    try:
        con = sqlite3.connect(db_path)
        # Build a mapping: gmail_message_id → new file_path (post-rebuild)
        rows = con.execute(
            'SELECT gmail_message_id, id, file_path FROM newsletters'
        ).fetchall()
        id_map       = {r[0]: r[1] for r in rows}   # msg_id → db id
        filepath_map = {r[0]: r[2] for r in rows}   # msg_id → file_path

        for msg_id, entry in data.items():
            if msg_id not in id_map:
                continue  # Article not in rebuilt DB (e.g. pre-start-date)

            # Restore is_read
            if entry.get('is_read'):
                con.execute(
                    'UPDATE newsletters SET is_read = 1 WHERE gmail_message_id = ?',
                    (msg_id,)
                )
                restored_read += 1

            # Restore notes
            if entry.get('notes_content'):
                new_file_path = filepath_map[msg_id]
                notes_path = PROJECT_ROOT / new_file_path
                notes_path = notes_path.with_suffix('.notes.md')
                notes_path.parent.mkdir(parents=True, exist_ok=True)
                notes_path.write_text(entry['notes_content'], encoding='utf-8')
                restored_notes += 1

        con.commit()
        con.close()
    except Exception as e:
        print(f"  [UserData] Warning: restore error: {e}")

    print(f"  [UserData] Restored {restored_read} read flags, {restored_notes} notes.")


# ══════════════════════════════════════════════════════════════════
# SOURCE LOOKUP
# ══════════════════════════════════════════════════════════════════

def find_source_config(source_name, sources):
    """
    Find the config entry for a source by its name.
    Returns the source dict, or None if not found.
    """
    for s in sources:
        if s['name'] == source_name:
            return s
    return None


# ══════════════════════════════════════════════════════════════════
# CATALOGING — one raw file at a time
# ══════════════════════════════════════════════════════════════════

def catalog_one(raw_data, source_config, db_path, newsletters_dir, assets_dir, gmail_service):
    """
    Process one raw acquisition file and add it to the library.

    Takes the parsed JSON from data/raw/<id>.json, runs it through
    the full cataloging pipeline: series detection, HTML cleaning,
    image extraction, file saving, database insert, FTS indexing.

    Returns:
        str: 'cataloged' | 'skipped' | 'no_html' | 'error'
    """
    message_id  = raw_data['message_id']
    source_type = source_config.get('type', 'simple')
    html        = raw_data.get('html')

    # ── Skip if no HTML is available ──────────────────────────────
    # We can't display a newsletter without its HTML body.
    # These are acquisition stubs saved when extraction failed.
    if not raw_data.get('html_available') or not html:
        print(f"    ⚠️  Skipping {message_id[:12]}… — no HTML content (acquisition stub)")
        return 'no_html'

    # ── Build a parsed record compatible with existing processors ──
    parsed = {
        'gmail_message_id': message_id,
        'subject': raw_data.get('subject', '(no subject)'),
        'sender_name': raw_data.get('sender_name', source_config['name']),
        'date_str': raw_data.get('date_str', datetime.now().strftime('%Y-%m-%d')),
        'html': html,
        'attachments': []  # Inline attachments were not saved in raw format;
                           # external images will be fetched during clean_html
    }

    try:
        if source_type == 'simple':
            return _catalog_simple(
                parsed, source_config, db_path,
                newsletters_dir, assets_dir, gmail_service
            )
        elif source_type == 'series':
            return _catalog_series(
                parsed, source_config, db_path,
                newsletters_dir, assets_dir, gmail_service
            )
        else:
            print(f"    ⚠️  Unknown source type '{source_type}' — skipping")
            return 'error'

    except Exception as e:
        print(f"    ❌ Error cataloging {message_id[:12]}…: {e}")
        traceback.print_exc()
        return 'error'


def _catalog_simple(parsed, source, db_path, newsletters_dir, assets_dir, gmail_service):
    """
    Catalog a 'type: simple' newsletter (flat, no sub-series).
    Examples: Finshots, FinBox, Jeff Su.
    """
    full_path, relative_path = build_file_path(
        newsletters_dir=newsletters_dir,
        publication_folder=source['folder'],
        series_folder=None,
        date_str=parsed['date_str']
    )

    # Extract and save images (rewrites src attrs to local paths)
    img_url_map = _extract_images_safe(
        parsed['html'], assets_dir, source['folder'],
        gmail_service, parsed['gmail_message_id'], parsed['attachments']
    )

    cleaned_html = clean_html(parsed['html'], img_url_map)
    save_html_file(cleaned_html, full_path)

    plain_text = extract_plain_text(cleaned_html)
    word_count = count_words(cleaned_html)

    record = {
        'gmail_message_id': parsed['gmail_message_id'],
        'publication': source['name'],
        'series': None,
        'title': parsed['subject'],
        'author': parsed['sender_name'],
        'date_received': parsed['date_str'],
        'file_path': relative_path,
        'word_count': word_count,
        'has_images': 1 if img_url_map else 0,
        'is_preview': 0,
        'preview_label': None,
        'fetched_at': datetime.now().isoformat()
    }

    new_id = insert_newsletter(db_path, record)
    if new_id == 0:
        # INSERT OR IGNORE fired — row already existed; nothing to do
        print(f"    ⏭️  {parsed['date_str']} | already in DB — skipped")
        return 'skipped'
    update_fts(db_path, new_id, plain_text)

    print(f"    ✅ {parsed['date_str']} | {parsed['subject'][:60]}")
    return 'cataloged'


def _catalog_series(parsed, source, db_path, newsletters_dir, assets_dir, gmail_service):
    """
    Catalog a 'type: series' newsletter (multiple named series per publication).
    Example: The Ken — Ka-Ching, 90,000 Hours, Long and Short, etc.
    """
    # Detect which series this email belongs to (subject checked first)
    series_name, series_folder = detect_series(
        parsed['html'], source, subject=parsed.get('subject')
    )

    # Determine paid preview status
    is_preview = 0
    preview_label = None
    paid_config = source.get('paid_preview_detection', {})
    if paid_config and series_folder == paid_config.get('folder', 'paid-articles'):
        is_preview = 1
        preview_label = paid_config.get('label', 'Preview only')

    full_path, relative_path = build_file_path(
        newsletters_dir=newsletters_dir,
        publication_folder=source['folder'],
        series_folder=series_folder,
        date_str=parsed['date_str']
    )

    img_url_map = _extract_images_safe(
        parsed['html'], assets_dir, source['folder'],
        gmail_service, parsed['gmail_message_id'], parsed['attachments']
    )

    cleaned_html = clean_html(parsed['html'], img_url_map)
    save_html_file(cleaned_html, full_path)

    plain_text = extract_plain_text(cleaned_html)
    word_count = count_words(cleaned_html)

    db_series = None if series_folder == 'unsorted' else series_name

    record = {
        'gmail_message_id': parsed['gmail_message_id'],
        'publication': source['name'],
        'series': db_series,
        'title': parsed['subject'],
        'author': parsed['sender_name'],
        'date_received': parsed['date_str'],
        'file_path': relative_path,
        'word_count': word_count,
        'has_images': 1 if img_url_map else 0,
        'is_preview': is_preview,
        'preview_label': preview_label,
        'fetched_at': datetime.now().isoformat()
    }

    new_id = insert_newsletter(db_path, record)
    if new_id == 0:
        # INSERT OR IGNORE fired — row already existed; nothing to do
        print(f"    ⏭️  {parsed['date_str']} | already in DB — skipped")
        return 'skipped'
    update_fts(db_path, new_id, plain_text)

    series_label = series_name if series_name else 'unsorted'
    preview_note = ' [preview]' if is_preview else ''
    print(f"    ✅ {parsed['date_str']} | {series_label}{preview_note} | {parsed['subject'][:50]}")
    return 'cataloged'


def _extract_images_safe(html, assets_dir, publication_folder, gmail_service, message_id, attachments):
    """
    Run image extraction, returning an empty map on any failure.
    Image extraction is optional — a missing image is cosmetic, not
    a reason to fail cataloging.
    """
    try:
        return extract_and_save_images(
            html_content=html,
            assets_dir=assets_dir,
            publication_folder=publication_folder,
            gmail_service=gmail_service,
            message_id=message_id,
            attachments=attachments
        )
    except Exception as e:
        print(f"      ⚠️  Image extraction failed (non-fatal): {e}")
        return {}


# ══════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════

def run_audit(config, raw_dir):
    """
    Dry-run classification report. Scans all raw files, runs series detection,
    and prints per-source / per-series counts WITHOUT writing anything to disk
    or the database. Useful for validating config.yaml changes before a full
    re-catalog.

    Prints sample subjects for any 'unsorted' emails so you can spot missing
    series name entries.
    """
    print()
    print("╔══════════════════════════════════════╗")
    print("║       BookSelf — Audit Mode          ║")
    print("╚══════════════════════════════════════╝")
    print("  (Dry run — nothing written to DB or disk)")
    print()

    sources = config.get('sources', [])
    raw_files = sorted(raw_dir.glob('*.json'))
    total_files = len(raw_files)
    print(f"  Found {total_files} raw files to classify.\n")

    # report[source_name][series_or_flat] = [subject, ...]
    report = {}

    for raw_path in raw_files:
        try:
            raw_data = json.loads(raw_path.read_text(encoding='utf-8'))
        except Exception:
            continue

        source_name   = raw_data.get('source_name', '(unknown)')
        source_config = find_source_config(source_name, sources)
        if not source_config:
            continue

        subject = raw_data.get('subject', '')
        html    = raw_data.get('html', '')

        if source_config.get('type') == 'series':
            series_name, _ = detect_series(html, source_config, subject=subject)
        else:
            series_name = '(flat — no series)'

        report.setdefault(source_name, {}).setdefault(series_name, []).append(subject)

    # ── Print report ──────────────────────────────────────────────
    for source_name in sorted(report):
        series_data = report[source_name]
        total = sum(len(v) for v in series_data.values())
        print(f"  ── {source_name}  ({total} emails) ──")
        for series_name, subjects in sorted(series_data.items(), key=lambda x: -len(x[1])):
            print(f"      {series_name:<38} {len(subjects):>4}")
            if series_name == 'unsorted' and subjects:
                print(f"      (sample subjects of unsorted emails:)")
                for subj in subjects[:8]:
                    print(f"        · {subj[:80]}")
        print()

    print("  Audit complete. No files written.")
    print()


def main():
    # ── CLI args ──────────────────────────────────────────────────
    parser = argparse.ArgumentParser(description='BookSelf cataloging engine')
    parser.add_argument(
        '--start-date',
        default=None,
        metavar='YYYY-MM-DD',
        help='Only catalog emails on/after this date. '
             'Purges any existing DB entries before this date. '
             'Used automatically by seed sync.'
    )
    parser.add_argument(
        '--audit',
        action='store_true',
        help='Dry-run: classify all raw files and print per-series counts. '
             'Nothing is written to the database or disk.'
    )
    parser.add_argument(
        '--full-purge',
        action='store_true',
        help='Delete ALL existing DB records and HTML/image files, then '
             're-catalog everything from raw data. '
             'Safe: data/raw/ (source of truth) is never touched. '
             'Use after changing config.yaml or detection logic.'
    )
    parser.add_argument(
        '--wipe-user-data',
        action='store_true',
        help='During --full-purge: also delete all user notes and read flags. '
             'By default, notes and read flags are preserved across purges. '
             'This flag opts in to a complete reset. Cannot be undone.'
    )
    parser.add_argument(
        '--sender',
        type=str,
        default=None,
        metavar='NAME_OR_EMAIL',
        help='Only catalog raw files from this sender (name or email). '
             'Used with per-sender seed sync to avoid re-processing the full library.'
    )
    args = parser.parse_args()
    start_date = args.start_date  # e.g. "2024-01-01" or None

    print()
    print("╔══════════════════════════════════════╗")
    print("║       BookSelf — Cataloging          ║")
    print("╚══════════════════════════════════════╝")
    print()
    if start_date:
        print(f"  [Setup] Start date filter: {start_date} (seed mode cleanup enabled)")

    # ── Sanity check ──────────────────────────────────────────────
    if not RAW_DIR.exists() or not list(RAW_DIR.glob('*.json')):
        print(f"  ℹ️  No raw files found in {RAW_DIR}")
        print(f"  Run  python fetch.py --mode seed  first.")
        sys.exit(0)

    # ── Load config ───────────────────────────────────────────────
    print("  [Setup] Loading config.yaml...")
    try:
        config = load_config()
    except (FileNotFoundError, ValueError) as e:
        print(f"\n❌  Config error: {e}")
        sys.exit(1)

    db_path         = get_db_path(config)
    newsletters_dir = get_newsletters_dir(config)
    assets_dir      = get_assets_dir(config)

    # ── Audit mode: dry-run classification, then exit ─────────────
    if args.audit:
        run_audit(config, RAW_DIR)
        sys.exit(0)

    newsletters_dir.mkdir(parents=True, exist_ok=True)
    assets_dir.mkdir(parents=True, exist_ok=True)

    print(f"  [Setup] Database: {db_path}")
    print(f"  [Setup] Newsletters: {newsletters_dir}")

    # ── Full-purge mode: wipe DB + HTML/image files ───────────────
    if args.full_purge:
        print(f"\n  [Full Purge] Deleting all cataloged data...")
        print(f"  NOTE: data/raw/ is NOT touched — it is the source of truth.\n")

        if args.wipe_user_data:
            print(f"  [Full Purge] --wipe-user-data set: notes and read flags will NOT be preserved.")
            if USER_DATA_PATH.exists():
                USER_DATA_PATH.unlink()
                print(f"  [Full Purge] Deleted user_data.json")
        else:
            # Snapshot notes + read flags BEFORE deleting anything
            print(f"  [Full Purge] Saving user notes and read flags before purge...")
            backup_user_data_before_purge(db_path, newsletters_dir)

        if db_path.exists():
            db_path.unlink()
            print(f"  [Full Purge] Deleted database: {db_path.name}")
        if newsletters_dir.exists():
            shutil.rmtree(newsletters_dir)
            print(f"  [Full Purge] Deleted newsletters/ folder")
        if assets_dir.exists():
            shutil.rmtree(assets_dir)
            print(f"  [Full Purge] Deleted assets/ folder")
        newsletters_dir.mkdir(parents=True)
        assets_dir.mkdir(parents=True)
        print(f"  [Full Purge] Done. Re-cataloging from scratch...\n")

    # ── Init database ─────────────────────────────────────────────
    print(f"  [DB] Initializing...")
    init_db(db_path)

    # ── Seed-mode cleanup: remove pre-start-date entries ──────────
    # When running a seed sync we want a clean slate for old data.
    # Delete DB entries before start_date and remove their HTML files.
    if start_date:
        print(f"\n  [Cleanup] Purging newsletters before {start_date}...")
        deleted_paths = purge_before_date(db_path, start_date)
        removed_files = 0
        for rel_path in deleted_paths:
            full_path = PROJECT_ROOT / rel_path
            try:
                if full_path.exists():
                    full_path.unlink()
                    removed_files += 1
            except Exception:
                pass  # Non-fatal — DB entry is already gone
        print(f"  [Cleanup] Removed {len(deleted_paths)} DB entries, "
              f"{removed_files} HTML files before {start_date}.")

    # ── Connect to Gmail (for image attachment downloads) ─────────
    print(f"\n  [Auth] Connecting to Gmail (needed for image attachments)...")
    try:
        gmail_service = get_gmail_service()
    except FileNotFoundError as e:
        print(f"\n❌  {e}")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌  Gmail authentication failed: {e}")
        sys.exit(1)

    # ── Process all raw files ─────────────────────────────────────
    raw_files = sorted(RAW_DIR.glob('*.json'))

    # Per-sender filter: only process files from the requested sender
    if args.sender:
        sender_lower = args.sender.lower()
        raw_files = [
            f for f in raw_files
            if _raw_file_matches_sender(f, sender_lower)
        ]
        print(f"\n  [Catalog] Sender filter: '{args.sender}' → {len(raw_files)} matching file(s).")

    total_files = len(raw_files)
    print(f"\n  [Catalog] Found {total_files} raw file(s) to process.")
    print()

    cataloged     = 0
    skipped_db    = 0   # newsletter_exists() returned True (DB pre-check)
    skipped_date  = 0   # date_str < start_date (pre-filter)
    skipped_dup   = 0   # INSERT OR IGNORE fired (graceful duplicate)
    no_html       = 0   # acquisition stubs with no HTML
    errors        = 0
    sources       = config.get('sources', [])

    for idx, raw_path in enumerate(raw_files, 1):
        try:
            raw_data = json.loads(raw_path.read_text(encoding='utf-8'))
        except Exception as e:
            print(f"  [{idx}/{total_files}] ❌ Could not read {raw_path.name}: {e}")
            errors += 1
            continue

        message_id = raw_data.get('message_id', raw_path.stem)

        # ── Date pre-filter: skip if before start_date ─────────────
        if start_date and raw_data.get('date_str', '') < start_date:
            skipped_date += 1
            continue

        # ── Skip if already in the database (fast pre-check) ───────
        if newsletter_exists(db_path, message_id):
            skipped_db += 1
            continue

        # ── Find the source config for this message ─────────────────
        source_name   = raw_data.get('source_name', '')
        source_config = find_source_config(source_name, sources)

        if not source_config:
            print(f"  [{idx}/{total_files}] ⚠️  Unknown source '{source_name}' — skipping {message_id[:12]}…")
            errors += 1
            continue

        print(f"  [{idx}/{total_files}] {source_name}")

        result = catalog_one(
            raw_data, source_config, db_path,
            newsletters_dir, assets_dir, gmail_service
        )

        if result == 'cataloged':
            cataloged += 1
        elif result == 'skipped':
            skipped_dup += 1
        elif result == 'no_html':
            no_html += 1
        else:
            errors += 1

    # ── Restore user data after full-purge rebuild ────────────────
    if args.full_purge and not args.wipe_user_data:
        print(f"\n  [UserData] Restoring notes and read flags...")
        restore_user_data_after_rebuild(db_path)

    # ── Summary ───────────────────────────────────────────────────
    total_in_db = get_total_count(db_path)
    total_skipped = skipped_db + skipped_date + skipped_dup

    print(f"\n{'═' * 50}")
    print(f"  Cataloging complete")
    print(f"  ✅ Newly cataloged: {cataloged}")
    print(f"  ⏭️  Skipped:        {total_skipped}  "
          f"(DB: {skipped_db}, date filter: {skipped_date}, dup: {skipped_dup})")
    print(f"  ⚠️  No HTML:        {no_html}")
    print(f"  ❌ Errors:          {errors}")
    print(f"  📚 Library total:   {total_in_db}")
    print(f"{'═' * 50}")
    print()


if __name__ == '__main__':
    main()
