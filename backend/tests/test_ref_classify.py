import asyncio, json
import pytest
from unittest.mock import patch


def test_classify_ref_posts_maps_by_source_id():
    import llm
    fake = json.dumps([
        {"source_id": "1", "keep": True, "score": 90, "category": "沙雕搞笑",
         "scene_tags": ["resonance"], "tags": ["梗"], "text_clean": "干净版"},
        {"source_id": "2", "keep": False, "score": 10, "category": "其他",
         "scene_tags": [], "tags": [], "text_clean": ""},
    ])
    async def fake_call(prompt, max_tokens=2048):
        return fake
    posts = [{"source_id": "1", "text": "段子1", "likes": 9000},
             {"source_id": "2", "text": "广告2", "likes": 8000}]
    with patch("llm._call", new=fake_call):
        res = asyncio.new_event_loop().run_until_complete(
            llm.classify_ref_posts(posts, categories=["沙雕搞笑", "其他"],
                                   scene_tags=["resonance"]))
    by_id = {r["source_id"]: r for r in res}
    assert by_id["1"]["keep"] is True and by_id["1"]["score"] == 90
    assert by_id["1"]["category"] == "沙雕搞笑"
    assert by_id["2"]["keep"] is False


def test_classify_ref_posts_empty_input_no_llm_call():
    import llm
    called = {"n": 0}
    async def fake_call(prompt, max_tokens=2048):
        called["n"] += 1
        return "[]"
    with patch("llm._call", new=fake_call):
        res = asyncio.new_event_loop().run_until_complete(
            llm.classify_ref_posts([], categories=["其他"], scene_tags=[]))
    assert res == [] and called["n"] == 0


def test_classify_ref_posts_raises_on_empty_output():
    """LLM 返回空字符串（mimo 被安全策略拦截时的表现）→ 抛 RefClassifyError，不再静默吞掉。"""
    import llm
    async def fake_call(prompt, max_tokens=2048):
        return ""
    posts = [{"source_id": "1", "text": "段子", "likes": 9000}]
    with patch("llm._call", new=fake_call):
        with pytest.raises(llm.RefClassifyError):
            asyncio.new_event_loop().run_until_complete(
                llm.classify_ref_posts(posts, categories=["其他"], scene_tags=[]))


def test_classify_ref_posts_raises_on_call_error_with_reason():
    """LLM 调用抛异常（如 429 限流）→ RefClassifyError 携带原始原因，供前端展示。"""
    import llm
    async def fake_call(prompt, max_tokens=2048):
        raise RuntimeError("Error code: 429 - Too many requests")
    posts = [{"source_id": "1", "text": "段子", "likes": 9000}]
    with patch("llm._call", new=fake_call):
        with pytest.raises(llm.RefClassifyError) as ei:
            asyncio.new_event_loop().run_until_complete(
                llm.classify_ref_posts(posts, categories=["其他"], scene_tags=[]))
    assert "429" in str(ei.value)


def test_classify_ref_posts_chunks_and_aggregates():
    """>6 条会拆多块逐次调用；各块结果聚合返回，避免一次性输出被 max_tokens 截断。"""
    import re, llm
    calls = {"n": 0}
    async def fake_call(prompt, max_tokens=2048):
        calls["n"] += 1
        ids = re.findall(r"\[(\d+)\]", prompt)
        return json.dumps([
            {"source_id": i, "keep": True, "score": 50, "category": "其他",
             "scene_tags": [], "tags": ["x"], "text_clean": "净"} for i in ids])
    posts = [{"source_id": str(i), "text": f"段子{i}", "likes": 1000} for i in range(14)]
    with patch("llm._call", new=fake_call):
        res = asyncio.new_event_loop().run_until_complete(
            llm.classify_ref_posts(posts, categories=["其他"], scene_tags=[]))
    # 14 条 / 每块 6 → 3 次调用，14 条裁决全部返回
    assert calls["n"] == 3
    assert {r["source_id"] for r in res} == {str(i) for i in range(14)}


def test_classify_ref_posts_partial_success_keeps_good_chunks():
    """部分块失败（如某块命中安全拦截）→ 仍返回成功块的结果，不整批丢弃。"""
    import re, llm
    async def fake_call(prompt, max_tokens=2048):
        ids = re.findall(r"\[(\d+)\]", prompt)
        if "0" in ids:           # 第一块（含 id 0）模拟被拦截
            return "The request was rejected because it was considered high risk"
        return json.dumps([
            {"source_id": i, "keep": True, "score": 50, "category": "其他",
             "scene_tags": [], "tags": [], "text_clean": "净"} for i in ids])
    posts = [{"source_id": str(i), "text": f"段子{i}", "likes": 1000} for i in range(12)]
    with patch("llm._call", new=fake_call):
        res = asyncio.new_event_loop().run_until_complete(
            llm.classify_ref_posts(posts, categories=["其他"], scene_tags=[]))
    # 第一块 6 条丢失、第二块 6 条保留（下次重采会重试失败块）
    assert {r["source_id"] for r in res} == {str(i) for i in range(6, 12)}


def test_classify_ref_posts_raises_on_refusal_text():
    """LLM 返回安全拒绝文案（无 JSON）→ RefClassifyError，把拒绝原文带出来。"""
    import llm
    async def fake_call(prompt, max_tokens=2048):
        return "The request was rejected because it was considered high risk"
    posts = [{"source_id": "1", "text": "段子", "likes": 9000}]
    with patch("llm._call", new=fake_call):
        with pytest.raises(llm.RefClassifyError) as ei:
            asyncio.new_event_loop().run_until_complete(
                llm.classify_ref_posts(posts, categories=["其他"], scene_tags=[]))
    assert "high risk" in str(ei.value)
