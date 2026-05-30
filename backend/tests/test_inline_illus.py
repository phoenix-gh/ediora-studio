from pipeline_template import strip_inline_illus


def test_removes_single_block():
    md = "前文\n\n<!-- wms-illus -->\n![图](u.png)\n<!-- /wms-illus -->\n\n后文"
    assert strip_inline_illus(md) == "前文\n\n后文"


def test_removes_multiple_blocks():
    md = ("a\n\n<!-- wms-illus -->\n![](1.png)\n<!-- /wms-illus -->\n\n"
          "b\n\n<!-- wms-illus -->\n![](2.png)\n<!-- /wms-illus -->\n\nc")
    assert strip_inline_illus(md) == "a\n\nb\n\nc"


def test_no_marker_returns_identical():
    md = "纯正文\n\n第二段\n"   # 含末尾换行也不动
    assert strip_inline_illus(md) == md


def test_keeps_handwritten_images():
    md = "见图 ![手写](manual.png) 这里\n\n<!-- wms-illus -->\n![](auto.png)\n<!-- /wms-illus -->"
    assert strip_inline_illus(md) == "见图 ![手写](manual.png) 这里"


def test_empty():
    assert strip_inline_illus("") == ""


def test_illustrate_body_pipeline_registered():
    from pipeline_template import get_pipeline
    steps = get_pipeline("illustrate_body")
    assert len(steps) == 1
    assert steps[0].assignee == "wms_illustrator"


def test_illustrate_body_body_has_guardrail_marker_and_style():
    from pipeline_template import get_pipeline
    step = get_pipeline("illustrate_body")[0]
    ctx = {"draft_id": 7, "account_id": "a",
           "account_profile": {"image_style": "扁平插画"}, "max_images": 3, "note": ""}
    body = step.body(ctx)
    assert "≤ 3 个" in body
    assert "<!-- wms-illus -->" in body
    assert "扁平插画" in body
    assert "draft #7" in step.title(ctx)
