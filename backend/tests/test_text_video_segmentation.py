import pytest

from text_video_segmentation import (
    SegmentationError,
    build_boundary_candidates,
    slice_at_boundary_ids,
)


def test_candidates_are_stable_and_slicing_preserves_the_exact_script():
    script = "第一句。\n第二句，后半句。"
    first = build_boundary_candidates(script)
    second = build_boundary_candidates(script)

    assert [item.id for item in first] == [item.id for item in second]
    chosen = [item.id for item in first if item.kind in {"sentence", "newline"}]
    slices = slice_at_boundary_ids(script, first, chosen)

    assert "".join(slices) == script
    assert all(segment.strip() for segment in slices)


def test_unknown_or_unordered_boundary_ids_are_rejected():
    with pytest.raises(SegmentationError, match="无效的分段边界"):
        slice_at_boundary_ids(
            "甲。乙。",
            build_boundary_candidates("甲。乙。"),
            ["missing"],
        )


def test_whitespace_after_a_boundary_stays_with_the_preceding_slice():
    script = "甲。  乙。"
    candidates = build_boundary_candidates(script)
    sentence = next(item for item in candidates if item.kind == "sentence")

    assert slice_at_boundary_ids(script, candidates, [sentence.id]) == ["甲。  ", "乙。"]
