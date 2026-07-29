"""Exact-script word tokenization and sample-bounded speech alignment."""

from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction
import math
import unicodedata
from typing import Any, Sequence


class AlignmentError(ValueError):
    """Raised when provider timing cannot safely align to the exact script."""


@dataclass(frozen=True)
class ScriptToken:
    id: str
    text: str
    normalized: str
    start_char: int
    end_char: int
    speech_segment_id: str = ""


@dataclass(frozen=True)
class _ProviderAtom:
    normalized: str
    start_sample: int
    end_sample: int


def _is_cjk(character: str) -> bool:
    codepoint = ord(character)
    return bool(
        0x1100 <= codepoint <= 0x11FF
        or 0x2E80 <= codepoint <= 0x2FFF
        or 0x3040 <= codepoint <= 0x30FF
        or 0x3130 <= codepoint <= 0x318F
        or 0x31A0 <= codepoint <= 0x31BF
        or 0x3400 <= codepoint <= 0x4DBF
        or 0x4E00 <= codepoint <= 0x9FFF
        or 0xAC00 <= codepoint <= 0xD7AF
        or 0xF900 <= codepoint <= 0xFAFF
        or 0x20000 <= codepoint <= 0x3134F
    )


def _normalize(value: str) -> str:
    return unicodedata.normalize("NFKC", value).casefold()


def _is_combining_mark(character: str) -> bool:
    return unicodedata.category(character).startswith("M")


def _tokenize_with_boundaries(
    script: str,
    boundaries: Sequence[tuple[int, int, str]],
) -> list[ScriptToken]:
    owners = [""] * len(script)
    boundary_starts = [0] * len(script)
    boundary_ends = [len(script)] * len(script)
    for start, end, owner in boundaries:
        owners[start:end] = [owner] * (end - start)
        boundary_starts[start:end] = [start] * (end - start)
        boundary_ends[start:end] = [end] * (end - start)

    units: list[tuple[int, int, str, str, int, int]] = []
    index = 0
    while index < len(script):
        character = script[index]
        if _is_combining_mark(character):
            index += 1
            continue
        if _is_cjk(character):
            owner = owners[index]
            end = index + 1
            while (
                end < len(script)
                and owners[end] == owner
                and _is_combining_mark(script[end])
            ):
                end += 1
            units.append((
                index,
                end,
                _normalize(script[index:end]),
                owner,
                boundary_starts[index],
                boundary_ends[index],
            ))
            index = end
            continue
        if character.isalnum():
            owner = owners[index]
            end = index + 1
            while (
                end < len(script)
                and owners[end] == owner
                and (
                    (
                        script[end].isalnum()
                        and not _is_cjk(script[end])
                    )
                    or _is_combining_mark(script[end])
                )
            ):
                end += 1
            units.append((
                index,
                end,
                _normalize(script[index:end]),
                owner,
                boundary_starts[index],
                boundary_ends[index],
            ))
            index = end
            continue
        index += 1

    result: list[ScriptToken] = []
    for unit_index, (
        start,
        end,
        normalized,
        owner,
        boundary_start,
        boundary_end,
    ) in enumerate(units):
        previous = units[unit_index - 1] if unit_index else None
        following = (
            units[unit_index + 1]
            if unit_index + 1 < len(units)
            else None
        )
        text_start = (
            boundary_start
            if previous is None
            or previous[4:6] != (boundary_start, boundary_end)
            else start
        )
        text_end = (
            following[0]
            if following is not None
            and following[4:6] == (boundary_start, boundary_end)
            else boundary_end
        )
        result.append(ScriptToken(
            id=f"word-{start}-{end}",
            text=script[text_start:text_end],
            normalized=normalized,
            start_char=start,
            end_char=end,
            speech_segment_id=owner,
        ))
    return result


def tokenize_script(script: str) -> list[ScriptToken]:
    script = str(script or "")
    return _tokenize_with_boundaries(script, [(0, len(script), "")])


