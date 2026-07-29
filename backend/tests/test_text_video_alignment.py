from itertools import product
import math
import tracemalloc

import pytest

from text_video_alignment import (
    AlignmentError,
    _ProviderAtom,
    _lcs_matches,
    align_transcript_words,
    build_global_timeline,
    tokenize_script,
    validate_word_timings,
)


def test_tokenization_preserves_exact_script_and_stable_speakable_units():
    tokens = tokenize_script("  「做 AI 2 视频」，好！\n")

    assert [token.text for token in tokens] == [
        "  「做 ",
        "AI ",
        "2 ",
        "视",
        "频」，",
        "好！\n",
    ]
    assert [token.normalized for token in tokens] == [
        "做",
        "ai",
        "2",
        "视",
        "频",
        "好",
    ]
    assert "".join(token.text for token in tokens) == "  「做 AI 2 视频」，好！\n"
    assert [token.id for token in tokens] == [
        "word-3-4",
        "word-5-7",
        "word-8-9",
        "word-10-11",
        "word-11-12",
        "word-14-15",
    ]


def test_transcript_alignment_keeps_exact_script_slices_and_requires_85_percent_coverage():
    transcript_words = [
        {"word": "做", "start": 0.0, "end": 0.2},
        {"word": "AI", "start": 0.2, "end": 0.7},
        {"word": "视频", "start": 0.7, "end": 1.2},
        {"word": "的", "start": 1.2, "end": 1.4},
        {"word": "一个月", "start": 1.6, "end": 2.2},
        {"word": "没", "start": 2.2, "end": 2.5},
        {"word": "赚到钱", "start": 2.5, "end": 3.4},
    ]

    aligned = align_transcript_words(
        script="做 AI 视频的，一个月没赚到钱。",
        transcript_words=transcript_words,
        master_duration=4.2,
        minimum_coverage=0.85,
    )

    assert "".join(item["text"] for item in aligned) == "做 AI 视频的，一个月没赚到钱。"
    assert all(0 <= item["start"] < item["end"] <= 4.2 for item in aligned)
    with pytest.raises(AlignmentError, match="逐字对齐置信度不足"):
        align_transcript_words(
            "完全不同的稿件",
            transcript_words,
            4.2,
            0.85,
        )


def test_exact_85_percent_coverage_is_accepted_and_below_is_rejected():
    script = "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申亥"
    seventeen = [
        {"word": character, "start": index / 10, "end": (index + 1) / 10}
        for index, character in enumerate(script[:17])
    ]

    aligned = align_transcript_words(script, seventeen, 2.0)

    assert "".join(item["text"] for item in aligned) == script
    with pytest.raises(AlignmentError, match="逐字对齐置信度不足"):
        align_transcript_words(script, seventeen[:-1], 2.0)


def test_aggregated_cjk_words_are_atomized_and_repeated_tokens_are_deterministic():
    words = [
        {"word": "甲乙甲", "start": 0.0, "end": 0.9},
        {"word": "乙", "start": 0.9, "end": 1.2},
    ]

    first = align_transcript_words("甲乙甲乙", words, 1.2)
    second = align_transcript_words("甲乙甲乙", words, 1.2)

    assert first == second
    assert [item["text"] for item in first] == ["甲", "乙", "甲", "乙"]
    assert [item["start"] for item in first] == pytest.approx(
        [0.0, 0.3, 0.6, 0.9],
    )
    assert [item["end"] for item in first] == pytest.approx(
        [0.3, 0.6, 0.9, 1.2],
    )


def test_repeated_token_tie_break_matches_the_earliest_expected_token():
    aligned = align_transcript_words(
        "甲乙甲",
        [{"word": "甲", "start": 0.6, "end": 0.9}],
        1.2,
        minimum_coverage=0.3,
    )

    assert aligned[0]["start"] == 0.6
    assert aligned[0]["end"] == 0.9


def test_one_expected_latin_token_can_match_multiple_provider_words():
    aligned = align_transcript_words(
        "OpenAI",
        [
            {"word": "Open", "start": 0, "end": 0.8},
            {"word": "AI", "start": 0.8, "end": 1.2},
        ],
        1.2,
    )

    assert aligned == [{
        "id": "word-0-6",
        "text": "OpenAI",
        "start": 0.0,
        "end": 1.2,
    }]


