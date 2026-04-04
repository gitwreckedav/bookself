# ─────────────────────────────────────────────────────────────────
# bookself/storage.py
#
# Handles saving newsletter content to disk.
#
# Responsibilities:
#   1. Save cleaned HTML files to the newsletters/ folder
#   2. Download images (from HTTP URLs and Gmail MIME attachments)
#   3. Save images to the assets/ folder
#   4. Return a mapping of original image URLs → new local Flask paths
#      (this map is passed to email_parser.clean_html() to rewrite src attrs)
#
# The folders on disk mirror the UI hierarchy exactly:
#   newsletters/finshots/2026-02-25.html
#   newsletters/the-ken/ka-ching/2026-02-25.html
# ─────────────────────────────────────────────────────────────────

import re
import os
import requests
from pathlib import Path
from urllib.parse import urlparse

from bookself.email_parser import get_mime_extension

try:
    from bs4 import BeautifulSoup
    import lxml  # noqa: F401
    HTML_PARSER = 'lxml'
except ImportError:
    HTML_PARSER = 'html.parser'


def ensure_dir(path):
    """
    Create a folder and all parent folders if they don't exist.
    Does nothing if the folder already exists.
    """
    Path(path).mkdir(parents=True, exist_ok=True)


def save_html_file(html_content, file_path):
    """
    Save HTML content to a file on disk.

    Creates the parent directories if they don't already exist.

    Args:
        html_content: The cleaned HTML string to save.
        file_path: Path object or string — where to save the file.
    """
    file_path = Path(file_path)
    ensure_dir(file_path.parent)

    with open(file_path, 'w', encoding='utf-8') as f:
        f.write(html_content)


def build_file_path(newsletters_dir, publication_folder, series_folder, date_str):
    """
    Build the full file path for a newsletter HTML file.

    Handles filename deduplication: if 2026-02-25.html already exists,
    tries 2026-02-25-2.html, then 2026-02-25-3.html, etc.

    Args:
        newsletters_dir: Path to the newsletters/ root folder.
        publication_folder: e.g. 'finshots' or 'the-ken'
        series_folder: e.g. 'ka-ching' or None for flat publications
        date_str: 'YYYY-MM-DD' string

    Returns:
        Path: The full path to use for saving (guaranteed not to exist yet).
        str: The path relative to the project root (stored in database).
    """
    newsletters_dir = Path(newsletters_dir)

    if series_folder:
        dir_path = newsletters_dir / publication_folder / series_folder
    else:
        dir_path = newsletters_dir / publication_folder

    ensure_dir(dir_path)

    # Try YYYY-MM-DD.html, then YYYY-MM-DD-2.html, etc.
    base_name = date_str
    file_path = dir_path / f'{base_name}.html'
    counter = 2
    while file_path.exists():
        file_path = dir_path / f'{base_name}-{counter}.html'
        counter += 1

    # Return both the full path (for saving) and the relative path (for database)
    # The relative path is computed from the newsletters dir's parent (project root)
    project_root = newsletters_dir.parent
    relative_path = file_path.relative_to(project_root)

    return file_path, str(relative_path)


def _get_next_image_counter(slug_dir):
    """
    Scan the publication's assets folder to find the highest existing image
    number, then return the next one.

    This prevents multiple newsletters from the same publication overwriting
    each other's images. Each call to extract_and_save_images gets a unique
    range of numbers, regardless of how many times it's been called for that
    publication.

    e.g. if image-001.jpg, image-002.png already exist → returns 3
         if folder is empty → returns 1
    """
    max_num = 0
    slug_dir = Path(slug_dir)
    if slug_dir.exists():
        for f in slug_dir.iterdir():
            m = re.match(r'^image-(\d+)', f.stem)
            if m:
                max_num = max(max_num, int(m.group(1)))
    return max_num + 1


