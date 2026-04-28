# ─────────────────────────────────────────────────────────────────
# bookself/database.py
#
# All SQLite database operations for BookSelf.
#
# Think of the database as the INDEX of your newsletter library.
# The actual content lives in the newsletters/ HTML files on disk.
# If the database gets corrupted or deleted, just run fetch.py
# again and it will be rebuilt from your emails.
#
# Tables:
#   newsletters     — main catalog: one row per newsletter issue
#   newsletters_fts — virtual full-text search index (SQLite FTS5)
# ─────────────────────────────────────────────────────────────────

import sqlite3
from pathlib import Path


def get_connection(db_path):
    """
    Open a connection to the SQLite database.

    sqlite3.Row makes rows behave like dictionaries, so you can
    access columns by name: row['title'] instead of row[3].

    WAL mode: allows concurrent readers + one writer without blocking.
    This is critical because catalog.py writes while Flask serves reads.
    busy_timeout: SQLite waits up to 5s for a lock instead of crashing.

    Args:
        db_path: Path object or string pointing to the .db file

    Returns:
        sqlite3.Connection
    """
    conn = sqlite3.connect(str(db_path), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def init_db(db_path):
    """
    Create all database tables and indexes if they don't exist yet.

    Safe to call multiple times — uses CREATE IF NOT EXISTS so it
    won't overwrite or reset existing data.

    Call this once at the start of fetch.py before doing anything else.
    """
    conn = get_connection(db_path)
    cursor = conn.cursor()

    # ── Main newsletters table ────────────────────────────────────
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS newsletters (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            gmail_message_id TEXT UNIQUE NOT NULL,  -- Gmail's unique message ID (prevents duplicates)
            publication      TEXT NOT NULL,          -- Display name, e.g. "The Ken"
            series           TEXT,                   -- Series name, e.g. "Ka-Ching!" (NULL for flat publications)
            title            TEXT NOT NULL,          -- Email subject line
            author           TEXT,                   -- Sender display name (not email address)
            date_received    TEXT NOT NULL,          -- ISO format: YYYY-MM-DD
            file_path        TEXT NOT NULL,          -- Path to saved HTML file, relative to project root
            word_count       INTEGER,                -- Approximate word count of the body text
            has_images       INTEGER DEFAULT 0,      -- 1 if images were saved locally, 0 if not
            is_preview       INTEGER DEFAULT 0,      -- 1 if this is a paid-preview-only email
            preview_label    TEXT,                   -- Message shown in UI for preview items
            fetched_at       TEXT NOT NULL,          -- ISO datetime when this was fetched
            is_read          INTEGER DEFAULT 0       -- 1 if the user has opened/read this newsletter
        )
    ''')

    # ── Full-text search virtual table ────────────────────────────
    # FTS5 is built into SQLite — no extra software needed.
    # It indexes title + full_text so you can search across all newsletters.
    # 'content=newsletters' means FTS5 links back to the main table.
    cursor.execute('''
        CREATE VIRTUAL TABLE IF NOT EXISTS newsletters_fts USING fts5(
            title,
            full_text,
            content=newsletters,
            content_rowid=id
        )
    ''')

    # ── Trigger: keep FTS index in sync with main table ──────────
    # When a new newsletter is inserted into the main table,
    # this trigger automatically adds it to the search index.
    # (full_text starts empty; update_fts() fills it in afterward)
    cursor.execute('''
        CREATE TRIGGER IF NOT EXISTS newsletters_ai
        AFTER INSERT ON newsletters BEGIN
            INSERT INTO newsletters_fts(rowid, title, full_text)
            VALUES (new.id, new.title, '');
        END
    ''')

    # Trigger: when a newsletter is deleted, remove it from search too
    cursor.execute('''
        CREATE TRIGGER IF NOT EXISTS newsletters_ad
        AFTER DELETE ON newsletters BEGIN
            INSERT INTO newsletters_fts(newsletters_fts, rowid, title, full_text)
            VALUES ('delete', old.id, old.title, '');
        END
    ''')

    # ── Backwards-compatible migration: add is_read if missing ───
    try:
        cursor.execute('ALTER TABLE newsletters ADD COLUMN is_read INTEGER DEFAULT 0')
        conn.commit()
        print("  [DB] Migration: added is_read column.")
    except sqlite3.OperationalError:
        pass  # column already exists

    # ── Migration: add read_at timestamp (when user marked it, not article date) ──
    try:
        cursor.execute('ALTER TABLE newsletters ADD COLUMN read_at TEXT')
        conn.commit()
        print("  [DB] Migration: added read_at column.")
    except sqlite3.OperationalError:
        pass  # column already exists

    conn.commit()
    conn.close()
    print("  [DB] Database initialized.")


def newsletter_exists(db_path, gmail_message_id):
    """
    Check if a newsletter has already been saved.

    This is the duplicate prevention check. Before downloading and
    processing an email, we check if it's already in the database.

    Returns:
        bool: True if we already have this email, False if it's new.
    """
    conn = get_connection(db_path)
    cursor = conn.cursor()
    cursor.execute(
        'SELECT 1 FROM newsletters WHERE gmail_message_id = ?',
        (gmail_message_id,)
    )
    result = cursor.fetchone()
    conn.close()
    return result is not None


def insert_newsletter(db_path, record):
    """
    Insert a new newsletter record into the database.

    Args:
        db_path: Path to the database file.
        record: dict with these keys:
            gmail_message_id, publication, series, title, author,
            date_received, file_path, word_count, has_images,
            is_preview, preview_label, fetched_at

    Returns:
        int: The auto-generated ID of the new record.
    """
    conn = get_connection(db_path)
    cursor = conn.cursor()

    cursor.execute('''
        INSERT OR IGNORE INTO newsletters
            (gmail_message_id, publication, series, title, author,
             date_received, file_path, word_count, has_images,
             is_preview, preview_label, fetched_at)
        VALUES
            (:gmail_message_id, :publication, :series, :title, :author,
             :date_received, :file_path, :word_count, :has_images,
             :is_preview, :preview_label, :fetched_at)
    ''', record)

    # cursor.rowcount is 1 on success, 0 when IGNORE triggered (row already existed)
    new_id = cursor.lastrowid if cursor.rowcount > 0 else 0
    conn.commit()
    conn.close()
    return new_id  # 0 = graceful skip (already in DB), >0 = newly inserted


def update_fts(db_path, newsletter_id, full_text):
    """
    Update the full-text search index for a newsletter.

    Called after the HTML file is saved to disk and we've extracted
    the plain text body. This is what makes the newsletter searchable.

    Args:
        db_path: Path to the database file.
        newsletter_id: The integer ID from the newsletters table.
        full_text: Plain text body extracted from the newsletter HTML.
    """
    conn = get_connection(db_path)
    cursor = conn.cursor()

    # FTS5 update sequence: delete the old (empty) entry, insert the new one with full text
    cursor.execute(
        "INSERT INTO newsletters_fts(newsletters_fts, rowid, title, full_text) "
        "VALUES ('delete', ?, ?, '')",
        (newsletter_id, '')
    )

    cursor.execute('SELECT title FROM newsletters WHERE id = ?', (newsletter_id,))
    row = cursor.fetchone()

    if row:
        cursor.execute(
            'INSERT INTO newsletters_fts(rowid, title, full_text) VALUES (?, ?, ?)',
            (newsletter_id, row['title'], full_text)
        )

    conn.commit()
    conn.close()


def get_all_publications(db_path):
    """
    Get a sorted list of all distinct publication names in the database.

    Used to build the left pane navigation tree.

    Returns:
        list of str: e.g. ["FinBox — The Pattern", "Finshots", "Jeff Su", "The Ken"]
    """
    conn = get_connection(db_path)
    cursor = conn.cursor()
    cursor.execute('SELECT DISTINCT publication FROM newsletters ORDER BY publication')
    results = [row['publication'] for row in cursor.fetchall()]
    conn.close()
    return results


def get_series_for_publication(db_path, publication):
    """
    Get all distinct series names for a given publication.

    For flat publications (Finshots, FinBox, Jeff Su), this returns
    an empty list — they have no series.

    Returns:
        list of str: e.g. ["Ka-Ching!", "Long and Short", "paid-articles"]
    """
    conn = get_connection(db_path)
    cursor = conn.cursor()
    cursor.execute(
        'SELECT DISTINCT series FROM newsletters '
        'WHERE publication = ? AND series IS NOT NULL '
        'ORDER BY series',
        (publication,)
    )
    results = [row['series'] for row in cursor.fetchall()]
    conn.close()
    return results


def get_newsletters(db_path, publication=None, series=None, limit=50, offset=0, sort='date_desc'):
    """
    Get a filtered, sorted list of newsletter records.

    Args:
        publication: Filter by publication name (optional).
        series: Filter by series name (optional). Use with publication.
        limit: Max records to return (default 50).
        offset: Skip this many records for pagination (default 0).
        sort: 'date_desc' (newest first), 'date_asc', or 'title_asc'.

    Returns:
        list of dicts: Each dict is one newsletter record.
    """
    conn = get_connection(db_path)
    cursor = conn.cursor()

    # Build query filters dynamically
    where_clauses = []
    params = []

    if publication:
        where_clauses.append('publication = ?')
        params.append(publication)

    if series is not None:
        where_clauses.append('series = ?')
        params.append(series)

    where_sql = ('WHERE ' + ' AND '.join(where_clauses)) if where_clauses else ''

    sort_options = {
        'date_desc': 'date_received DESC, id DESC',
        'date_asc': 'date_received ASC, id ASC',
        'title_asc': 'title ASC'
    }
    order_sql = sort_options.get(sort, 'date_received DESC, id DESC')

    params.extend([limit, offset])
    cursor.execute(
        f'SELECT * FROM newsletters {where_sql} ORDER BY {order_sql} LIMIT ? OFFSET ?',
        params
    )

    results = [dict(row) for row in cursor.fetchall()]
    conn.close()
    return results


def get_newsletter_by_id(db_path, newsletter_id):
    """
    Get a single newsletter record by its database ID.

    Returns:
        dict or None: The newsletter record, or None if not found.
    """
    conn = get_connection(db_path)
    cursor = conn.cursor()
    cursor.execute('SELECT * FROM newsletters WHERE id = ?', (newsletter_id,))
    row = cursor.fetchone()
    conn.close()
    return dict(row) if row else None


def toggle_read(db_path, newsletter_id):
    """
    Flip the is_read flag for a newsletter (0→1 or 1→0).

    Called when the user clicks the read-dot in the nav, or when
    a newsletter is opened for the first time (auto-mark as read).

    Args:
        db_path: Path to the database file.
        newsletter_id: The integer ID from the newsletters table.

    Returns:
        int: The NEW value of is_read (0 or 1).
    """
    conn = get_connection(db_path)
    cursor = conn.cursor()

    # Read current value first
    cursor.execute('SELECT is_read FROM newsletters WHERE id = ?', (newsletter_id,))
    row = cursor.fetchone()
    if not row:
        conn.close()
        return 0

    new_value = 0 if row['is_read'] else 1
    if new_value == 1:
        # Record the exact moment the user marked it done — NOT the article publish date
        cursor.execute(
            "UPDATE newsletters SET is_read = 1, read_at = datetime('now') WHERE id = ?",
            (newsletter_id,)
        )
    else:
        # User un-marked it — wipe the timestamp so stats don't count it
        cursor.execute(
            'UPDATE newsletters SET is_read = 0, read_at = NULL WHERE id = ?',
            (newsletter_id,)
        )
    conn.commit()
    conn.close()
    return new_value


def search_newsletters(db_path, query):
    """
    Full-text search across newsletter titles and body text.

    Uses SQLite FTS5 — fast, built-in, no external search engine.
    Multiple words are combined with AND logic (all words must appear).

    Args:
        query: Search string, e.g. "inflation india rbi"

    Returns:
        list of dicts: Matching newsletter records, newest first.
    """
    conn = get_connection(db_path)
    cursor = conn.cursor()

    # Join multiple words with AND so all must match
    words = query.strip().split()
    if not words:
        conn.close()
        return []

    fts_query = ' AND '.join(f'"{w}"' for w in words)

    try:
        cursor.execute('''
            SELECT n.* FROM newsletters n
            JOIN newsletters_fts fts ON n.id = fts.rowid
            WHERE newsletters_fts MATCH ?
            ORDER BY n.date_received DESC
            LIMIT 200
        ''', (fts_query,))
        results = [dict(row) for row in cursor.fetchall()]
    except sqlite3.OperationalError:
        # FTS query syntax error (e.g. special characters) — return empty
        results = []

    conn.close()
    return results


def get_recent_for_publication(db_path, publication, limit=8):
    """
    Get the most recent newsletters from a publication.
    Used for Publication Overview cards in the right pane.
    """
    return get_newsletters(db_path, publication=publication, limit=limit, sort='date_desc')


def get_recent_for_series(db_path, publication, series, limit=8):
    """
    Get the most recent newsletters from a specific series.
    Used for Series Overview cards in the right pane.
    """
    return get_newsletters(db_path, publication=publication, series=series, limit=limit, sort='date_desc')


def get_total_count(db_path):
    """
    Get the total number of newsletters stored in the database.
    Used in the empty-state message: "You have X newsletters."

    Returns:
        int
    """
    conn = get_connection(db_path)
    cursor = conn.cursor()
    cursor.execute('SELECT COUNT(*) as count FROM newsletters')
    row = cursor.fetchone()
    conn.close()
    return row['count'] if row else 0


def get_source_count(db_path, publication_name):
    """
    Get the number of newsletters stored for a specific publication.

    Used by fetch.py to detect if a source is brand-new (0 newsletters)
    and needs a full historical import even when other sources already exist.

    Returns:
        int: 0 if this source has never been imported, N otherwise.
    """
    conn = get_connection(db_path)
    cursor = conn.cursor()
    cursor.execute(
        'SELECT COUNT(*) as count FROM newsletters WHERE publication = ?',
        (publication_name,)
    )
    row = cursor.fetchone()
    conn.close()
    return row['count'] if row else 0


def get_last_fetched_at(db_path):
    """
    Get the timestamp of the most recent fetch operation.
    Shown in the Settings panel as "Last synced: ..."

    Returns:
        str or None: ISO datetime string, or None if never synced.
    """
    conn = get_connection(db_path)
    cursor = conn.cursor()
    cursor.execute('SELECT MAX(fetched_at) as last_fetch FROM newsletters')
    row = cursor.fetchone()
    conn.close()
    return row['last_fetch'] if row else None


def purge_before_date(db_path, date_str):
    """
    Delete all newsletters with date_received < date_str from the database.

    Used by seed mode to clean up pre-start-date entries before re-cataloging.
    Returns the list of relative file_paths for deleted records so the caller
    can also remove the HTML files from disk.

    Args:
        db_path: Path to the database file.
        date_str: ISO date string, e.g. "2024-01-01". All records
                  with date_received strictly BEFORE this date are deleted.

    Returns:
        list of str: relative file_path values for every deleted record.
    """
    conn = get_connection(db_path)
    cursor = conn.cursor()

    # Collect the file paths so caller can delete the HTML files too
    cursor.execute(
        'SELECT file_path FROM newsletters WHERE date_received < ?',
        (date_str,)
    )
    paths = [row['file_path'] for row in cursor.fetchall()]

    cursor.execute(
        'DELETE FROM newsletters WHERE date_received < ?',
        (date_str,)
    )
    deleted_count = cursor.rowcount
    conn.commit()
    conn.close()

    return paths