def test_unmatched_token_without_a_timing_gap_fails_closed():
    with pytest.raises(AlignmentError, match="无法插值"):
        align_transcript_words(
            "甲乙丙",
            [
                {"word": "甲", "start": 0.0, "end": 0.5},
                {"word": "丙", "start": 0.5, "end": 1.0},
            ],
            1.0,
            minimum_coverage=0.6,
        )


def test_unmatched_leading_token_without_space_fails_closed():
    with pytest.raises(AlignmentError, match="无法插值"):
        align_transcript_words(
            "甲乙",
            [{"word": "乙", "start": 0.0, "end": 1.0}],
            1.0,
            minimum_coverage=0.5,
        )


def test_one_sample_trailing_gap_is_preserved_in_sample_domain():
    aligned = align_transcript_words(
        "甲乙",
        [{"word": "甲", "start": 0.0, "end": 0.9}],
        1.0,
        minimum_coverage=0.5,
        sample_rate=10,
        master_sample_count=10,
    )

    assert [(item["start"], item["end"]) for item in aligned] == [
        (0.0, 0.9),
        (0.9, 1.0),
    ]


def test_provider_aggregation_divides_an_odd_sample_span_deterministically():
    aligned = align_transcript_words(
        "甲乙",
        [{"word": "甲乙", "start": 0.0, "end": 0.5}],
        0.5,
        sample_rate=10,
        master_sample_count=5,
    )

    assert [(item["start"], item["end"]) for item in aligned] == [
        (0.0, 0.2),
        (0.2, 0.5),
    ]


def test_extra_provider_words_do_not_reduce_expected_token_coverage():
    aligned = align_transcript_words(
        "甲",
        [{"word": "噪甲声", "start": 0.0, "end": 0.9}],
        0.9,
        sample_rate=10,
        master_sample_count=9,
    )

    assert aligned == [{
        "id": "word-0-1",
        "text": "甲",
        "start": 0.3,
        "end": 0.6,
    }]


def test_punctuation_only_speech_segment_is_rejected_explicitly():
    with pytest.raises(AlignmentError, match="不包含可朗读"):
        align_transcript_words(
            "甲，。乙",
            [
                {"word": "甲", "start": 0, "end": 0.3},
                {"word": "乙", "start": 0.3, "end": 0.6},
            ],
            0.6,
            speech_segments=[
                {"id": "a", "text": "甲"},
                {"id": "punctuation", "text": "，。"},
                {"id": "b", "text": "乙"},
            ],
        )


def test_local_timings_align_each_exact_segment_before_sample_offset():
    words = build_global_timeline(
        script="OpenAI甲乙",
        segments=[
            {
                "id": "a",
                "text": "Open",
                "sample_count": 44100,
                "word_timings": [{
                    "id": "a-provider",
                    "text": "Open",
                    "start": 0.1,
                    "end": 0.8,
                }],
            },
            {
                "id": "b",
                "text": "AI甲乙",
                "sample_count": 66150,
                "word_timings": [
                    {
                        "id": "b-provider-1",
                        "text": "AI",
                        "start": 0.0,
                        "end": 0.4,
                    },
                    {
                        "id": "b-provider-2",
                        "text": "甲乙",
                        "start": 0.4,
                        "end": 1.0,
                    },
                ],
            },
        ],
        offsets={"a": 0, "b": 44100},
        master_duration=2.5,
        sample_rate=44100,
        master_sample_count=110250,
    )

    assert "".join(item["text"] for item in words) == "OpenAI甲乙"
    assert [item["speech_segment_id"] for item in words] == [
        "a",
        "b",
        "b",
        "b",
    ]
    assert [item["text"] for item in words] == ["Open", "AI", "甲", "乙"]
    assert [item["start"] for item in words] == pytest.approx(
        [0.1, 1.0, 1.4, 1.7],
    )
    assert [item["end"] for item in words] == pytest.approx(
        [0.8, 1.4, 1.7, 2.0],
    )


def test_forced_alignment_respects_legal_latin_split_boundaries():
    aligned = align_transcript_words(
        "OpenAI",
        [{"word": "OpenAI", "start": 0, "end": 1.2}],
        1.2,
        speech_segments=[
            {"id": "a", "text": "Open"},
            {"id": "b", "text": "AI"},
        ],
    )

    assert [(item["text"], item["speech_segment_id"]) for item in aligned] == [
        ("Open", "a"),
        ("AI", "b"),
    ]
    assert [item["start"] for item in aligned] == pytest.approx([0.0, 0.8])
    assert [item["end"] for item in aligned] == pytest.approx([0.8, 1.2])


