# ─────────────────────────────────────────────────────────────────
# bookself/gmail_client.py
#
# Handles Gmail API authentication and email fetching.
#
# How authentication works:
#   - credentials.json  = proof that this app is registered with Google
#                         (you download this once from Google Cloud Console)
#   - token.json        = your personal authorization for this app to read
#                         your Gmail (auto-generated on first run, auto-refreshed)
#
# On first run: opens a browser window where you log into Google and
#               click "Allow". After that, token.json is saved and
#               all future runs are silent.
#
# Scope: gmail.readonly — read-only. BookSelf NEVER modifies, deletes,
#        or sends email. It only reads.
# ─────────────────────────────────────────────────────────────────

import os
from pathlib import Path
from datetime import datetime, timedelta

from google.oauth2.credentials import Credentials
from google.auth.exceptions import RefreshError
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from googleapiclient.discovery import build


# The only Gmail permission we request: read-only
SCOPES = ['https://www.googleapis.com/auth/gmail.readonly']


def get_config_dir():
    """Returns ~/.config/bookself — the safe, out-of-project location for credentials."""
    config_dir = Path.home() / '.config' / 'bookself'
    config_dir.mkdir(parents=True, exist_ok=True)
    return config_dir


def get_gmail_service():
    """
    Authenticates with Gmail and returns a service object for making API calls.

    On first run: opens a browser for Google OAuth consent.
    On subsequent runs: silently refreshes the token if needed.

    Returns:
        googleapiclient.discovery.Resource: The Gmail API service object.

    Raises:
        FileNotFoundError: If credentials.json is not in ~/.config/bookself/.
    """
    config_dir = get_config_dir()
    credentials_path = config_dir / 'credentials.json'
    token_path = config_dir / 'token.json'

    # ── Check for credentials.json ────────────────────────────────
    if not credentials_path.exists():
        raise FileNotFoundError(
            f"\n❌  credentials.json not found at: {credentials_path}\n\n"
            "    To fix this:\n"
            "    1. Go to https://console.cloud.google.com\n"
            "    2. Select your project → APIs & Services → Credentials\n"
            "    3. Download your OAuth 2.0 Client ID JSON file\n"
            f"    4. Rename it to 'credentials.json' and move it to:\n"
            f"       {config_dir}/\n\n"
            "    This folder is outside the project so it is never accidentally committed to git."
        )

    creds = None

    # ── Load existing token if we have one ────────────────────────
    if token_path.exists():
        creds = Credentials.from_authorized_user_file(str(token_path), SCOPES)

    # ── Refresh or re-authorize if token is missing or expired ────
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            # Token exists but expired — refresh it silently (no browser needed)
            print("  [Auth] Refreshing Gmail token...")
            try:
                creds.refresh(Request())
            except RefreshError:
                # Token was revoked (common after ~7 days in Google "Testing" mode)
                # Auto-recover: delete stale token, fall through to re-auth below
                print("  [Auth] Token revoked or expired — re-authorizing...")
                token_path.unlink(missing_ok=True)
                creds = None
        if not creds:
            # No token or couldn't refresh — open browser for first-time authorization
            print("  [Auth] Opening browser for Gmail authorization...")
            print("         Log in with your Google account and click 'Allow'.")
            print("         This only happens once.")
            flow = InstalledAppFlow.from_client_secrets_file(
                str(credentials_path), SCOPES
            )
            creds = flow.run_local_server(port=0)

        # Save the token for next time
        with open(str(token_path), 'w') as token_file:
            token_file.write(creds.to_json())
        print("  [Auth] Token saved. Future runs will be silent.")

    # ── Build and return the Gmail API service ────────────────────
    service = build('gmail', 'v1', credentials=creds)
    print("  [Auth] Gmail connected ✓")
    return service


def fetch_messages_from_sender(service, sender_email, since_date):
    """
    Fetch all Gmail message IDs from a specific sender after a given date.

    Doesn't download the full message content — just gets the IDs.
    We then call get_full_message() for each ID we want to process.

    Args:
        service: Gmail API service object from get_gmail_service().
        sender_email: The sender's email address to filter by.
        since_date: datetime object — only fetch emails after this date.

    Returns:
        list of str: Gmail message IDs (strings like "18e1a2b3c4d5e6f7")
    """
    # Format date for Gmail query: YYYY/MM/DD
    date_str = since_date.strftime('%Y/%m/%d')
    query = f'from:{sender_email} after:{date_str}'

    print(f"  [Gmail] Querying: {query}")

    message_ids = []
    page_token = None

    # Gmail returns results in pages of up to 100. Loop through all pages.
    while True:
        params = {
            'userId': 'me',
            'q': query,
            'maxResults': 100
        }
        if page_token:
            params['pageToken'] = page_token

        response = service.users().messages().list(**params).execute()

        messages = response.get('messages', [])
        message_ids.extend([msg['id'] for msg in messages])

        # Check if there's another page
        page_token = response.get('nextPageToken')
        if not page_token:
            break

    print(f"  [Gmail] Found {len(message_ids)} message(s) from {sender_email}")
    return message_ids


def get_full_message(service, message_id):
    """
    Download the full content of a single Gmail message.

    Returns the complete message object including all MIME parts
    (headers, body, attachments). The 'full' format gives us everything
    we need to reconstruct the email.

    Args:
        service: Gmail API service object.
        message_id: The Gmail message ID string.

    Returns:
        dict: The full Gmail message object.
    """
    message = service.users().messages().get(
        userId='me',
        id=message_id,
        format='full'
    ).execute()
    return message


def fetch_ids_after_epoch(service, sender_email, since_epoch_ms):
    """
    Fetch all Gmail message IDs from a specific sender AFTER a Unix timestamp.

    Used by incremental sync mode. More precise than date-based queries:
    after:EPOCH_SECONDS is supported by Gmail API and avoids re-fetching
    the entire last day when syncing multiple times per day.

    Args:
        service: Gmail API service object from get_gmail_service().
        sender_email: The sender's email address to filter by.
        since_epoch_ms: Unix timestamp in milliseconds. Emails AFTER
                        this point in time are returned.

    Returns:
        list of str: Gmail message IDs
    """
    epoch_sec = since_epoch_ms // 1000
    query = f'from:{sender_email} after:{epoch_sec}'

    print(f"  [Gmail] Querying (incremental): {query}")

    message_ids = []
    page_token = None

    while True:
        params = {
            'userId': 'me',
            'q': query,
            'maxResults': 500
        }
        if page_token:
            params['pageToken'] = page_token

        response = service.users().messages().list(**params).execute()

        messages = response.get('messages', [])
        message_ids.extend([msg['id'] for msg in messages])

        page_token = response.get('nextPageToken')
        if not page_token:
            break

    print(f"  [Gmail] Found {len(message_ids)} message(s) from {sender_email}")
    return message_ids


def get_attachment(service, message_id, attachment_id):
    """
    Download a specific attachment from a Gmail message.

    Used for inline images that are too large to be embedded directly
    in the message body (Gmail puts large attachments in a separate request).

    Args:
        service: Gmail API service object.
        message_id: The Gmail message ID.
        attachment_id: The attachment ID from the message payload.

    Returns:
        bytes: The raw attachment data.
    """
    import base64
    attachment = service.users().messages().attachments().get(
        userId='me',
        messageId=message_id,
        id=attachment_id
    ).execute()

    data = attachment.get('data', '')
    return base64.urlsafe_b64decode(data + '==')