def extract_and_save_images(html_content, assets_dir, publication_folder,
                             gmail_service=None, message_id=None, attachments=None):
    """
    Find all images in the HTML, download/extract them, save to assets/.

    For each <img> tag:
    - src starts with 'cid:'   → extract from the MIME attachments list
    - src is http/https URL    → download from the internet
    - src is a data: URI       → decode and save directly
    - anything else            → skip (leave src as-is)

    Images are saved to: assets/[publication_folder]/image-NNN.ext
    The 'NNN' counter is padded to 3 digits: image-001.jpg, image-002.jpg, etc.

    Args:
        html_content: The raw HTML string (before cleaning).
        assets_dir: Path to the assets/ root folder.
        publication_folder: e.g. 'finshots', 'the-ken'
        gmail_service: Gmail API service (needed to fetch large attachments).
        message_id: Gmail message ID (needed with gmail_service for attachments).
        attachments: List of attachment dicts from email_parser.extract_html_and_attachments().

    Returns:
        dict: Mapping of original src → new local Flask URL path.
              e.g. {"https://cdn.example.com/img.jpg": "/newsletter-assets/finshots/image-001.jpg"}
    """
    from bs4 import BeautifulSoup

    assets_dir = Path(assets_dir)
    slug_dir = assets_dir / publication_folder
    ensure_dir(slug_dir)

    # Build a lookup dict for CID attachments: {content_id: attachment_dict}
    cid_map = {}
    if attachments:
        for att in attachments:
            if att.get('content_id'):
                cid_map[att['content_id']] = att

    try:
        soup = BeautifulSoup(html_content, HTML_PARSER)
    except Exception:
        from bs4 import BeautifulSoup as BS
        soup = BS(html_content, 'html.parser')

    img_counter = _get_next_image_counter(slug_dir)
    url_map = {}  # original_src → new_flask_path

    for img in soup.find_all('img'):
        src = img.get('src', '').strip()
        if not src:
            continue

        # Skip tracking pixels (1x1 images) — they'll be removed in clean_html anyway
        try:
            if int(img.get('width', 0)) == 1 and int(img.get('height', 0)) == 1:
                continue
        except (ValueError, TypeError):
            pass

        # Skip if we've already processed this exact src
        if src in url_map:
            continue

        # ── CID attachment ────────────────────────────────────────
        if src.lower().startswith('cid:'):
            content_id = src[4:].strip()
            img_data = _get_cid_data(content_id, cid_map, gmail_service, message_id)

            if img_data:
                # Determine file extension from attachment mime type
                attachment = cid_map.get(content_id, {})
                ext = get_mime_extension(attachment.get('mime_type', 'image/jpeg'))
                filename = f'image-{img_counter:03d}{ext}'
                img_counter += 1
                save_path = slug_dir / filename

                with open(save_path, 'wb') as f:
                    f.write(img_data)

                flask_url = f'/newsletter-assets/{publication_folder}/{filename}'
                url_map[src] = flask_url
            else:
                print(f"    [Images] ⚠️  Could not extract CID attachment: {content_id}")

        # ── HTTP/HTTPS URL ────────────────────────────────────────
        elif src.lower().startswith('http://') or src.lower().startswith('https://'):
            img_data, ext = _download_image(src)

            if img_data:
                filename = f'image-{img_counter:03d}{ext}'
                img_counter += 1
                save_path = slug_dir / filename

                with open(save_path, 'wb') as f:
                    f.write(img_data)

                flask_url = f'/newsletter-assets/{publication_folder}/{filename}'
                url_map[src] = flask_url
            else:
                print(f"    [Images] ⚠️  Could not download: {src[:80]}...")

        # ── Data URI (base64 inline image) ────────────────────────
        elif src.lower().startswith('data:image/'):
            img_data, ext = _decode_data_uri(src)

            if img_data:
                filename = f'image-{img_counter:03d}{ext}'
                img_counter += 1
                save_path = slug_dir / filename

                with open(save_path, 'wb') as f:
                    f.write(img_data)

                flask_url = f'/newsletter-assets/{publication_folder}/{filename}'
                url_map[src] = flask_url

        # Anything else (relative paths, etc.) — leave as-is
        # else: skip

    if img_counter > 1:
        print(f"    [Images] Saved {img_counter - 1} image(s) to assets/{publication_folder}/")

    return url_map


def _get_cid_data(content_id, cid_map, gmail_service, message_id):
    """
    Get the bytes for a CID (Content-ID) inline image.

    Tries the cid_map first (small images embedded in the message).
    Falls back to fetching from Gmail API (large images stored as attachments).

    Returns:
        bytes or None
    """
    attachment = cid_map.get(content_id)
    if not attachment:
        return None

    # Small images have data embedded directly
    if attachment.get('data'):
        return attachment['data']

    # Large images need a separate API call
    if attachment.get('attachment_id') and gmail_service and message_id:
        try:
            from bookself.gmail_client import get_attachment
            return get_attachment(gmail_service, message_id, attachment['attachment_id'])
        except Exception as e:
            print(f"    [Images] Failed to fetch attachment: {e}")
            return None

    return None


def _download_image(url):
    """
    Download an image from an HTTP/HTTPS URL.

    Returns:
        tuple: (bytes_data, extension_string) or (None, None) on failure.
    """
    try:
        response = requests.get(url, timeout=10, headers={
            'User-Agent': 'Mozilla/5.0 (compatible; BookSelf/0.1)'
        })
        if response.status_code == 200:
            # Determine extension from Content-Type header or URL
            content_type = response.headers.get('Content-Type', 'image/jpeg')
            # Strip parameters like "; charset=utf-8"
            content_type = content_type.split(';')[0].strip()
            ext = get_mime_extension(content_type)

            # If MIME extension lookup failed, try from URL
            if ext == '.img':
                parsed = urlparse(url)
                url_path = parsed.path
                if '.' in url_path:
                    ext = '.' + url_path.rsplit('.', 1)[-1].lower()[:5]  # cap extension length

            return response.content, ext
        else:
            return None, None
    except Exception as e:
        # Don't crash the entire fetch if one image fails
        return None, None


def _decode_data_uri(data_uri):
    """
    Decode a base64 data URI (data:image/png;base64,...) into bytes.

    Returns:
        tuple: (bytes_data, extension_string) or (None, None) on failure.
    """
    import base64 as b64
    try:
        # Format: data:image/png;base64,<data>
        header, data = data_uri.split(',', 1)
        mime_part = header.split(':')[1].split(';')[0]
        ext = get_mime_extension(mime_part)
        img_bytes = b64.b64decode(data)
        return img_bytes, ext
    except Exception:
        return None, None
