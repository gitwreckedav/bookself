# BookSelf

**A local-first newsletter reader.** Pulls your newsletters from Gmail, organises them on disk, and serves a clean two-pane reading UI — entirely on your machine. No cloud, no subscriptions, no tracking.

---

## What it does

BookSelf takes newsletters you already receive in Gmail and gives them a proper reading experience:

- Fetches emails via Gmail API → saves them as clean HTML files on your computer
- Organises by publication and series automatically (configurable via YAML)
- Serves a browser-based reading UI at `localhost:5001` with search, nav tree, and offline support
- Strips tracking pixels. Works completely offline after first sync.

**Everything stays on your machine.** Your newsletters are plain HTML files in a folder. No accounts, no cloud sync, no data sent anywhere.

---

## Architecture

Three-stage pipeline:

```
fetch.py       →   catalog.py   →   app.py
(Gmail API)        (index+clean)    (web UI)
data/raw/          newsletters/     localhost:5001
                   bookself.db
```

| Stage | Script | What it does |
|-------|--------|--------------|
| **Acquire** | `fetch.py` | OAuth into Gmail, pull emails as JSON to `data/raw/` |
| **Catalog** | `catalog.py` | Parse HTML, detect series, save to `newsletters/`, index in SQLite |
| **Serve** | `app.py` | Flask server for the reading UI at `localhost:5001` |

---

## Prerequisites

- **Python 3.10+** — [python.org/downloads](https://www.python.org/downloads/)
- A Gmail account with the newsletters you want to read
- A Google Cloud project with the Gmail API enabled (one-time, free — see below)

---

## Setup (first time)

### Step 1 — Get Google Cloud credentials

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. **New Project** → name it anything (e.g. "BookSelf")
3. **APIs & Services → Library** → search "Gmail API" → Enable
4. **APIs & Services → Credentials → + Create Credentials → OAuth client ID**
5. If prompted: configure consent screen → External, add your Gmail as test user
6. Application type: **Desktop app** → Create
7. **Download JSON** → save as `credentials.json` in the bookself folder

### Step 2 — Install

```bash
# Clone the repo
git clone https://github.com/your-username/bookself.git
cd bookself

# Place credentials.json here (from Step 1)
# Never commit this file — it's already in .gitignore

# Install dependencies
bash setup.sh          # Mac / Linux
setup.bat              # Windows
```

### Step 3 — First sync

```bash
source .venv/bin/activate      # Mac / Linux
.venv\Scripts\activate         # Windows

python fetch.py --mode seed    # Pulls all newsletters since Jan 2024
python catalog.py              # Indexes them into the UI
python app.py                  # Opens http://localhost:5001
```

On first run, a browser window opens for Google sign-in. After that, `token.json` is saved locally — you won't need to sign in again.

---

## Daily use

```bash
source .venv/bin/activate
python fetch.py                # Incremental sync (new emails only)
python app.py                  # Open UI
```

Or use the **↻ Sync** button inside the app — no terminal needed after setup.

---

## Configuring newsletter sources

Edit `config.yaml` — the only file you need to touch to add or remove sources.

**Simple newsletter** (flat list of editions):
```yaml
- name: My Newsletter
  folder: my-newsletter
  sender: hello@mynewsletter.com
  type: simple
```

**Publication with named series** (e.g. a magazine with columns):
```yaml
- name: My Publication
  folder: my-publication
  sender: news@mypublication.com
  type: series
  series_detection:
    method: html_text
    known_series:
      - name: Finance Column
        folder: finance
      - name: Tech Column
        folder: tech
        subject_marker: "Tech"   # optional: what appears in the email subject
```

Detection checks the email **subject line first** (fastest and most accurate), then falls back to scanning the email body. Use `subject_marker` when the text in the subject differs from the series `name`.

After editing `config.yaml`:
```bash
python catalog.py --audit      # Dry-run: see how emails would be classified
python catalog.py --full-purge # Re-catalog everything with the new config
```

---

## Useful catalog commands

```bash
python catalog.py              # Normal run (skips already-indexed emails)
python catalog.py --audit      # Dry-run classification report (nothing written)
python catalog.py --full-purge # Wipe index, re-catalog from raw files
python catalog.py --start-date 2024-01-01  # Seed mode (used by UI sync button)
```

`data/raw/` is never touched by catalog.py — it is the source of truth. You can safely run `--full-purge` at any time.

---

## Setting up on a second machine (pull from GitHub)

Your config and source code live in the repo. Your data (`newsletters/`, `bookself.db`) is rebuilt locally on each machine.

```bash
# 1. Clone (or pull latest)
git clone https://github.com/your-username/bookself.git
cd bookself

# 2. Copy credentials.json from your primary machine
#    (USB / secure transfer — never commit this file)

# 3. Install dependencies
bash setup.sh         # Mac / Linux
setup.bat             # Windows

# 4. Seed sync — fetches from Gmail and builds your local library
source .venv/bin/activate
python fetch.py --mode seed
python catalog.py
python app.py
```

Each device independently maintains its own `data/`, `newsletters/`, and `bookself.db`. They stay in sync by fetching from Gmail independently.

---

## File structure

```
bookself/
├── credentials.json      ← YOU provide (Google Cloud OAuth, gitignored)
├── token.json            ← auto-generated on first auth (gitignored)
├── config.yaml           ← edit to add/remove newsletter sources
├── fetch.py              ← Stage 1: Gmail acquisition
├── catalog.py            ← Stage 2: indexing + HTML processing
├── app.py                ← Stage 3: web UI server
├── requirements.txt
├── setup.sh / setup.bat
│
├── bookself/             ← Python package (internal modules)
│   ├── config_loader.py
│   ├── database.py
│   ├── email_parser.py
│   ├── gmail_client.py
│   └── storage.py
│
├── data/                 ← gitignored, rebuilt by fetch.py
│   ├── raw/              ← one JSON file per Gmail message
│   └── state/            ← sync state (last fetch timestamp)
│
├── newsletters/          ← gitignored, rebuilt by catalog.py
│   ├── finshots/
│   ├── the-ken/
│   │   ├── ka-ching/
│   │   ├── the-nutgraf/
│   │   └── ...
│   └── ...
│
└── assets/               ← gitignored, extracted newsletter images
```

---

## Privacy

- Gmail access is **read-only** (`gmail.readonly` scope). BookSelf cannot send, modify, or delete email.
- `credentials.json` and `token.json` are gitignored and never leave your machine.
- Tracking pixels are stripped from every newsletter during cataloging.
- After the initial sync, the UI works fully offline.
- No analytics, no telemetry, no external network calls from the web UI.

---

## Limitations / non-goals

- Designed for one person / one Gmail account — no multi-user support
- No mobile app — browser-only, localhost
- Requires Gmail — no IMAP or other email providers yet
- No read/bookmark tracking stored yet (planned)

---

## Built with

Python · Flask · SQLite (FTS5) · BeautifulSoup · Gmail API · Vanilla JS