def _expected_tokens(
    script: str,
    speech_segments: Sequence[dict[str, Any]] | None,
) -> list[ScriptToken]:
    if speech_segments is None:
        return tokenize_script(script)
    position = 0
    boundaries: list[tuple[int, int, str]] = []
    reconstructed = ""
    seen: set[str] = set()
    for raw in speech_segments:
        if not isinstance(raw, dict):
            raise AlignmentError("口播分段格式无效")
        segment_id = raw.get("id")
        text = raw.get("text")
        if (
            not isinstance(segment_id, str)
            or not segment_id
            or segment_id in seen
            or not isinstance(text, str)
        ):
            raise AlignmentError("口播分段格式无效")
        end = position + len(text)
        boundaries.append((position, end, segment_id))
        if text and not _tokenize_with_boundaries(
            text,
            [(0, len(text), segment_id)],
        ):
            raise AlignmentError(
                f"口播分段 {segment_id} 不包含可朗读内容",
            )
        position = end
        reconstructed += text
        seen.add(segment_id)
    if reconstructed != script:
        raise AlignmentError("口播分段必须无损还原完整稿件")
    return _tokenize_with_boundaries(script, boundaries)


def validate_word_timings(
    words: Sequence[dict[str, Any]] | None,
    duration: float,
) -> list[dict[str, Any]]:
    if (
        isinstance(duration, bool)
        or not isinstance(duration, (int, float))
        or not math.isfinite(float(duration))
        or duration <= 0
    ):
        raise AlignmentError("word timing duration 无效")
    if not isinstance(words, Sequence) or isinstance(words, (str, bytes)) or not words:
        raise AlignmentError("word timings 不能为空")

    result: list[dict[str, Any]] = []
    previous_end = 0.0
    for index, raw in enumerate(words):
        if not isinstance(raw, dict):
            raise AlignmentError("word timing 必须是对象")
        text = raw.get("word")
        if not isinstance(text, str):
            text = raw.get("text")
        start_value = raw.get("start")
        end_value = raw.get("end")
        if (
            not isinstance(text, str)
            or not text
            or isinstance(start_value, bool)
            or not isinstance(start_value, (int, float))
            or isinstance(end_value, bool)
            or not isinstance(end_value, (int, float))
        ):
            raise AlignmentError("word timing 内容无效")
        start = float(start_value)
        end = float(end_value)
        if (
            not math.isfinite(start)
            or not math.isfinite(end)
            or start < 0
            or end <= start
            or start + 1e-9 < previous_end
            or end > float(duration) + 1e-6
        ):
            raise AlignmentError("word timing 范围无效")
        result.append({
            "id": str(raw.get("id") or f"provider-{index + 1}"),
            "text": text,
            "start": start,
            "end": end,
        })
        previous_end = end
    return result


def _provider_atoms(
    words: Sequence[dict[str, Any]],
    duration: float,
    *,
    sample_rate: int,
    sample_count: int,
) -> list[_ProviderAtom]:
    validated = validate_word_timings(words, duration)
    atoms: list[_ProviderAtom] = []
    previous_end = 0
    for word in validated:
        provider_tokens = tokenize_script(word["text"])
        characters = [
            character
            for token in provider_tokens
            for character in token.normalized
        ]
        start_sample = round(float(word["start"]) * sample_rate)
        end_sample = round(float(word["end"]) * sample_rate)
        if (
            start_sample < previous_end
            or start_sample < 0
            or end_sample <= start_sample
            or end_sample > sample_count
            or (characters and end_sample - start_sample < len(characters))
        ):
            raise AlignmentError("word timing 无法量化到有效 samples")
        cursor = start_sample
        word_span = end_sample - start_sample
        for index, character in enumerate(characters):
            end_sample_for_atom = (
                end_sample
                if index == len(characters) - 1
                else (
                    start_sample
                    + word_span * (index + 1) // len(characters)
                )
            )
            atoms.append(_ProviderAtom(
                normalized=character,
                start_sample=cursor,
                end_sample=end_sample_for_atom,
            ))
            cursor = end_sample_for_atom
        previous_end = end_sample
    if not atoms:
        raise AlignmentError("word timings 不包含可朗读内容")
    return atoms


