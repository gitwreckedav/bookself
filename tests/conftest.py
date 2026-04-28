"""
BookSelf test configuration.

Sets up a temporary SQLite database and Flask test client so tests
never touch the real bookself.db or filesystem data.
"""

import os
import sys
import sqlite3
import tempfile
import shutil
from pathlib import Path

import pytest

# Make sure the project root is on the path
PROJECT_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(PROJECT_ROOT))


@pytest.fixture(scope='session')
def tmp_dir():
    """Temp directory that lives for the whole test session, then is deleted."""
    d = tempfile.mkdtemp(prefix='bookself_test_')
    yield Path(d)
    shutil.rmtree(d, ignore_errors=True)


@pytest.fixture(scope='session')
def seeded_db(tmp_dir):
    """
    Create a minimal SQLite database with a handful of test newsletters.
    Returns the path to the .db file.
    """
    db = tmp_dir / 'test.db'
    con = sqlite3.connect(db)
    con.execute('''
        CREATE TABLE IF NOT EXISTS newsletters (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            gmail_message_id TEXT,
            publication     TEXT,
            series          TEXT,
            date_received   TEXT,
            subject         TEXT,
            sender          TEXT,
            file_path       TEXT,
            is_read         INTEGER DEFAULT 0,
            read_at         TEXT,
            word_count      INTEGER DEFAULT 0
        )
    ''')
    # Seed: 3 articles for "TestPub", 1 read, 2 unread.
    # file_path is relative to PROJECT_ROOT — use tests/tmp/ so notes can be written there.
    con.executemany('''
        INSERT INTO newsletters
            (gmail_message_id, publication, series, date_received, subject, sender, file_path, is_read, read_at, word_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ''', [
        ('msg001', 'TestPub', 'TestSeries', '2024-01-01', 'Issue 1', 'test@example.com', 'tests/tmp/testpub/2024-01-01.html', 1, '2024-01-02 10:00:00', 450),
        ('msg002', 'TestPub', 'TestSeries', '2024-01-08', 'Issue 2', 'test@example.com', 'tests/tmp/testpub/2024-01-08.html', 0, None, 380),
        ('msg003', 'TestPub', 'TestSeries', '2024-01-15', 'Issue 3', 'test@example.com', 'tests/tmp/testpub/2024-01-15.html', 0, None, 510),
        ('msg004', 'OtherPub', None,         '2024-02-01', 'Deep Dive', 'other@example.com', 'tests/tmp/otherpub/2024-02-01.html', 0, None, 200),
    ])
    # FTS5 virtual table for full-text search (mirrors what catalog.py creates)
    con.execute('''
        CREATE VIRTUAL TABLE IF NOT EXISTS newsletters_fts USING fts5(
            subject,
            body_text,
            content='newsletters',
            content_rowid='id'
        )
    ''')
    # Populate FTS index from the seeded rows
    con.execute('''
        INSERT INTO newsletters_fts(rowid, subject, body_text)
        SELECT id, subject, '' FROM newsletters
    ''')

    con.commit()
    con.close()
    return db


@pytest.fixture(scope='session')
def newsletters_dir(tmp_dir):
    """Create a minimal newsletters directory tree with stub HTML files."""
    nl = tmp_dir / 'newsletters'
    tp = nl / 'testpub'
    tp.mkdir(parents=True, exist_ok=True)
    op = nl / 'otherpub'
    op.mkdir(parents=True, exist_ok=True)

    # Stub HTML files
    for fname in ['2024-01-01.html', '2024-01-08.html', '2024-01-15.html']:
        (tp / fname).write_text('<html><body><p>Test content</p></body></html>', encoding='utf-8')
    (op / '2024-02-01.html').write_text('<html><body><p>Other content</p></body></html>', encoding='utf-8')

    # One notes file WITH an AI summary
    notes = tp / '2024-01-01.notes.md'
    notes.write_text('## My Notes\nSome notes.\n\n## AI Summary\nThis is a summary.', encoding='utf-8')

    return nl


@pytest.fixture(scope='session')
def test_config(tmp_dir, seeded_db, newsletters_dir):
    """Minimal config dict matching the real config.yaml structure."""
    return {
        'sources': [
            {'name': 'TestPub', 'sender': 'test@example.com', 'folder': 'testpub'},
            {'name': 'OtherPub', 'sender': 'other@example.com', 'folder': 'otherpub'},
        ],
        'storage': {
            'db': str(seeded_db),
            'newsletters': str(newsletters_dir),
        }
    }


@pytest.fixture(scope='session')
def flask_app(test_config, seeded_db, newsletters_dir):
    """
    Create a Flask test app pointing at the temp DB and newsletters dir.
    We monkey-patch the module-level globals in app.py so no real files are touched.
    """
    import importlib

    # Patch env BEFORE importing app so config_loader uses our paths
    import app as bookself_app

    bookself_app.config         = test_config
    bookself_app.db_path        = seeded_db
    bookself_app.newsletters_dir = newsletters_dir

    bookself_app.app.config['TESTING'] = True
    return bookself_app.app


@pytest.fixture(scope='session')
def client(flask_app):
    """The Flask test client — reused across the whole session."""
    with flask_app.test_client() as c:
        yield c
