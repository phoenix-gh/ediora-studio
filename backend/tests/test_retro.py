"""Unit tests for the retro session-candidate parser."""
from routers.retro import parse_session_candidates

# A real `hermes sessions list` shape. The "Last Active" column is free-form
# ("2h ago", "yesterday"), which is exactly why parsing is regex-based.
SAMPLE = """Preview                                            Last Active   Src    ID
────────────────────────────────────────────────────────────────────────────
work kanban task t_a6b4d802                        2h ago        cli    20260530_113045_252a34
work kanban task t_fb4c8783                        20h ago       cli    20260529_172728_62066b
work kanban task t_de310ed1                        yesterday     cli    20260529_132037_900605
work kanban task t_de310ed1                        yesterday     cli    20260529_131937_aa94eb
"""


def test_single_match_returns_one_session():
    out = parse_session_candidates(SAMPLE, "t_a6b4d802")
    assert [c["session_id"] for c in out] == ["20260530_113045_252a34"]
    assert "t_a6b4d802" in out[0]["label"]


def test_multiple_runs_kept_newest_first():
    out = parse_session_candidates(SAMPLE, "t_de310ed1")
    assert [c["session_id"] for c in out] == [
        "20260529_132037_900605",
        "20260529_131937_aa94eb",
    ]


def test_unknown_task_returns_empty():
    assert parse_session_candidates(SAMPLE, "t_deadbeef") == []


def test_header_row_has_no_session_id():
    # "Preview" only appears in the header, which carries no session id.
    assert parse_session_candidates(SAMPLE, "Preview") == []
