import asyncio, json
import pytest
from unittest.mock import patch


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def test_classify_categories_maps_by_source_id():
    import llm
    fake = json.dumps([
        {"source_id": "1", "category": "沙雕搞笑", "scene_tags": ["resonance"]},
        {"source_id": "2", "category": "其他", "scene_tags": []},
    ])
    async def fake_call(prompt, max_tokens=2048):
        return fake
    posts = [{"source_id": "1", "text": "段子1"}, {"source_id": "2", "text": "文案2"}]
    with patch("llm._call", new=fake_call):
        res = _run(llm.classify_ref_categories(
            posts, categories=["沙雕搞笑", "其他"], scene_tags=["resonance"]))
    by_id = {r["source_id"]: r for r in res}
    assert by_id["1"]["category"] == "沙雕搞笑"
    assert by_id["1"]["scene_tags"] == ["resonance"]
    assert by_id["2"]["category"] == "其他"


def test_classify_categories_empty_input_no_llm_call():
    import llm
    called = {"n": 0}
    async def fake_call(prompt, max_tokens=2048):
        called["n"] += 1
        return "[]"
    with patch("llm._call", new=fake_call):
        res = _run(llm.classify_ref_categories([], categories=["其他"], scene_tags=[]))
    assert res == [] and called["n"] == 0


def test_classify_categories_raises_on_all_chunks_failed():
    import llm
    async def fake_call(prompt, max_tokens=2048):
        return ""  # 空输出 → RefClassifyError
    posts = [{"source_id": "1", "text": "x"}]
    with patch("llm._call", new=fake_call):
        with pytest.raises(llm.RefClassifyError):
            _run(llm.classify_ref_categories(posts, categories=["其他"], scene_tags=[]))


def test_classify_categories_partial_success_keeps_good_chunks():
    import llm
    calls = {"n": 0}
    async def fake_call(prompt, max_tokens=2048):
        calls["n"] += 1
        if calls["n"] == 1:
            return json.dumps([{"source_id": "1", "category": "其他", "scene_tags": []}])
        return "not json"
    # chunk 大小为 5：6 条 → 2 块，第二块失败
    posts = [{"source_id": str(i), "text": f"t{i}"} for i in range(1, 7)]
    with patch("llm._call", new=fake_call):
        res = _run(llm.classify_ref_categories(posts, categories=["其他"], scene_tags=[]))
    assert len(res) == 1 and res[0]["source_id"] == "1"
