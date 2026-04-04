# ─────────────────────────────────────────────────────────────────
# bookself/email_parser.py
#
# Extracts content and metadata from raw Gmail API message objects.
#
# Responsibilities:
#   1. Pull the HTML body out of the Gmail MIME message structure
#   2. Extract metadata: subject, sender name, date
#   3. Detect which series a The Ken email belongs to
#   4. Clean the HTML: strip scripts, tracking pixels, add base target
#   5. Rewrite image src attributes to point to locally saved files
#   6. Extract plain text (for the full-text search index)
# ─────────────────────────────────────────────────────────────────

import base64
import re
from datetime import datetime
from email.utils import parsedate_to_datetime, parseaddr

# Try to use lxml (faster parser). Fall back to built-in html.parser if unavailable.
try:
    import lxml  # noqa: F401
    HTML_PARSER = 'lxml'
except ImportError:
    HTML_PARSER = 'html.parser'
    print("  [Parser] lxml not available — using html.parser (slower but works fine)")

from bs4 import BeautifulSoup


# ── MIME extraction ───────────────────────────────────────────────

def extract_html_and_attachments(payload):
    """
    Recursively walk the Gmail message MIME tree to find:
      - The HTML body (text/html part)
      - Inline image attachments (image/* parts with Content-ID headers)

    Gmail messages can be nested in complex MIME structures:
        multipart/mixed
          └── multipart/alternative
                ├── text/plain
                └── multipart/related
                      ├── text/html
                      └── image/jpeg  ← inline image

    Args:
        payload: The 'payload' field from a Gmail API message object.

    Returns:
        tuple: (html_string, list_of_attachment_dicts)
               html_string is None if no HTML body found.
               Each attachment dict has: content_id, mime_type, data (bytes or None), attachment_id
    """
    html_body = None
    attachments = []

    def walk(part):
        nonlocal html_body

        mime_type = part.get('mimeType', '')
        headers = {h['name'].lower(): h['value'] for h in part.get('headers', [])}

        if mime_type == 'text/html':
            # Found the HTML body — decode from base64url
            raw_data = part.get('body', {}).get('data', '')
            if raw_data:
                html_body = base64.urlsafe_b64decode(raw_data + '==').decode('utf-8', errors='replace')

        elif mime_type.startswith('image/'):
            # Found an inline image attachment
            content_id = headers.get('content-id', '').strip('<>').strip()
            body = part.get('body', {})
            raw_data = body.get('data', '')
            attachment_id = body.get('attachmentId')

            if raw_data:
                # Small image — data is embedded directly in the message
                attachments.append({
                    'content_id': content_id,
                    'mime_type': mime_type,
                    'data': base64.urlsafe_b64decode(raw_data + '=='),
                    'attachment_id': None
                })
            elif attachment_id:
                # Large image — stored as a separate Gmail attachment
                attachments.append({
                    'content_id': content_id,
                    'mime_type': mime_type,
                    'data': None,
                    'attachment_id': attachment_id
                })

        # Recurse into sub-parts (handles nested multipart messages)
        for sub_part in part.get('parts', []):
            walk(sub_part)

    walk(payload)
    return html_body, attachments


def parse_gmail_message(message_data):
    """
    Extract everything we need from a Gmail API message object.

    Args:
        message_data: The full Gmail message dict from get_full_message().

    Returns:
        dict with:
            gmail_message_id  — Gmail's unique message ID
            subject           — Email subject line
            sender_name       — Display name of sender (e.g. "Finshots")
            sender_email      — Email address of sender
            date_str          — Date as YYYY-MM-DD string
            html              — Full HTML body (or None if not found)
            attachments       — List of inline image attachment dicts
    """
    payload = message_data.get('payload', {})
    headers = {h['name'].lower(): h['value'] for h in payload.get('headers', [])}

    # ── Subject ───────────────────────────────────────────────────
    subject = headers.get('subject', '(No subject)')
    # Clean up common encoding artifacts
    subject = subject.replace('\r', '').replace('\n', ' ').strip()

    # ── Sender ────────────────────────────────────────────────────
    from_header = headers.get('from', '')
    sender_name, sender_email = parseaddr(from_header)
    if not sender_name:
        sender_name = sender_email  # Fallback if no display name

    # ── Date ──────────────────────────────────────────────────────
    date_header = headers.get('date', '')
    try:
        dt = parsedate_to_datetime(date_header)
        date_str = dt.strftime('%Y-%m-%d')
    except Exception:
        # Fallback: use today's date if parsing fails
        date_str = datetime.now().strftime('%Y-%m-%d')

    # ── HTML body and attachments ─────────────────────────────────
    html, attachments = extract_html_and_attachments(payload)

    return {
        'gmail_message_id': message_data['id'],
        'subject': subject,
        'sender_name': sender_name,
        'sender_email': sender_email,
        'date_str': date_str,
        'html': html,
        'attachments': attachments
    }


# ── Series detection ──────────────────────────────────────────────

