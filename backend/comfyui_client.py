"""Queue one ComfyUI prompt and download the first output image."""

from __future__ import annotations

import asyncio
import time
import uuid
from collections.abc import Awaitable, Callable
from typing import Any
from urllib.parse import quote

import httpx


async def download_comfyui_image(
    *,
    base_url: str,
    auth_token: str,
    graph: dict[str, Any],
    timeout_seconds: float = 300,
    poll_interval_seconds: float = 1,
    client: httpx.AsyncClient | None = None,
    sleep: Callable[[float], Awaitable[None]] | None = None,
    now: Callable[[], float] | None = None,
) -> bytes:
    """POST /prompt, poll /history, then GET /view. Raises ValueError."""
    sleep_fn = sleep or asyncio.sleep
    now_fn = now or time.monotonic
    owns_client = client is None
    http = client or httpx.AsyncClient(
        timeout=httpx.Timeout(60.0, connect=10.0),
        trust_env=False,
        follow_redirects=False,
    )
    try:
        return await _download(
            http,
            base_url=base_url.rstrip("/"),
            auth_token=auth_token,
            graph=graph,
            timeout_seconds=timeout_seconds,
            poll_interval_seconds=poll_interval_seconds,
            sleep_fn=sleep_fn,
            now_fn=now_fn,
        )
    finally:
        if owns_client:
            await http.aclose()


async def _download(
    client: httpx.AsyncClient,
    *,
    base_url: str,
    auth_token: str,
    graph: dict[str, Any],
    timeout_seconds: float,
    poll_interval_seconds: float,
    sleep_fn: Callable[[float], Awaitable[None]],
    now_fn: Callable[[], float],
) -> bytes:
    headers = {}
    if auth_token:
        headers["Authorization"] = f"Bearer {auth_token}"
    queued = await _request_json(
        client,
        "POST",
        f"{base_url}/prompt",
        headers=headers,
        json_body={"prompt": graph, "client_id": uuid.uuid4().hex},
        auth_token=auth_token,
    )
    prompt_id = queued.get("prompt_id") if isinstance(queued, dict) else None
    if not isinstance(prompt_id, str) or not prompt_id.strip():
        message = ""
        error = queued.get("error") if isinstance(queued, dict) else None
        if isinstance(error, dict):
            message = str(error.get("message") or error.get("type") or "").strip()
        raise ValueError(_safe(message or "ComfyUI 没有接受工作流", auth_token))

    started = now_fn()
    history_url = f"{base_url}/history/{quote(prompt_id, safe='')}"
    while True:
        payload = await _request_json(
            client,
            "GET",
            history_url,
            headers=headers,
            json_body=None,
            auth_token=auth_token,
        )
        item = _history_item(payload, prompt_id)
        if item is not None:
            status = item.get("status") if isinstance(item.get("status"), dict) else {}
            status_str = str(status.get("status_str") or "").strip().lower()
            if status_str in {"error", "failed"}:
                raise ValueError(_safe(_history_error(status), auth_token))
            if status.get("completed") is True or status_str == "success":
                image = _first_image(item.get("outputs"))
                if image is None:
                    raise ValueError("ComfyUI 没有返回图片")
                return await _view_image(
                    client,
                    base_url=base_url,
                    headers=headers,
                    image=image,
                    auth_token=auth_token,
                )
        if now_fn() - started >= timeout_seconds:
            raise ValueError("ComfyUI 生成超时")
        await sleep_fn(poll_interval_seconds)


async def _request_json(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    *,
    headers: dict[str, str],
    json_body: dict[str, Any] | None,
    auth_token: str,
) -> Any:
    try:
        response = await client.request(method, url, headers=headers, json=json_body)
    except httpx.TimeoutException as exc:
        raise ValueError("连接 ComfyUI 超时") from exc
    except httpx.HTTPError as exc:
        raise ValueError("无法连接到 ComfyUI") from exc
    _raise_for_status(response, auth_token)
    try:
        return response.json()
    except ValueError as exc:
        raise ValueError("ComfyUI 响应异常") from exc


def _raise_for_status(response: httpx.Response, auth_token: str) -> None:
    if response.status_code in {401, 403}:
        raise ValueError("ComfyUI 鉴权失败")
    if response.status_code >= 400:
        detail = " ".join((response.text or "").split())[:180]
        suffix = f": {_safe(detail, auth_token)}" if detail else ""
        raise ValueError(f"ComfyUI HTTP {response.status_code}{suffix}")


async def _view_image(
    client: httpx.AsyncClient,
    *,
    base_url: str,
    headers: dict[str, str],
    image: dict[str, Any],
    auth_token: str,
) -> bytes:
    params = {
        "filename": str(image.get("filename") or ""),
        "type": str(image.get("type") or "output"),
    }
    subfolder = str(image.get("subfolder") or "")
    if subfolder:
        params["subfolder"] = subfolder
    try:
        response = await client.get(f"{base_url}/view", params=params, headers=headers)
    except httpx.TimeoutException as exc:
        raise ValueError("连接 ComfyUI 超时") from exc
    except httpx.HTTPError as exc:
        raise ValueError("无法连接到 ComfyUI") from exc
    _raise_for_status(response, auth_token)
    data = response.content
    if not data:
        raise ValueError("ComfyUI 没有返回图片")
    return data


def _history_item(payload: Any, prompt_id: str) -> dict[str, Any] | None:
    if not isinstance(payload, dict):
        return None
    item = payload.get(prompt_id)
    if isinstance(item, dict):
        return item
    if "outputs" in payload or "status" in payload:
        return payload
    return None


def _history_error(status: dict[str, Any]) -> str:
    for item in status.get("messages") or []:
        if isinstance(item, list) and len(item) >= 2 and isinstance(item[1], dict):
            text = str(item[1].get("exception_message") or "").strip()
            if text:
                return text[:200]
    return "ComfyUI 生成失败"


def _first_image(outputs: Any) -> dict[str, Any] | None:
    if not isinstance(outputs, dict):
        return None
    images: list[dict[str, Any]] = []
    for node in outputs.values():
        if not isinstance(node, dict) or not isinstance(node.get("images"), list):
            continue
        for image in node["images"]:
            if isinstance(image, dict) and str(image.get("filename") or "").strip():
                images.append(image)
    for image in images:
        if image.get("type") == "output":
            return image
    return images[0] if images else None


def _safe(message: str, auth_token: str) -> str:
    text = message
    if auth_token:
        text = text.replace(auth_token, "***")
    return text[:300]