def test_forced_and_local_alignment_use_the_same_exact_segment_slices():
    script = "Open， AI！"
    speech_segments = [
        {"id": "a", "text": "Open"},
        {"id": "b", "text": "， AI！"},
    ]
    forced = align_transcript_words(
        script,
        [
            {"word": "Open", "start": 0, "end": 1},
            {"word": "AI", "start": 1, "end": 2},
        ],
        2,
        speech_segments=speech_segments,
        sample_rate=10,
        master_sample_count=20,
    )
    local = build_global_timeline(
        script=script,
        segments=[
            {
                **speech_segments[0],
                "sample_count": 10,
                "word_timings": [
                    {"word": "Open", "start": 0, "end": 1},
                ],
            },
            {
                **speech_segments[1],
                "sample_count": 10,
                "word_timings": [
                    {"word": "AI", "start": 0, "end": 1},
                ],
            },
        ],
        offsets={"a": 0, "b": 10},
        master_duration=2,
        sample_rate=10,
        master_sample_count=20,
    )

    expected = [
        ("word-0-4", "Open", "a"),
        ("word-6-8", "， AI！", "b"),
    ]
    assert [
        (word["id"], word["text"], word["speech_segment_id"])
        for word in forced
    ] == expected
    assert [
        (word["id"], word["text"], word["speech_segment_id"])
        for word in local
    ] == expected
    assert "".join(word["text"] for word in forced) == script
    assert "".join(word["text"] for word in local) == script


def test_combining_marks_share_the_base_span_and_match_composed_provider_text():
    script = "Cafe\u0301は\u3099"
    tokens = tokenize_script(script)

    assert [
        (
            token.id,
            token.text,
            token.normalized,
            token.start_char,
            token.end_char,
        )
        for token in tokens
    ] == [
        ("word-0-5", "Cafe\u0301", "café", 0, 5),
        ("word-5-7", "は\u3099", "ば", 5, 7),
    ]

    aligned = align_transcript_words(
        script,
        [
            {"word": "Café", "start": 0, "end": 1},
            {"word": "ば", "start": 1, "end": 2},
        ],
        2,
        speech_segments=[
            {"id": "latin", "text": "Cafe\u0301"},
            {"id": "japanese", "text": "は\u3099"},
        ],
        sample_rate=10,
        master_sample_count=20,
    )

    assert [
        (word["id"], word["text"], word["speech_segment_id"])
        for word in aligned
    ] == [
        ("word-0-5", "Cafe\u0301", "latin"),
        ("word-5-7", "は\u3099", "japanese"),
    ]


def test_combining_mark_never_crosses_a_speech_segment_boundary():
    aligned = align_transcript_words(
        "e\u0301x",
        [
            {"word": "e", "start": 0, "end": 0.5},
            {"word": "x", "start": 0.5, "end": 1},
        ],
        1,
        speech_segments=[
            {"id": "a", "text": "e"},
            {"id": "b", "text": "\u0301x"},
        ],
        sample_rate=10,
        master_sample_count=10,
    )

    assert [
        (word["id"], word["text"], word["speech_segment_id"])
        for word in aligned
    ] == [
        ("word-0-1", "e", "a"),
        ("word-2-3", "\u0301x", "b"),
    ]


def test_japanese_combining_mark_at_segment_start_is_not_a_standalone_token():
    aligned = align_transcript_words(
        "は\u3099x",
        [
            {"word": "は", "start": 0, "end": 0.5},
            {"word": "x", "start": 0.5, "end": 1},
        ],
        1,
        speech_segments=[
            {"id": "a", "text": "は"},
            {"id": "b", "text": "\u3099x"},
        ],
        sample_rate=10,
        master_sample_count=10,
    )

    assert [
        (word["id"], word["text"], word["speech_segment_id"])
        for word in aligned
    ] == [
        ("word-0-1", "は", "a"),
        ("word-2-3", "\u3099x", "b"),
    ]


