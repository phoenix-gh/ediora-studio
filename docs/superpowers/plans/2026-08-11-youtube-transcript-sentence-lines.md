# YouTube 逐字稿句级合并 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 YouTube 字幕与 Whisper 回退结果统一整理为一句一个时间分段、全文一句一行，同时不改写原文。

**Architecture:** 在 `backend/youtube_transcript.py` 的 `build_transcript()` 边界增加确定性的句级规范化。算法先按强句末标点切句，再按静音、最大时长和最大文本长度兜底；句子时间取所覆盖源分段的首尾时间，原文字符保持不变，只规范跨分段空格。

**Tech Stack:** Python、pytest、现有 YouTube transcript 数据结构。

## Global Constraints

- 不增加 NLP 模型或外部服务依赖。
- 原文与中文版本使用同一处理路径。
- 不修改已有数据库字段和 API 形状。
- 旧数据不迁移，重新采集后获得新格式。

---

### Task 1: 句级规范化

**Files:**
- Modify: `backend/youtube_transcript.py`
- Test: `backend/tests/test_youtube_transcript.py`

**Interfaces:**
- Consumes: `build_transcript(source: str, language: str, segments: list[dict])`
- Produces: 保持原返回结构，`segments` 改为句级分段，`text` 使用换行连接句子。

- [x] **Step 1: Write failing tests**

覆盖英文跨 cue 合句、中文无空格合句、一个 cue 多句、静音/时长/长度兜底，以及 content hash 忽略时间戳的既有语义。

- [x] **Step 2: Verify tests fail**

Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_youtube_transcript.py -q`

Expected: 新增的句级格式断言失败。

- [x] **Step 3: Implement minimal normalizer**

新增私有句级规范化函数，由 `build_transcript()` 调用。强边界为 `。！？.!?`；无强标点时在相邻分段静音超过 1 秒、累计时长超过 15 秒或文本超过中文 60 字/其他语言 140 字符时断开。

- [x] **Step 4: Verify focused tests pass**

Run: `/home/violet/miniconda3/envs/wems/bin/python -m pytest backend/tests/test_youtube_transcript.py backend/tests/test_youtube_transcript_api.py -q`

- [x] **Step 5: Check patch hygiene**

Run: `git diff --check -- backend/youtube_transcript.py backend/tests/test_youtube_transcript.py docs/superpowers/plans/2026-08-11-youtube-transcript-sentence-lines.md`
