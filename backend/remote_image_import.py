"""Safely localize public remote images into the shared uploads directory."""

from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import socket
from collections.abc import Callable
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import httpx
from PIL import Image, UnidentifiedImageError

MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_REDIRECTS = 3
ALLOWED_CONTENT_TYPES = {
    "image/jpeg": ("JPEG", ".jpg"),
    "image/png": ("PNG", ".png"),
    "image/gif": ("GIF", ".gif"),
    "image/webp": ("WEBP", ".webp"),
}
ERROR_MESSAGES = {
    "unsafe_url": "图片地址未通过安全检查",
    "unreachable": "图片地址不可访问",
    "not_image": "远程内容不是受支持的图片",
    "too_large": "图片超过 10MB 限制",
    "timeout": "图片下载超时",
}
_REDIRECT_STATUSES = {301, 302, 303, 307, 308}
_REQUEST_HEADERS = {
    "Accept": "image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.5",
    "User-Agent": "Ediora/1.0",
}


class RemoteImageImportError(RuntimeError):
    def __init__(self, code: str):
        self.code = code
        self.message = ERROR_MESSAGES[code]
        super().__init__(self.message)


@dataclass(frozen=True)
class RemoteImageImportResult:
    source_url: str
    url: str = ""
    error_code: str = ""
    error: str = ""


async def _validate_public_url(value: str) -> str:
    try:
        parsed = urlsplit(value.strip())
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError as exc:
        raise RemoteImageImportError("unsafe_url") from exc
    host = parsed.hostname
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or not host
        or parsed.username is not None
        or parsed.password is not None
        or host.lower() == "localhost"
        or host.lower().endswith(".local")
    ):
        raise RemoteImageImportError("unsafe_url")

    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        try:
            resolved = await _resolve_addresses(host, port)
        except OSError as exc:
            raise RemoteImageImportError("unreachable") from exc
        if not resolved:
            raise RemoteImageImportError("unreachable")
    else:
        resolved = {literal}

    if any(not address.is_global for address in resolved):
        raise RemoteImageImportError("unsafe_url")
    return parsed.geturl()


async def _resolve_addresses(host: str, port: int) -> set[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    addresses = await asyncio.to_thread(
        socket.getaddrinfo,
        host,
        port,
        type=socket.SOCK_STREAM,
    )
    return {ipaddress.ip_address(item[4][0]) for item in addresses}


async def _read_response(response: httpx.Response) -> tuple[bytes, str]:
    content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type not in ALLOWED_CONTENT_TYPES:
        raise RemoteImageImportError("not_image")
    content_length = response.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > MAX_IMAGE_BYTES:
                raise RemoteImageImportError("too_large")
        except ValueError:
            pass

    chunks: list[bytes] = []
    size = 0
    async for chunk in response.aiter_bytes():
        size += len(chunk)
        if size > MAX_IMAGE_BYTES:
            raise RemoteImageImportError("too_large")
        chunks.append(chunk)
    return b"".join(chunks), content_type


def _verified_extension(data: bytes, content_type: str) -> str:
    expected_format, extension = ALLOWED_CONTENT_TYPES[content_type]
    try:
        with Image.open(BytesIO(data)) as image:
            detected_format = image.format
            image.verify()
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise RemoteImageImportError("not_image") from exc
    if detected_format != expected_format:
        raise RemoteImageImportError("not_image")
    return extension


async def _download_image(
    source_url: str,
    client_factory: Callable[..., httpx.AsyncClient],
) -> tuple[bytes, str]:
    timeout = httpx.Timeout(20, connect=5)
    async with client_factory(
        timeout=timeout,
        follow_redirects=False,
        trust_env=False,
    ) as client:
        current_url = source_url
        for redirect_count in range(MAX_REDIRECTS + 1):
            current_url = await _validate_public_url(current_url)
            async with client.stream(
                "GET",
                current_url,
                headers=_REQUEST_HEADERS,
            ) as response:
                if response.status_code in _REDIRECT_STATUSES:
                    location = response.headers.get("location")
                    if not location or redirect_count >= MAX_REDIRECTS:
                        raise RemoteImageImportError("unreachable")
                    current_url = urljoin(current_url, location)
                    continue
                response.raise_for_status()
                return await _read_response(response)
    raise RemoteImageImportError("unreachable")


async def import_remote_image(
    source_url: str,
    uploads_dir: Path,
    client_factory: Callable[..., httpx.AsyncClient] = httpx.AsyncClient,
) -> RemoteImageImportResult:
    try:
        data, content_type = await _download_image(source_url, client_factory)
        extension = _verified_extension(data, content_type)
        digest = hashlib.sha256(data).hexdigest()
        filename = f"asset-image-{digest}{extension}"
        uploads_dir.mkdir(parents=True, exist_ok=True)
        destination = uploads_dir / filename
        if not destination.exists():
            destination.write_bytes(data)
        return RemoteImageImportResult(
            source_url=source_url,
            url=f"/api/uploads/{filename}",
        )
    except RemoteImageImportError as exc:
        return RemoteImageImportResult(
            source_url=source_url,
            error_code=exc.code,
            error=exc.message,
        )
    except httpx.TimeoutException:
        return RemoteImageImportResult(
            source_url=source_url,
            error_code="timeout",
            error=ERROR_MESSAGES["timeout"],
        )
    except httpx.HTTPError:
        return RemoteImageImportResult(
            source_url=source_url,
            error_code="unreachable",
            error=ERROR_MESSAGES["unreachable"],
        )


async def import_remote_images(
    urls: list[str],
    uploads_dir: Path,
    client_factory: Callable[..., httpx.AsyncClient] = httpx.AsyncClient,
) -> list[RemoteImageImportResult]:
    return [
        await import_remote_image(url, uploads_dir, client_factory)
        for url in urls
    ]
