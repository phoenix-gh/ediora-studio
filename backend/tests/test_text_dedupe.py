from text_dedupe import PreparedText, similarity, normalize_text


def test_normalize_strips_punct_and_lowercases():
    assert normalize_text("Hello, 世界！！World") == "hello 世界 world"


def test_identical_chinese_is_1():
    a = PreparedText("今天的打工人语录：上班是为了下班")
    assert similarity(a, a) == 1.0


def test_near_duplicate_chinese_above_threshold():
    # 洗稿场景：同一个段子小改几个字
    a = PreparedText("打工人的尽头是带薪拉屎，一天不拉浑身难受")
    b = PreparedText("打工人的尽头就是带薪拉屎，一天不拉感觉浑身难受")
    assert similarity(a, b) >= 0.7


def test_different_texts_below_threshold():
    a = PreparedText("今天股市大跌，韭菜们瑟瑟发抖")
    b = PreparedText("程序员的浪漫就是给女朋友写个小程序")
    assert similarity(a, b) < 0.3


def test_mixed_language_token_side():
    a = PreparedText("用 ChatGPT 写周报 真香")
    b = PreparedText("用 ChatGPT 写周报，真香！")
    assert similarity(a, b) >= 0.7


def test_empty_text_zero():
    assert similarity(PreparedText(""), PreparedText("非空")) == 0.0


def test_same_prefix_different_meaning_below_threshold():
    # overlap coefficient 下的关键边界：同开头不同义不应误判为重复
    a = PreparedText("今天天气真好适合出去玩")
    b = PreparedText("今天天气真差只能在家躺着")
    assert similarity(a, b) < 0.5
