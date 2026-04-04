@echo off
REM ─────────────────────────────────────────────────────────────────
REM bookself/setup.bat
REM One-command setup script for Windows.
REM
REM What this does:
REM   1. Checks that Python is available
REM   2. Creates a virtual environment (.venv) inside this folder
REM   3. Installs all dependencies from requirements.txt
REM   4. Tells you what to do next
REM
REM Usage:
REM   Double-click setup.bat, OR run it in Command Prompt / PowerShell
REM ─────────────────────────────────────────────────────────────────

echo.
echo  ╔══════════════════════════════════════╗
echo  ║       BookSelf - Setup Script        ║
echo  ╚══════════════════════════════════════╝
echo.

REM ── Check Python ─────────────────────────────────────────────────
python --version >nul 2>&1
if errorlevel 1 (
    echo X  Python not found.
    echo    Please install Python 3.10 or newer from https://www.python.org
    echo    Make sure to check "Add Python to PATH" during installation.
    pause
    exit /b 1
)

for /f "tokens=2" %%v in ('python --version') do set PYTHON_VERSION=%%v
echo OK Python %PYTHON_VERSION% found

REM ── Create virtual environment ────────────────────────────────────
if not exist ".venv" (
    echo.
    echo  Creating virtual environment (.venv^)...
    python -m venv .venv
    if errorlevel 1 (
        echo X  Failed to create virtual environment.
        pause
        exit /b 1
    )
    echo OK Virtual environment created
) else (
    echo OK Virtual environment already exists -- skipping creation
)

REM ── Install dependencies ──────────────────────────────────────────
echo.
echo  Installing dependencies (this may take a minute^)...
.venv\Scripts\pip install --upgrade pip --quiet

.venv\Scripts\pip install -r requirements.txt --quiet
if errorlevel 1 (
    echo.
    echo  Warning: Some packages may have failed (lxml is common on newer Python^).
    echo  Trying without lxml...
    .venv\Scripts\pip install google-auth google-auth-oauthlib google-auth-httplib2 ^
        google-api-python-client flask pyyaml beautifulsoup4 requests --quiet
    if errorlevel 1 (
        echo X  Dependency installation failed. See error above.
        pause
        exit /b 1
    )
    echo OK Dependencies installed (without lxml -- html.parser will be used^)
) else (
    echo OK All dependencies installed
)

REM ── Check for credentials.json ────────────────────────────────────
echo.
if exist "credentials.json" (
    echo OK credentials.json found -- you're ready to sync!
) else (
    echo WARNING: credentials.json not found.
    echo    Copy your Google OAuth credentials file into this folder.
    echo    File name must be exactly: credentials.json
    echo    (See README.md for Google Cloud Console setup instructions^)
)

REM ── Done ──────────────────────────────────────────────────────────
echo.
echo  ╔══════════════════════════════════════╗
echo  ║           Setup complete!            ║
echo  ╚══════════════════════════════════════╝
echo.
echo  Next steps:
echo.
echo    1. Activate the environment:
echo       .venv\Scripts\activate
echo.
echo    2. Pull your newsletters from Gmail:
echo       python fetch.py
echo       (A browser will open for Google login on first run^)
echo.
echo    3. Open the reading app:
echo       python app.py
echo.
pause
