from io import BytesIO

from PIL import Image

from digital_human_look import LOOK_HEIGHT, LOOK_WIDTH, compose_look_image


def _jpeg(width: int, height: int, color: tuple[int, int, int]) -> bytes:
    image = Image.new("RGB", (width, height), color)
    buffer = BytesIO()
    image.save(buffer, format="JPEG")
    return buffer.getvalue()


def test_compose_look_image_is_16_by_9_768_short_side():
    result = compose_look_image(
        _jpeg(400, 800, (20, 20, 20)),
        _jpeg(1920, 1080, (200, 180, 160)),
    )

    image = Image.open(BytesIO(result))
    assert image.size == (LOOK_WIDTH, LOOK_HEIGHT)
    assert image.format == "JPEG"
