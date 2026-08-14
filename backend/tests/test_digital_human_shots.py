from digital_human_service import InvalidTalkingVideo
from digital_human_shots import (
    effective_shot_duration_bounds,
    new_blank_shot,
    normalize_shots,
    script_from_shots,
)
import pytest


def test_effective_bounds_intersect_settings_and_workflow():
    assert effective_shot_duration_bounds(4, 5, 4, 15) == (4, 5)
    assert effective_shot_duration_bounds(1, 8, 4, 6) == (4, 6)
    with pytest.raises(InvalidTalkingVideo):
        effective_shot_duration_bounds(10, 12, 4, 5)


def test_normalize_shots_rewrites_script_and_rejects_overlong():
    shots = normalize_shots(
        [
            {
                "spoken_text": "第一句",
                "duration_sec": 4,
                "framing": "medium",
            },
            {
                "id": "shot-2",
                "spoken_text": "第二句",
                "duration_sec": 5,
                "framing": "close",
            },
        ],
        4,
        5,
    )
    assert shots[0]["spoken_text"] == "第一句"
    assert shots[1]["id"] == "shot-2"
    assert script_from_shots(shots) == "第一句\n\n第二句"
    with pytest.raises(InvalidTalkingVideo, match="4–5"):
        normalize_shots(
            [new_blank_shot(8)],
            4,
            5,
        )
