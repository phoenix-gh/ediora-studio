"""Bounded public-web verification for links attached to X posts."""

from __future__ import annotations

import ipaddress
import re
import socket
from collections.abc import Callable
from urllib.parse import urljoin, urlsplit

import httpx
from bs4 import BeautifulSoup


URL_RE = re.compile(r"https?://[^\s<>()\[\]\"']+")
ALLOWED_CONTENT_TYPES = {"text/html", "text/plain", "application/xhtml+xml"}
MAX_BODY_BYTES = 1024 * 1024
MAX_TEXT_CHARS = 12_000
MAX_REDIRECTS = 2


def extract_external_urls(content: str, raw_markdown: str, post_url: str) -> list[str]:
    found: list[str] = []
    seen: set[str] = set()
    original = post_url.rstrip("/")
    for match in URL_RE.findall(f"{content}\n{raw_markdown}"):
        url = match.rstrip(".,;:!?，。；：！？）]")
        parsed = urlsplit(url)
        host = (parsed.hostname or "").lower()
        if url.rstrip("/") == original or host in {"x.com", "www.x.com", "twitter.com", "www.twitter.com"}:
            continue
        if url not in seen:
            seen.add(url)
            found.append(url)
    return found


def _is_public_address(value: str) -> bool:
    address = ipaddress.ip_address(value)
    return bool(address.is_global)


def _validate_public_url(
    url: str,
    resolver: Callable = socket.getaddrinfo,
) -> None:
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("URL must be public HTTP(S)")
    host = parsed.hostname
    try:
        if not _is_public_address(host):
            raise ValueError("URL host must resolve to a public address")
        return
    except ValueError as exc:
        if "must resolve" in str(exc):
            raise

    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        addresses = resolver(host, port, type=socket.SOCK_STREAM)
    except OSError as exc:
        raise ValueError(f"URL host resolution failed: {exc}") from exc
    resolved = {item[4][0] for item in addresses}
    if not resolved or any(not _is_public_address(address) for address in resolved):
        raise ValueError("URL host must resolve to a public address")


def _extract_text(response: httpx.Response) -> tuple[str, str]:
    content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if content_type not in ALLOWED_CONTENT_TYPES:
        raise ValueError(f"unsupported content type: {content_type or 'missing'}")
    content_length = response.headers.get("content-length")
    if content_length and int(content_length) > MAX_BODY_BYTES:
        raise ValueError("response body exceeds 1 MiB")
    if len(response.content) > MAX_BODY_BYTES:
        raise ValueError("response body exceeds 1 MiB")
    if content_type == "text/plain":
        return "", response.text[:MAX_TEXT_CHARS].strip()

    soup = BeautifulSoup(response.text, "html.parser")
    title = soup.title.get_text(" ", strip=True) if soup.title else ""
    for node in soup(["script", "style", "nav", "footer", "header", "noscript"]):
        node.decompose()
    main = soup.find("main") or soup.find("article") or soup.body or soup
    text = main.get_text(" ", strip=True)
    return title[:500], text[:MAX_TEXT_CHARS]


async def _fetch_one(
    url: str,
    client: httpx.AsyncClient,
    resolver: Callable,
) -> dict:
    current = url
    for redirect_count in range(MAX_REDIRECTS + 1):
        _validate_public_url(current, resolver)
        response = await client.get(current, timeout=12)
        if response.status_code in {301, 302, 303, 307, 308}:
            if redirect_count >= MAX_REDIRECTS:
                raise ValueError("too many redirects")
            location = response.headers.get("location")
            if not location:
                raise ValueError("redirect missing location")
            current = urljoin(current, location)
            continue
        response.raise_for_status()
        title, text = _extract_text(response)
        if not text:
            raise ValueError("page contains no readable text")
        return {
            "url": url,
            "canonical_url": str(response.url) if response.url else current,
            "title": title,
            "text": text,
        }
    raise ValueError("too many redirects")


async def verify_urls(
    urls: list[str],
    client: httpx.AsyncClient | None = None,
    resolver: Callable = socket.getaddrinfo,
) -> dict:
    if not urls:
        return {"verification_status": "not_required", "links": [], "errors": []}

    owned_client = client is None
    active_client = client or httpx.AsyncClient(follow_redirects=False)
    links: list[dict] = []
    errors: list[str] = []
    try:
        for url in urls[:5]:
            try:
                links.append(await _fetch_one(url, active_client, resolver))
            except Exception as exc:
                errors.append(f"{url}: {exc}")
    finally:
        if owned_client:
            await active_client.aclose()

    return {
        "verification_status": "verified" if links else "unverified",
        "links": links,
        "errors": errors,
    }
