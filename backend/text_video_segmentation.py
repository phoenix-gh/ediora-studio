"""Authoritative, lossless speech-split boundary handling for text videos."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
from typing import Literal


BoundaryKind = Literal["newline", "sentence", "clause", "whitespace"]


class SegmentationError(ValueError):
    pass


@dataclass(frozen=True)
class BoundaryCandidate:
    id: str
    position: int
    kind: BoundaryKind
    context: str


_SENTENCE_PUNCTUATION = frozenset("。！？!?")
_CLAUSE_PUNCTUATION = frozenset("，、；：,;:")


def _script_prefix(script: str) -> str:
    return hashlib.sha256(script.encode("utf-8")).hexdigest()[:12]


def _speakable_character_count(script: str) -> int:
    return sum(not character.isspace() for character in script)


def _context(script: str, position: int) -> str:
    return script[max(0, position - 24):min(len(script), position + 24)]


def build_boundary_candidates(script: str) -> list[BoundaryCandidate]:
    """Return deterministic candidate boundaries without exposing offsets externally."""
    prefix = _script_prefix(script)
    candidates: list[tuple[int, BoundaryKind]] = []
    index = 0
    while index < len(script):
        character = script[index]
        position = index + 1
        if character in "\r\n":
            # Treat CRLF as one candidate after the complete newline sequence.
            if character == "\r" and position < len(script) and script[position] == "\n":
                position += 1
                index += 1
            candidates.append((position, "newline"))
        elif character in _SENTENCE_PUNCTUATION:
            candidates.append((position, "sentence"))
        elif character in _CLAUSE_PUNCTUATION:
            candidates.append((position, "clause"))
        index += 1

    # Long runs can safely use an existing whitespace boundary even without
    # punctuation. Store it at the end of the whitespace so no slice begins
    # with formatting that belongs to the preceding spoken thought.
    if _speakable_character_count(script) > 120:
        index = 0
        while index < len(script):
            if not script[index].isspace():
                index += 1
                continue
            end = index
            while end < len(script) and script[end].isspace():
                end += 1
            if 0 < end < len(script):
                candidates.append((end, "whitespace"))
            index = end

    priority: dict[BoundaryKind, int] = {
        "newline": 0,
        "sentence": 1,
        "clause": 2,
        "whitespace": 3,
    }
    by_position: dict[int, BoundaryKind] = {}
    for position, kind in candidates:
        if not 0 < position < len(script):
            continue
        previous = by_position.get(position)
        if previous is None or priority[kind] < priority[previous]:
            by_position[position] = kind

    return [
        BoundaryCandidate(
            id=f"boundary-{prefix}-{ordinal}",
            position=position,
            kind=kind,
            context=_context(script, position),
        )
        for ordinal, (position, kind) in enumerate(
            sorted(by_position.items()),
            start=1,
        )
    ]


def slice_at_boundary_ids(
    script: str,
    candidates: list[BoundaryCandidate],
    boundary_ids: list[str],
) -> list[str]:
    """Resolve candidate IDs server-side and return exact, speakable slices."""
    candidate_by_id = {candidate.id: candidate for candidate in candidates}
    if len(candidate_by_id) != len(candidates):
        raise SegmentationError("无效的分段边界")
    if len(set(boundary_ids)) != len(boundary_ids):
        raise SegmentationError("无效的分段边界")
    try:
        selected = [candidate_by_id[boundary_id] for boundary_id in boundary_ids]
    except KeyError as error:
        raise SegmentationError("无效的分段边界") from error

    boundaries = sorted(selected, key=lambda candidate: candidate.position)
    cuts: list[int] = []
    for boundary in boundaries:
        cut = boundary.position
        while cut < len(script) and script[cut].isspace():
            cut += 1
        if cut <= 0 or cut >= len(script) or (cuts and cut < cuts[-1]):
            raise SegmentationError("无效的分段边界")
        if not cuts or cut != cuts[-1]:
            cuts.append(cut)

    segments: list[str] = []
    start = 0
    for cut in cuts + [len(script)]:
        segment = script[start:cut]
        if not segment.strip():
            raise SegmentationError("分段后不能只包含空白")
        segments.append(segment)
        start = cut
    return segments


def speakable_character_count(script: str) -> int:
    return _speakable_character_count(script)
