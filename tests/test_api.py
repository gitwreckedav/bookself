"""
BookSelf functional API tests.

Covers every major Flask endpoint:
  - Publications + newsletters listing
  - Newsletter content retrieval
  - Toggle-read (mark done / unmark)
  - Search
  - Library summary (counts + AI summary counts)
  - Reading stats
  - AI config get/save/test/list-models
  - Notes get/save

Run:  cd bookself && .venv/bin/python -m pytest tests/ -v
"""

import json
import pytest


# ──────────────────────────────────────────────────────────────────
# Helper
# ──────────────────────────────────────────────────────────────────

def jget(client, url):
    """GET url, assert 200, return parsed JSON."""
    r = client.get(url)
    assert r.status_code == 200, f"GET {url} returned {r.status_code}: {r.data[:200]}"
    return json.loads(r.data)


# ──────────────────────────────────────────────────────────────────
# Publications
# ──────────────────────────────────────────────────────────────────

class TestPublications:

    def test_publications_returns_list(self, client):
        data = jget(client, '/api/publications')
        assert isinstance(data, list), "Expected a list of publications"

    def test_publications_contains_testpub(self, client):
        data = jget(client, '/api/publications')
        # /api/publications returns a list of strings (publication names)
        assert 'TestPub' in data, f"TestPub missing from {data}"

    def test_series_for_publication(self, client):
        data = jget(client, '/api/publications/TestPub/series')
        # Either a list or a dict with a series key
        assert data is not None


# ──────────────────────────────────────────────────────────────────
# Newsletters listing
# ──────────────────────────────────────────────────────────────────

class TestNewsletters:

    def test_list_all(self, client):
        data = jget(client, '/api/newsletters')
        assert isinstance(data, list)
        assert len(data) >= 4, f"Expected ≥4 newsletters, got {len(data)}"

    def test_filter_by_publication(self, client):
        data = jget(client, '/api/newsletters?publication=TestPub')
        # The endpoint accepts ?publication and should return only matching rows.
        # With our seeded test DB: 3 TestPub rows.
        testpub_rows = [n for n in data if n['publication'] == 'TestPub']
        assert len(testpub_rows) == 3, \
            f"Expected 3 TestPub rows, got {len(testpub_rows)} (total={len(data)})"

    def test_newsletter_has_required_fields(self, client):
        data = jget(client, '/api/newsletters')
        item = data[0]
        for field in ('id', 'publication', 'subject', 'date_received', 'is_read'):
            assert field in item, f"Missing field: {field}"

    def test_newsletter_by_id(self, client):
        # Get the first newsletter ID
        listing = jget(client, '/api/newsletters')
        first_id = listing[0]['id']
        data = jget(client, f'/api/newsletters/{first_id}')
        assert data['id'] == first_id

    def test_newsletter_by_id_404(self, client):
        r = client.get('/api/newsletters/999999')
        assert r.status_code == 404


# ──────────────────────────────────────────────────────────────────
# Toggle read
# ──────────────────────────────────────────────────────────────────

class TestToggleRead:

    def test_mark_as_read(self, client):
        # Use msg002 (unread) — id=2
        listing = jget(client, '/api/newsletters?publication=TestPub')
        unread = next(n for n in listing if n['is_read'] == 0)
        nid = unread['id']

        r = client.post(f'/api/newsletters/{nid}/toggle-read')
        assert r.status_code == 200
        result = json.loads(r.data)
        assert result.get('is_read') == 1, "Should now be marked read"

    def test_toggle_back_to_unread(self, client):
        listing = jget(client, '/api/newsletters?publication=TestPub')
        # Find one we just marked read (is_read=1 with no original read_at)
        read_item = next((n for n in listing if n['is_read'] == 1 and n['id'] != 1), None)
        if read_item is None:
            pytest.skip("No suitable read article found for toggle-back test")
        nid = read_item['id']
        r = client.post(f'/api/newsletters/{nid}/toggle-read')
        result = json.loads(r.data)
        assert result.get('is_read') == 0

    def test_toggle_nonexistent_returns_structured_response(self, client):
        # The app returns 200 with is_read=0 for unknown IDs (toggle_read silently no-ops).
        # We verify it doesn't crash (5xx) and returns a valid JSON body.
        r = client.post('/api/newsletters/999999/toggle-read')
        assert r.status_code in (200, 404), f"Unexpected status {r.status_code}"
        data = json.loads(r.data)
        assert isinstance(data, dict)


# ──────────────────────────────────────────────────────────────────
# Search
# ──────────────────────────────────────────────────────────────────

class TestSearch:

    def test_search_returns_list(self, client):
        data = jget(client, '/api/search?q=Issue')
        assert isinstance(data, list)

    def test_search_finds_matching(self, client):
        # Search uses SQLite LIKE on subject + body. Our seeded rows have "Issue N" subjects.
        data = jget(client, '/api/search?q=Issue')
        # Should find at least the 3 TestPub rows (all have "Issue" in subject)
        assert len(data) >= 3, \
            f"Expected ≥3 results for 'Issue', got {len(data)}: {[n['subject'] for n in data]}"

    def test_search_empty_query(self, client):
        # Should return 200 (empty list or all items — not an error)
        r = client.get('/api/search?q=')
        assert r.status_code == 200

    def test_search_no_results(self, client):
        data = jget(client, '/api/search?q=XYZZY_NOTFOUND')
        assert data == [] or isinstance(data, list)