def test_local_timing_is_quantized_to_integer_samples_before_offset():
    words = build_global_timeline(
        script="甲",
        segments=[{
            "id": "a",
            "text": "甲",
            "sample_count": 44100,
            "word_timings": [{
                "id": "provider",
                "text": "甲",
                "start": 0.10001,
                "end": 0.80001,
            }],
        }],
        offsets={"a": 0},
        master_duration=1.0,
        sample_rate=44100,
        master_sample_count=44100,
    )

    assert words[0]["start"] == 4410 / 44100
    assert words[0]["end"] == 35280 / 44100


def test_master_duration_cannot_disagree_with_sample_metadata():
    with pytest.raises(AlignmentError, match="sample metadata"):
        build_global_timeline(
            script="甲",
            segments=[{
                "id": "a",
                "text": "甲",
                "sample_count": 44100,
                "word_timings": [{
                    "id": "provider",
                    "text": "甲",
                    "start": 0.1,
                    "end": 0.8,
                }],
            }],
            offsets={"a": 0},
            master_duration=1.1,
            sample_rate=44100,
            master_sample_count=44100,
        )


@pytest.mark.parametrize(
    "words",
    [
        [],
        [{"word": "甲", "start": True, "end": 0.2}],
        [{"word": "甲", "start": "0", "end": 0.2}],
        [{"word": "甲", "start": 0, "end": "0.2"}],
        [{"word": "甲", "start": math.nan, "end": 0.2}],
        [{"word": "甲", "start": 0, "end": math.inf}],
        [{"word": "甲", "start": -0.1, "end": 0.2}],
        [{"word": "甲", "start": 0.2, "end": 0.2}],
        [
            {"word": "甲", "start": 0, "end": 0.7},
            {"word": "乙", "start": 0.6, "end": 0.9},
        ],
        [{"word": "甲", "start": 0, "end": 1.1}],
        [{"word": "", "start": 0, "end": 0.2}],
    ],
)
def test_word_timing_validation_rejects_empty_or_malformed_words(words):
    with pytest.raises(AlignmentError, match="word"):
        validate_word_timings(words, 1.0)


def test_alignment_rejects_punctuation_only_script():
    with pytest.raises(AlignmentError, match="可朗读"):
        align_transcript_words(
            " \n，。！",
            [{"word": "啊", "start": 0, "end": 0.2}],
            0.2,
        )


def _reference_lcs_matches(expected, actual):
    rows = len(expected)
    columns = len(actual)
    lengths = [[0] * (columns + 1) for _ in range(rows + 1)]
    for left in range(rows - 1, -1, -1):
        for right in range(columns - 1, -1, -1):
            if expected[left] == actual[right].normalized:
                lengths[left][right] = 1 + lengths[left + 1][right + 1]
            else:
                lengths[left][right] = max(
                    lengths[left + 1][right],
                    lengths[left][right + 1],
                )
    matches = []
    left = right = 0
    while left < rows and right < columns:
        if (
            expected[left] == actual[right].normalized
            and lengths[left][right] == 1 + lengths[left + 1][right + 1]
        ):
            matches.append((left, right))
            left += 1
            right += 1
        elif lengths[left + 1][right] > lengths[left][right + 1]:
            left += 1
        else:
            right += 1
    return matches


def _atoms(characters):
    return [
        _ProviderAtom(
            normalized=character,
            start_sample=index,
            end_sample=index + 1,
        )
        for index, character in enumerate(characters)
    ]


def test_linear_lcs_is_exactly_equivalent_to_reference_tie_breaking():
    sequences = [
        "".join(characters)
        for length in range(5)
        for characters in product("ab", repeat=length)
    ]

    for expected in sequences:
        for actual_text in sequences:
            actual = _atoms(actual_text)
            assert _lcs_matches(expected, actual) == _reference_lcs_matches(
                expected,
                actual,
            ), (expected, actual_text)


def test_lcs_peak_memory_is_linear_in_sequence_width():
    expected = "ab" * 300
    actual = _atoms("ba" * 300)

    tracemalloc.start()
    matches = _lcs_matches(expected, actual)
    _current, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    assert len(matches) == 599
    assert peak < 1_000_000


def test_lcs_handles_more_than_five_thousand_identical_tokens():
    expected = ["甲"] * 5_001
    actual = _atoms(["甲"] * 5_001)

    matches = _lcs_matches(expected, actual)

    assert len(matches) == 5_001
    assert matches[0] == (0, 0)
    assert matches[-1] == (5_000, 5_000)