def _lcs_matches(
    expected: Sequence[str],
    actual: Sequence[_ProviderAtom],
) -> list[tuple[int, int]]:
    matches: list[tuple[int, int]] = []

    def canonical_crossing(
        expected_start: int,
        expected_middle: int,
        expected_end: int,
        actual_start: int,
        actual_end: int,
    ) -> int:
        """Find where the canonical suffix-DP path first reaches middle."""

        width = actual_end - actual_start
        next_lengths = [0] * (width + 1)
        for left in range(expected_end - 1, expected_middle - 1, -1):
            current_lengths = [0] * (width + 1)
            for local_right in range(width - 1, -1, -1):
                right = actual_start + local_right
                if expected[left] == actual[right].normalized:
                    current_lengths[local_right] = (
                        1 + next_lengths[local_right + 1]
                    )
                else:
                    current_lengths[local_right] = max(
                        next_lengths[local_right],
                        current_lengths[local_right + 1],
                    )
            next_lengths = current_lengths

        next_crossings = list(range(actual_start, actual_end + 1))
        for left in range(expected_middle - 1, expected_start - 1, -1):
            current_lengths = [0] * (width + 1)
            current_crossings = [actual_end] * (width + 1)
            for local_right in range(width - 1, -1, -1):
                right = actual_start + local_right
                if expected[left] == actual[right].normalized:
                    current_lengths[local_right] = (
                        1 + next_lengths[local_right + 1]
                    )
                    current_crossings[local_right] = (
                        next_crossings[local_right + 1]
                    )
                elif (
                    next_lengths[local_right]
                    > current_lengths[local_right + 1]
                ):
                    current_lengths[local_right] = next_lengths[local_right]
                    current_crossings[local_right] = (
                        next_crossings[local_right]
                    )
                else:
                    current_lengths[local_right] = (
                        current_lengths[local_right + 1]
                    )
                    current_crossings[local_right] = (
                        current_crossings[local_right + 1]
                    )
            next_lengths = current_lengths
            next_crossings = current_crossings
        return next_crossings[0]

    def recover(
        expected_start: int,
        expected_end: int,
        actual_start: int,
        actual_end: int,
    ) -> None:
        while (
            expected_start < expected_end
            and actual_start < actual_end
            and expected[expected_start] == actual[actual_start].normalized
        ):
            matches.append((expected_start, actual_start))
            expected_start += 1
            actual_start += 1
        if expected_start >= expected_end or actual_start >= actual_end:
            return
        if expected_end - expected_start == 1:
            for right in range(actual_start, actual_end):
                if expected[expected_start] == actual[right].normalized:
                    matches.append((expected_start, right))
                    return
            return
        if actual_end - actual_start == 1:
            for left in range(expected_start, expected_end):
                if expected[left] == actual[actual_start].normalized:
                    matches.append((left, actual_start))
                    return
            return

        expected_middle = (expected_start + expected_end) // 2
        actual_middle = canonical_crossing(
            expected_start,
            expected_middle,
            expected_end,
            actual_start,
            actual_end,
        )
        recover(
            expected_start,
            expected_middle,
            actual_start,
            actual_middle,
        )
        recover(
            expected_middle,
            expected_end,
            actual_middle,
            actual_end,
        )

    recover(0, len(expected), 0, len(actual))
    return matches


