# ─────────────────────────────────────────────────────────────────
# bookself/bookself.spec
# PyInstaller packaging configuration.
#
# This bundles BookSelf into a single standalone executable so users
# don't need Python installed.
#
# To build (after installing pyinstaller):
#   pip install pyinstaller
#   pyinstaller bookself.spec
#
# Output:
#   dist/bookself        (folder containing the app)
#   dist/bookself.app    (on macOS — drag to Applications)
#   dist/bookself.exe    (on Windows — run directly)
#
# NOTE: credentials.json, token.json, config.yaml, and the
# newsletters/ folder all stay OUTSIDE the executable, in the same
# folder the user runs the app from.
#
# TODO (v0.2): Test and finalize this spec. Currently a stub.
# ─────────────────────────────────────────────────────────────────

block_cipher = None

a = Analysis(
    ['app.py'],                         # Entry point (the Flask server)
    pathex=['.'],
    binaries=[],
    datas=[
        ('app/templates', 'app/templates'),   # Include HTML templates
        ('app/static', 'app/static'),          # Include CSS and JS
        ('config.yaml', '.'),                  # Include default config
    ],
    hiddenimports=[
        'googleapiclient',
        'google.auth',
        'google.auth.transport.requests',
        'google_auth_oauthlib',
        'flask',
        'pyyaml',
        'yaml',
        'bs4',
        'lxml',
        'requests',
        'sqlite3',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='bookself',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=True,                       # Show terminal output (useful for debugging)
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,            # TODO: add Mac code signing for v0.2
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='bookself',
)

# macOS .app bundle (ignored on Windows)
app = BUNDLE(
    coll,
    name='BookSelf.app',
    icon=None,                         # TODO: add icon for v0.2
    bundle_identifier='com.bookself.app',
)
