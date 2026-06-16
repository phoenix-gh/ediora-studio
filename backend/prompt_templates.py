"""Load prompt fragments from markdown files so the rule *text* can be edited
without touching Python.

Read each call (no cache): enqueue is infrequent, and reading fresh means a
markdown edit takes effect on the next enqueue without restarting the backend.
"""
from pathlib import Path

_PROMPTS_DIR = Path(__file__).parent / "prompts"


def load(rel: str) -> str:
    """Return the stripped contents of prompts/<rel> (e.g. 'writer/wording_rules.md')."""
    return (_PROMPTS_DIR / rel).read_text(encoding="utf-8").strip()


def render(rel: str, **values: object) -> str:
    """load() then substitute {{key}} placeholders with the given values."""
    text = load(rel)
    for key, value in values.items():
        text = text.replace("{{" + key + "}}", str(value))
    return text
