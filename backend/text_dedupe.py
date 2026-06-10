"""近重复文本检测：字符 3-gram 与词级 overlap coefficient 取 max。

中文 3-gram 无需分词即有效；词级按空白粗切管中英混排。
用 overlap coefficient（交集/较小集）而非 Jaccard：洗稿常见手法是
插入语气词/连接词，插入会大量破坏 n-gram，Jaccard 全集惩罚过重
（实测同段子插两词 Jaccard 0.54、overlap 0.76），containment 视角才对。
阈值约定 0.7。
"""
from __future__ import annotations
import re

_NON_WORD_RE = re.compile(r"[^\w\s]", re.UNICODE)
_WS_RE = re.compile(r"\s+")

DEFAULT_THRESHOLD = 0.7


def normalize_text(text: str) -> str:
    text = _NON_WORD_RE.sub(" ", (text or "").lower())
    return _WS_RE.sub(" ", text).strip()


def _char_ngrams(norm: str, n: int = 3) -> frozenset[str]:
    compact = norm.replace(" ", "")
    if not compact:
        return frozenset()
    if len(compact) < n:
        return frozenset({compact})
    return frozenset(compact[i:i + n] for i in range(len(compact) - n + 1))


def _overlap(a: frozenset[str], b: frozenset[str]) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / min(len(a), len(b))


class PreparedText:
    """预计算文本表示，供重复比对循环复用。"""
    __slots__ = ("ngrams", "tokens")

    def __init__(self, raw: str) -> None:
        norm = normalize_text(raw)
        self.ngrams = _char_ngrams(norm)
        self.tokens = frozenset(t for t in norm.split() if len(t) > 1)


def similarity(a: PreparedText, b: PreparedText) -> float:
    return max(_overlap(a.ngrams, b.ngrams), _overlap(a.tokens, b.tokens))
