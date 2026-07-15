# ─────────────────────────────────────────────────────────────────
# bookself/bookself.spec
# PyInstaller packaging configuration → BookSelf.app
#
# Build locally:
#   pip install pyinstaller pywebview
#   pyinstaller bookself.spec --noconfirm
#   → dist/BookSelf.app  (drag to /Applications)
#
# CI builds this automatically on every version tag push
# (see .github/workflows/release.yml).
#
# Data separation:
#   Bundled INSIDE the app (read-only): templates, static, default configs
#   User data OUTSIDE the app:  ~/Library/Application Support/BookSelf/
#   Credentials:                ~/.config/bookself/  (never bundled)
# ─────────────────────────────────────────────────────────────────

import os
import re

# Single source of truth: read the version from app.py so the spec never drifts
APP_VERSION = re.search(r"APP_VERSION = '([^']+)'", open('app.py').read()).group(1)

block_cipher = None

a = Analysis(
    ['desktop.py'],                    # Native shell entry (window + multi-call dispatch)
    pathex=['.'],
    binaries=[],
    datas=[
        ('app/templates', 'app/templates'),
        ('app/static', 'app/static'),
        ('config.yaml', '.'),          # Default config, copied to data dir on first run
        ('ai_config.yaml', '.'),       # Default AI config, same
    ],
    hiddenimports=[
        'googleapiclient',
        'google.auth',
        'google.auth.transport.requests',
        'google_auth_oauthlib',
        'flask',
        'yaml',
        'bs4',
        'requests',
        'sqlite3',
        'webview',
        'lxml',                        # Bundle it — html.parser fallback chokes on malformed tags
        'fetch',                       # Imported dynamically by --run-fetch dispatch
        'catalog',                     # Imported dynamically by --run-catalog dispatch
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='BookSelf',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,                     # Windowed app — no terminal
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,            # Unsigned — right-click → Open on first launch
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    name='BookSelf',
)

app = BUNDLE(
    coll,
    name='BookSelf.app',
    icon='packaging/BookSelf.icns' if os.path.exists('packaging/BookSelf.icns') else None,
    bundle_identifier='com.gitwreckedav.bookself',
    info_plist={
        'NSHighResolutionCapable': True,
        'CFBundleShortVersionString': APP_VERSION,
        'CFBundleName': 'BookSelf',
        'NSHumanReadableCopyright': 'Local-first newsletter library',
    },
)