def _interpolate_missing(
    ranges: list[tuple[int, int] | None],
    expected: Sequence[ScriptToken],
    sample_count: int,
) -> list[tuple[int, int]]:
    matched = [index for index, value in enumerate(ranges) if value is not None]
    if not matched:
        raise AlignmentError("逐字对齐置信度不足")
    anchors = [-1, *matched, len(ranges)]
    for anchor_index in range(len(anchors) - 1):
        left = anchors[anchor_index]
        right = anchors[anchor_index + 1]
        missing = right - left - 1
        if missing <= 0:
            continue
        start = 0 if left < 0 else ranges[left][1]  # type: ignore[index]
        end = sample_count if right == len(ranges) else ranges[right][0]  # type: ignore[index]
        span = max(0, end - start)
        weights = [
            max(1, len(expected[index].normalized))
            for index in range(left + 1, right)
        ]
        total_weight = sum(weights)
        if span < total_weight:
            raise AlignmentError("未匹配文字在相邻时间点之间无法插值")
        consumed_weight = 0
        for offset, weight in enumerate(weights, start=1):
            item_start = start + span * consumed_weight // total_weight
            consumed_weight += weight
            item_end = (
                end
                if offset == missing
                else start + span * consumed_weight // total_weight
            )
            ranges[left + offset] = (item_start, item_end)
    return [value for value in ranges if value is not None]


def _align_expected_tokens(
    expected: Sequence[ScriptToken],
    transcript_words: Sequence[dict[str, Any]],
    duration: float,
    minimum_coverage: float,
    *,
    sample_rate: int,
    sample_count: int,
) -> list[dict[str, Any]]:
    if not expected:
        raise AlignmentError("稿件不包含可朗读内容")
    if (
        isinstance(minimum_coverage, bool)
        or not math.isfinite(float(minimum_coverage))
        or not 0 < minimum_coverage <= 1
    ):
        raise AlignmentError("逐字对齐阈值无效")
    expected_characters = [
        character
        for token in expected
        for character in token.normalized
    ]
    character_owners = [
        token_index
        for token_index, token in enumerate(expected)
        for _character in token.normalized
    ]
    actual = _provider_atoms(
        transcript_words,
        duration,
        sample_rate=sample_rate,
        sample_count=sample_count,
    )
    character_matches = _lcs_matches(expected_characters, actual)
    matched_by_token: dict[int, list[_ProviderAtom]] = {}
    for expected_index, actual_index in character_matches:
        matched_by_token.setdefault(
            character_owners[expected_index],
            [],
        ).append(actual[actual_index])
    matched_tokens = {
        token_index: atoms
        for token_index, atoms in matched_by_token.items()
        if len(atoms) == len(expected[token_index].normalized)
    }
    coverage = Fraction(len(matched_tokens), len(expected))
    threshold = Fraction(str(minimum_coverage))
    if coverage < threshold:
        raise AlignmentError(
            "逐字对齐置信度不足"
            f"（{float(coverage):.1%} < {minimum_coverage:.1%}）",
        )

    ranges: list[tuple[int, int] | None] = [None] * len(expected)
    for token_index, atoms in matched_tokens.items():
        ranges[token_index] = (
            atoms[0].start_sample,
            atoms[-1].end_sample,
        )
    resolved = _interpolate_missing(ranges, expected, sample_count)
    return [
        {
            "id": token.id,
            "text": token.text,
            "start": start / sample_rate,
            "end": end / sample_rate,
            **(
                {"speech_segment_id": token.speech_segment_id}
                if token.speech_segment_id
                else {}
            ),
        }
        for token, (start, end) in zip(expected, resolved, strict=True)
    ]