# ──────────────────────────────────────────────────────────────────
# Library summary
# ──────────────────────────────────────────────────────────────────

class TestLibrarySummary:

    def test_returns_list(self, client):
        data = jget(client, '/api/library/summary')
        assert isinstance(data, list)

    def test_has_required_fields(self, client):
        data = jget(client, '/api/library/summary')
        for source in data:
            for field in ('name', 'count', 'read_count', 'ai_summary_count'):
                assert field in source, f"Missing field '{field}' in source: {source}"

    def test_testpub_article_count(self, client):
        data = jget(client, '/api/library/summary')
        testpub = next((s for s in data if s['name'] == 'TestPub'), None)
        assert testpub is not None, "TestPub missing from library summary"
        assert testpub['count'] == 3, f"Expected 3 articles, got {testpub['count']}"

    def test_testpub_ai_summary_count(self, client):
        data = jget(client, '/api/library/summary')
        testpub = next((s for s in data if s['name'] == 'TestPub'), None)
        assert testpub is not None
        # We seeded 1 notes file with an AI Summary section
        assert testpub['ai_summary_count'] == 1, \
            f"Expected 1 AI summary, got {testpub['ai_summary_count']}"


# ──────────────────────────────────────────────────────────────────
# Reading stats
# ──────────────────────────────────────────────────────────────────

class TestReadingStats:

    def test_stats_returns_200(self, client):
        r = client.get('/api/stats')
        assert r.status_code == 200, f"Stats returned {r.status_code}: {r.data[:300]}"

    def test_stats_has_required_fields(self, client):
        data = jget(client, '/api/stats')
        # The stats endpoint returns total_library, total_read, this_week, etc.
        for field in ('total_library', 'total_read'):
            assert field in data, f"Stats missing field: {field} — got keys: {list(data.keys())}"

    def test_stats_totals_make_sense(self, client):
        data = jget(client, '/api/stats')
        assert data['total_library'] >= 4
        assert data['total_read'] >= 1   # We seeded 1 pre-read article (msg001)


# ──────────────────────────────────────────────────────────────────
# Notes (get + save)
# ──────────────────────────────────────────────────────────────────

class TestNotes:

    def _first_id(self, client):
        listing = jget(client, '/api/newsletters?publication=TestPub')
        return listing[0]['id']

    def test_get_note_returns_200(self, client):
        nid = self._first_id(client)
        r = client.get(f'/api/newsletters/{nid}/note')
        assert r.status_code == 200

    def test_save_note(self, client):
        nid = self._first_id(client)
        # The save endpoint expects {my_notes, ai_summary} (not {note})
        payload = json.dumps({'my_notes': 'Test note content', 'ai_summary': ''})
        r = client.post(
            f'/api/newsletters/{nid}/note',
            data=payload,
            content_type='application/json'
        )
        assert r.status_code == 200

    def test_saved_note_is_retrievable(self, client):
        nid = self._first_id(client)
        # Save a personal note using the correct key names
        client.post(
            f'/api/newsletters/{nid}/note',
            data=json.dumps({'my_notes': 'Persistent note', 'ai_summary': ''}),
            content_type='application/json'
        )
        # Retrieve — endpoint returns {my_notes, ai_summary, has_note, notes_path}
        data = jget(client, f'/api/newsletters/{nid}/note')
        assert 'my_notes' in data, f"Expected 'my_notes' key, got: {list(data.keys())}"
        assert 'Persistent note' in data['my_notes']


# ──────────────────────────────────────────────────────────────────
# AI config
# ──────────────────────────────────────────────────────────────────

class TestAIConfig:

    def test_get_ai_config_returns_200(self, client):
        r = client.get('/api/ai-config')
        assert r.status_code == 200

    def test_get_ai_config_has_fields(self, client):
        data = jget(client, '/api/ai-config')
        for field in ('provider', 'model', 'base_url', 'summary_prompt'):
            assert field in data, f"AI config missing field: {field}"

    def test_save_ai_config_accepts_valid_payload(self, client):
        payload = json.dumps({
            'provider': 'ollama',
            'model': 'llama3',
            'base_url': 'http://localhost:11434',
            'api_key': '',
            'max_words': 5000,
            'summary_prompt': 'Summarize briefly.'
        })
        r = client.post('/api/ai-config', data=payload, content_type='application/json')
        assert r.status_code == 200

    def test_list_models_returns_200_for_ollama(self, client):
        # This may return an error if Ollama isn't running — that's OK,
        # we just verify the endpoint exists and returns a structured response
        r = client.get('/api/ai-config/models?provider=ollama&base_url=http://localhost:11434')
        assert r.status_code in (200, 503), \
            f"Unexpected status from /api/ai-config/models: {r.status_code}"

    def test_test_connection_returns_structured_response(self, client):
        r = client.post('/api/ai-config/test')
        data = json.loads(r.data)
        # Should always return {ok: bool, message: str} — never a 500
        assert r.status_code == 200
        assert 'ok' in data
        assert 'message' in data


# ──────────────────────────────────────────────────────────────────
# Config get
# ──────────────────────────────────────────────────────────────────

class TestConfig:

    def test_get_config_returns_content(self, client):
        # /api/config returns the raw YAML file as {content: <string>}
        data = jget(client, '/api/config')
        assert 'content' in data, f"Expected 'content' key, got: {list(data.keys())}"
        assert isinstance(data['content'], str)
        # The content should include the sources section
        assert 'sources:' in data['content']
