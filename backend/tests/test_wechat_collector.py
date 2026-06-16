"""Tests for wechat_collector body extraction across article layouts."""

from wechat_collector import _extract_body

# New-style 图片消息 / 文案 post: body is NOT in #js_content. The text lives in a
# JS data blob as `content_noencode`, with \x0a hex escapes for newlines, and the
# DOM container #js_article is empty (rendered client-side). content_noencode is
# already HTML — WeChat embeds topic links as <a> anchors (themselves \x-escaped).
PICTURE_MESSAGE_PAGE = """<html><head>
<meta property="og:title" content="测试文案" />
<meta property="og:image" content="" />
<meta property="og:description" content="" />
<meta property="og:article:author" content="拾夕1226" />
</head><body>
<div id="js_article"></div>
<script>
  window.share_url = "https://mp.weixin.qq.com/s?__biz=MzY5MzAzNzU3Mg==&mid=1&idx=1";
window.cgiData = {
  title: '测试文案',
  nick_name: '拾夕1226',
  create_time: '1781225822',
  content_noencode: '第一段开场白\\x0a\\x0a1\\uFE0F\\u20E3 第二段收尾\\x0a\\x3ca class=\\x22wx_topic_link\\x22 topic-id=\\x22t1\\x22\\x3e#话题\\x3c/a\\x3e',
};
</script>
</body></html>"""

# Legacy text article: body in #js_content with lazy-loaded mmbiz images.
LEGACY_PAGE = """<html><body>
<div id="js_content" class="rich_media_content">
  <p>正文第一段</p>
  <img data-src="https://mmbiz.qpic.cn/abc" />
</div>
</body></html>"""


def test_extract_body_picture_message():
    body = _extract_body(PICTURE_MESSAGE_PAGE)
    # each non-empty line becomes a paragraph
    assert "<p>第一段开场白</p>" in body
    assert "第二段收尾" in body
    assert body.count("<p>") == 3
    # the ️⃣ keycap escapes decode to real characters
    assert "1️⃣" in body
    # content_noencode is HTML: WeChat topic anchors survive as real markup,
    # not flattened into escaped text
    assert '<a class="wx_topic_link" topic-id="t1">#话题</a>' in body
    assert "&lt;a" not in body


def test_extract_body_legacy_js_content():
    body = _extract_body(LEGACY_PAGE)
    assert "正文第一段" in body
    # mmbiz images are rewritten through the local proxy, data-src -> src
    assert "/api/wechat/img?url=" in body
    assert "data-src" not in body


def test_extract_body_returns_empty_when_no_content():
    assert _extract_body("<html><body><div id='js_article'></div></body></html>") == ""