def align_transcript_words(
    script: str,
    transcript_words: Sequence[dict[str, Any]],
    master_duration: float,
    minimum_coverage: float = 0.85,
    *,
    speech_segments: Sequence[dict[str, Any]] | None = None,
    sample_rate: int = 44100,
    master_sample_count: int | None = None,
) -> list[dict[str, Any]]:
    script = str(script or "")
    if (
        isinstance(sample_rate, bool)
        or not isinstance(sample_rate, int)
        or sample_rate <= 0
    ):
        raise AlignmentError("master sample rate 无效")
    if master_sample_count is None:
        master_sample_count = round(float(master_duration) * sample_rate)
    if (
        isinstance(master_sample_count, bool)
        or not isinstance(master_sample_count, int)
        or master_sample_count <= 0
        or not math.isclose(
            float(master_duration),
            master_sample_count / sample_rate,
            rel_tol=0,
            abs_tol=1 / sample_rate,
        )
    ):
        raise AlignmentError("master duration 与 sample metadata 不一致")
    expected = _expected_tokens(script, speech_segments)
    return _align_expected_tokens(
        expected,
        transcript_words,
        master_sample_count / sample_rate,
        float(minimum_coverage),
        sample_rate=sample_rate,
        sample_count=master_sample_count,
    )


def build_global_timeline(
    script: str,
    segments: Sequence[dict[str, Any]],
    offsets: dict[str, int],
    master_duration: float,
    *,
    sample_rate: int = 44100,
    master_sample_count: int | None = None,
    minimum_coverage: float = 0.85,
) -> list[dict[str, Any]]:
    if (
        isinstance(sample_rate, bool)
        or not isinstance(sample_rate, int)
        or sample_rate <= 0
    ):
        raise AlignmentError("master sample rate 无效")
    if master_sample_count is None:
        master_sample_count = round(float(master_duration) * sample_rate)
    if (
        isinstance(master_sample_count, bool)
        or not isinstance(master_sample_count, int)
        or master_sample_count <= 0
    ):
        raise AlignmentError("master sample count 无效")
    authoritative_duration = master_sample_count / sample_rate
    if (
        not math.isfinite(float(master_duration))
        or not math.isclose(
            float(master_duration),
            authoritative_duration,
            rel_tol=0,
            abs_tol=1 / sample_rate,
        )
    ):
        raise AlignmentError("master duration 与 sample metadata 不一致")
    if "".join(
        str(segment.get("text") or "")
        for segment in segments
        if isinstance(segment, dict)
    ) != script:
        raise AlignmentError("口播分段必须无损还原完整稿件")

    global_words: list[dict[str, Any]] = []
    char_offset = 0
    expected_offset = 0
    for raw in segments:
        if not isinstance(raw, dict):
            raise AlignmentError("口播分段格式无效")
        segment_id = raw.get("id")
        text = raw.get("text")
        sample_count = raw.get("sample_count")
        offset = offsets.get(str(segment_id))
        if (
            not isinstance(segment_id, str)
            or not segment_id
            or not isinstance(text, str)
            or isinstance(sample_count, bool)
            or not isinstance(sample_count, int)
            or sample_count <= 0
            or isinstance(offset, bool)
            or not isinstance(offset, int)
            or offset != expected_offset
        ):
            raise AlignmentError("口播 sample offsets 无效")
        duration = sample_count / sample_rate
        local_expected = _tokenize_with_boundaries(
            text,
            [(0, len(text), segment_id)],
        )
        local_words = _align_expected_tokens(
            local_expected,
            raw.get("word_timings"),
            duration,
            minimum_coverage,
            sample_rate=sample_rate,
            sample_count=sample_count,
        )
        for item, token in zip(local_words, local_expected, strict=True):
            local_start = round(item["start"] * sample_rate)
            local_end = round(item["end"] * sample_rate)
            global_words.append({
                **item,
                "id": (
                    f"word-{token.start_char + char_offset}-"
                    f"{token.end_char + char_offset}"
                ),
                "start": (offset + local_start) / sample_rate,
                "end": min(
                    master_sample_count,
                    offset + local_end,
                ) / sample_rate,
                "speech_segment_id": segment_id,
            })
        char_offset += len(text)
        expected_offset += sample_count
    if expected_offset != master_sample_count:
        raise AlignmentError("口播 samples 与 master sample count 不一致")
    if "".join(item["text"] for item in global_words) != script:
        raise AlignmentError("逐字时间轴未能无损还原完整稿件")
    return global_words