def detect_series(html_content, source_config, subject=None):
    """
    For 'type: series' newsletter sources, determine which series an email
    belongs to.

    Detection priority (highest confidence first):
    1. Check email subject line — series names appear literally in subjects
       (e.g. "Ka-Ching! | The business of payments", "The Nutgraf: Indian media")
       Uses 'subject_marker' from config if set, otherwise uses 'name'.
    2. Check visible body text — fallback for emails where subject is ambiguous
    3. Check for paid preview marker
    4. Return 'unsorted' if nothing matched

    Args:
        html_content:  Raw HTML string from the email.
        source_config: The source's config dict (from config.yaml sources list).
        subject:       Email subject line (optional but recommended).

    Returns:
        tuple: (series_name, series_folder)
               e.g. ("Ka-Ching!", "ka-ching") or ("unsorted", "unsorted")
    """
    if not html_content:
        return ('unsorted', 'unsorted')

    series_detection = source_config.get('series_detection', {})
    known_series = series_detection.get('known_series', [])

    # ── 1. Subject-line detection (primary, high confidence) ─────
    if subject:
        subject_upper = subject.upper()
        for series in known_series:
            # Use subject_marker if defined, otherwise fall back to name
            marker = series.get('subject_marker') or series['name']
            if marker.upper() in subject_upper:
                return (series['name'], series['folder'])

    # ── 2. Body text detection (fallback) ────────────────────────
    soup = BeautifulSoup(html_content, HTML_PARSER)
    visible_text = soup.get_text(separator=' ').upper()

    # Check paid preview marker first (before series match)
    paid_config = source_config.get('paid_preview_detection', {})
    if paid_config:
        marker = paid_config.get('marker', '').upper()
        if marker and marker in visible_text:
            paid_folder = paid_config.get('folder', 'paid-articles')
            return ('paid-articles', paid_folder)

    for series in known_series:
        series_name_upper = series['name'].upper()
        if series_name_upper in visible_text:
            return (series['name'], series['folder'])

    # ── 3. No match ───────────────────────────────────────────────
    return ('unsorted', 'unsorted')


# ── HTML cleaning ─────────────────────────────────────────────────

def clean_html(html_content, img_url_map=None):
    """
    Clean the raw email HTML before saving it to disk.

    Transformations applied (and why):
    - Strip <script> tags            → security (no JS runs in our UI)
    - Strip 1×1 tracking pixels      → privacy (stops email open tracking)
    - Add <base target="_blank">     → links open in new browser tab, not inside our iframe
    - Rewrite img src attributes     → point to locally saved images instead of remote URLs

    Only these changes are made. The original content, styling, and
    layout of the newsletter are preserved exactly as-is.

    Args:
        html_content: Raw HTML string from the email.
        img_url_map: dict mapping original src values → new local Flask URL paths.
                     e.g. {"https://example.com/img.jpg": "/newsletter-assets/finshots/image-001.jpg"}
                     Pass None or {} to skip image rewriting.

    Returns:
        str: Cleaned HTML string.
    """
    if not html_content:
        return '<html><body><p>(No content)</p></body></html>'

    soup = BeautifulSoup(html_content, HTML_PARSER)

    # ── Strip all <script> tags ───────────────────────────────────
    for script in soup.find_all('script'):
        script.decompose()

    # ── Strip tracking pixels ─────────────────────────────────────
    # A tracking pixel is a 1×1 image that newsletters use to detect if you opened the email.
    # We remove these for privacy. This doesn't affect visible content.
    for img in soup.find_all('img'):
        width = img.get('width', '')
        height = img.get('height', '')
        try:
            if int(width) == 1 and int(height) == 1:
                img.decompose()
                continue
        except (ValueError, TypeError):
            pass

    # ── Add base target="_blank" ──────────────────────────────────
    # This makes ALL links in the newsletter open in a new browser tab.
    # Without this, clicking a link would try to navigate the iframe, which looks broken.
    head = soup.find('head')
    if head:
        base_tag = soup.new_tag('base', target='_blank')
        head.insert(0, base_tag)
    else:
        # Some emails have no <head> tag — create a minimal one
        new_head = soup.new_tag('head')
        base_tag = soup.new_tag('base', target='_blank')
        new_head.append(base_tag)
        if soup.html:
            soup.html.insert(0, new_head)

    # ── Rewrite image src attributes ─────────────────────────────
    # Replace remote/CID image URLs with local Flask paths.
    if img_url_map:
        for img in soup.find_all('img'):
            original_src = img.get('src', '')
            if original_src in img_url_map:
                img['src'] = img_url_map[original_src]

    return str(soup)


def extract_plain_text(html_content):
    """
    Extract plain readable text from HTML for the full-text search index.

    This text is stored in the FTS5 index and is what gets searched
    when you type in the search bar. It's not stored in the main table
    and is not shown to the user directly.

    Returns:
        str: Plain text with excessive whitespace collapsed.
    """
    if not html_content:
        return ''

    soup = BeautifulSoup(html_content, HTML_PARSER)

    # Remove script and style tags (their text isn't readable content)
    for tag in soup.find_all(['script', 'style']):
        tag.decompose()

    text = soup.get_text(separator=' ')

    # Collapse multiple spaces/newlines into single spaces
    text = re.sub(r'\s+', ' ', text).strip()

    return text


def count_words(html_content):
    """
    Estimate the word count of a newsletter.

    Shown in overview cards and the reading header.
    Approximate — good enough for display purposes.

    Returns:
        int: Estimated word count.
    """
    plain_text = extract_plain_text(html_content)
    if not plain_text:
        return 0
    return len(plain_text.split())


def get_mime_extension(mime_type):
    """
    Convert a MIME type to a file extension.

    Used when saving images extracted from newsletters.

    e.g. 'image/jpeg' → '.jpg', 'image/png' → '.png'
    """
    mime_map = {
        'image/jpeg': '.jpg',
        'image/jpg': '.jpg',
        'image/png': '.png',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'image/svg+xml': '.svg',
        'image/bmp': '.bmp',
        'image/tiff': '.tiff',
    }
    return mime_map.get(mime_type.lower(), '.img')
