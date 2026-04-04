# ─────────────────────────────────────────────────────────────────
# bookself/config_loader.py
#
# Reads and validates config.yaml.
# Every other module calls this to get the app's settings.
#
# If something is wrong in config.yaml (missing field, wrong format),
# this module raises a clear error message so you know exactly what to fix.
# ─────────────────────────────────────────────────────────────────

import yaml
from pathlib import Path


def get_project_root():
    """
    Returns the absolute path to the bookself project folder.

    This always works correctly regardless of where you run Python from,
    because it calculates the path relative to THIS file's location —
    not relative to the current working directory.

    Example: If this file is at /home/user/bookself/bookself/config_loader.py,
    the project root is /home/user/bookself/
    """
    # __file__ is this file. .parent is bookself/bookself/. .parent again is bookself/
    return Path(__file__).parent.parent


def load_config(config_path=None):
    """
    Load and validate the config.yaml file.

    Args:
        config_path: Optional. If not provided, looks for config.yaml
                     in the project root folder automatically.

    Returns:
        dict: The full config as a Python dictionary.

    Raises:
        FileNotFoundError: If config.yaml doesn't exist.
        ValueError: If required fields are missing from a source entry.
    """
    if config_path is None:
        config_path = get_project_root() / 'config.yaml'

    config_path = Path(config_path)

    if not config_path.exists():
        raise FileNotFoundError(
            f"\n❌  config.yaml not found at: {config_path}\n"
            "    Make sure it exists in the project root folder."
        )

    with open(config_path, 'r', encoding='utf-8') as f:
        config = yaml.safe_load(f)

    # ── Validate top-level structure ──────────────────────────────
    if 'settings' not in config:
        raise ValueError("config.yaml is missing the 'settings:' section.")
    if 'sources' not in config:
        raise ValueError("config.yaml is missing the 'sources:' section.")
    if not config['sources']:
        raise ValueError("config.yaml has no sources defined. Add at least one newsletter source.")

    # ── Validate each source entry ────────────────────────────────
    required_fields = ['name', 'folder', 'sender', 'type']

    for i, source in enumerate(config['sources']):
        for field in required_fields:
            if field not in source:
                raise ValueError(
                    f"Source #{i + 1} ('{source.get('name', 'unnamed')}') in config.yaml "
                    f"is missing required field: '{field}'"
                )

        if source['type'] not in ('simple', 'series'):
            raise ValueError(
                f"Source '{source['name']}' has unknown type: '{source['type']}'. "
                "Must be 'simple' or 'series'."
            )

        if source['type'] == 'series' and 'series_detection' not in source:
            raise ValueError(
                f"Source '{source['name']}' has type=series but is missing 'series_detection:'"
            )

    return config


def get_db_path(config):
    """
    Returns the absolute Path to the SQLite database file.
    Computed from the project root — never hardcoded.
    """
    db_filename = config['settings'].get('db_path', 'bookself.db')
    return get_project_root() / db_filename


def get_newsletters_dir(config):
    """
    Returns the absolute Path to the newsletters/ storage folder.
    This is where downloaded HTML files are saved.
    """
    dir_name = config['settings'].get('newsletters_dir', 'newsletters')
    return get_project_root() / dir_name


def get_assets_dir(config):
    """
    Returns the absolute Path to the assets/ folder.
    This is where extracted images from newsletters are saved.
    """
    dir_name = config['settings'].get('assets_dir', 'assets')
    return get_project_root() / dir_name
