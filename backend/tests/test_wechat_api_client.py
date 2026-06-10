import io
import os
from PIL import Image

from wechat_api_client import extract_image_srcs, replace_image_srcs, prepare_image_bytes


def _img_bytes(fmt: str, size=(10, 10)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, "red").save(buf, format=fmt)
    return buf.getvalue()


def test_extract_image_srcs_dedup_and_order():
    html = ('<p><img src="http://a/1.png"></p>'
            '<img style="width:100%" src="http://a/2.png" alt="x">'
            '<img src="http://a/1.png">')
    assert extract_image_srcs(html) == ["http://a/1.png", "http://a/2.png"]


def test_extract_image_srcs_empty():
    assert extract_image_srcs("<p>no images</p>") == []


def test_replace_image_srcs_only_mapped():
    html = '<img src="http://a/1.png"><img src="http://a/2.png">'
    out = replace_image_srcs(html, {"http://a/1.png": "https://mmbiz.qpic.cn/x"})
    assert out == '<img src="https://mmbiz.qpic.cn/x"><img src="http://a/2.png">'


def test_prepare_small_png_passthrough():
    data = _img_bytes("PNG")
    out, ext, mime = prepare_image_bytes(data, "image/png")
    assert out == data and ext == "png" and mime == "image/png"


def test_prepare_webp_converted_to_jpeg():
    out, ext, mime = prepare_image_bytes(_img_bytes("WEBP"), "image/webp")
    assert mime == "image/jpeg" and ext == "jpg"
    assert Image.open(io.BytesIO(out)).format == "JPEG"


def test_prepare_oversized_compressed_under_1mb():
    raw = Image.frombytes("RGB", (1500, 1500), os.urandom(1500 * 1500 * 3))
    buf = io.BytesIO()
    raw.save(buf, format="PNG")
    big = buf.getvalue()
    assert len(big) > 1024 * 1024
    out, ext, mime = prepare_image_bytes(big, "image/png")
    assert len(out) <= 1024 * 1024 and mime == "image/jpeg"
