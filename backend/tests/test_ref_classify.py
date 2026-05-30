import asyncio, json
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
