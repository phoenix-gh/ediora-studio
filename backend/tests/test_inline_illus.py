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
