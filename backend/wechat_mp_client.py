"""mp.weixin.qq.com backend client — QR-code login + searchbiz + appmsgpublish.

Mirrors wechat-article-exporter's approach: login once via QR scan to obtain a
token (URL query parameter, ~2h lifetime) plus a session Cookie set, then call
the internal "insert hyperlink" endpoints to enumerate accounts and articles.

Stateless — every public function accepts cookie/token explicitly. Session
continuity is *not* required; the same (cookie, token) pair works across
unrelated requests until WeChat invalidates it (base_resp.ret == 200003).
"""

from __future__ import annotations
import json
import time
from typing import Any
import httpx

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


class SessionExpired(Exception):
    """Raised when WeChat returns ret == 200003 (token/cookie no longer valid)."""


def _common_headers(cookie: str | None = None) -> dict[str, str]:
    h = {
        "User-Agent": USER_AGENT,
        "Referer": "https://mp.weixin.qq.com/",
        "Origin": "https://mp.weixin.qq.com",
        # disable compression — keeps response cloning trivial and matches the
        # reference implementation
        "Accept-Encoding": "identity",
    }
    if cookie:
        h["Cookie"] = cookie
    return h


def _join_set_cookie(set_cookie_headers: list[str]) -> str:
    """Collapse `Set-Cookie` headers into a Cookie string. Later values override
    earlier ones, and entries explicitly set to EXPIRED are dropped so the server
    doesn't see them as live session markers."""
    pairs: dict[str, str] = {}
    for raw in set_cookie_headers:
        first = raw.split(";", 1)[0].strip()
        if not first or "=" not in first:
            continue
        name, _, value = first.partition("=")
        name = name.strip()
        value = value.strip()
        if value == "EXPIRED":
            pairs.pop(name, None)
            continue
        pairs[name] = value
    return "; ".join("{0}={1}".format(k, v) for k, v in pairs.items())


def _merge_cookies(base: str, set_cookie_headers: list[str]) -> str:
    """Merge new Set-Cookie entries into an existing Cookie header string."""
    cookies: dict[str, str] = {}
    for chunk in base.split(";"):
        chunk = chunk.strip()
        if "=" in chunk:
            k, v = chunk.split("=", 1)
            cookies[k.strip()] = v.strip()
    for raw in set_cookie_headers:
        first = raw.split(";", 1)[0].strip()
        if "=" in first:
            k, v = first.split("=", 1)
            cookies[k.strip()] = v.strip()
    return "; ".join("{0}={1}".format(k, v) for k, v in cookies.items())


# ── Step A: QR-code login ─────────────────────────────────────────────────────

async def _start_login_session() -> str:
    """First step: POST bizlogin?action=startlogin with a fresh sessionid.
    WeChat responds with Set-Cookie containing the uuid that ties the whole
    login flow together. Returns the Cookie header string to forward downstream.
    """
    import random as _r
    sid = "{0}{1}".format(int(time.time() * 1000), _r.randint(0, 99))
    body = {
        "userlang": "zh_CN", "redirect_url": "", "login_type": 3,
        "sessionid": sid, "token": "", "lang": "zh_CN", "f": "json", "ajax": 1,
    }
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.post(
            "https://mp.weixin.qq.com/cgi-bin/bizlogin",
            headers={**_common_headers(),
                     "Content-Type": "application/x-www-form-urlencoded"},
            params={"action": "startlogin"},
            data=body,
        )
        resp.raise_for_status()
        cookie = _join_set_cookie(resp.headers.get_list("set-cookie"))
        if "uuid=" not in cookie:
            raise RuntimeError("startlogin 未返回 uuid cookie；body={0}".format(resp.text[:200]))
        return cookie


async def get_qrcode() -> tuple[bytes, str]:
    """Open a fresh login session and fetch the QR-code PNG in one go.
    Returns (png_bytes, uuid_cookie_string). The uuid_cookie_string is the
    correlation token to feed back into `poll_scan` and `complete_login`.
    """
    uuid_cookie = await _start_login_session()
    url = "https://mp.weixin.qq.com/cgi-bin/scanloginqrcode"
    params = {"action": "getqrcode", "random": int(time.time() * 1000)}
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.get(url, headers=_common_headers(uuid_cookie), params=params)
        resp.raise_for_status()
        # any new set-cookies during getqrcode get merged in
        merged = _merge_cookies(uuid_cookie, resp.headers.get_list("set-cookie"))
        return resp.content, merged


async def poll_scan(uuid_cookie: str) -> dict[str, Any]:
    """Poll scan status. Returns the JSON dict, key is `status`:
      0 — waiting (no scan yet)
      4 — scanned, awaiting in-app confirmation
      1 — confirmed (ready to call complete_login)
      others — error / expired
    """
    url = "https://mp.weixin.qq.com/cgi-bin/scanloginqrcode"
    params = {
        "action": "ask", "token": "", "lang": "zh_CN", "f": "json", "ajax": 1,
    }
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.get(url, headers=_common_headers(uuid_cookie), params=params)
        resp.raise_for_status()
        return resp.json()


async def complete_login(uuid_cookie: str) -> tuple[str, str]:
    """After scan confirmation, finalize login. Returns (token, cookie_header).
    The cookie_header is the merged Cookie string to use for all subsequent calls.
    """
    url = "https://mp.weixin.qq.com/cgi-bin/bizlogin"
    body = {
        "userlang": "zh_CN", "redirect_url": "", "cookie_forbidden": 0,
        "cookie_cleaned": 0, "plugin_used": 0, "login_type": 3,
        "token": "", "lang": "zh_CN", "f": "json", "ajax": 1,
    }
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.post(
            url,
            headers={**_common_headers(uuid_cookie),
                     "Content-Type": "application/x-www-form-urlencoded"},
            params={"action": "login"},
            data=body,
        )
        resp.raise_for_status()
        data = resp.json()
        redirect_url = data.get("redirect_url", "")
        if not redirect_url:
            raise RuntimeError("登录响应未包含 redirect_url，扫码可能已过期: {0}".format(data))
        # token is the `token` query param in redirect_url
        from urllib.parse import urlparse, parse_qs
        token = parse_qs(urlparse("http://x" + redirect_url).query).get("token", [""])[0]
        if not token:
            raise RuntimeError("redirect_url 中未找到 token: {0}".format(redirect_url))
        # Only the bizlogin?action=login response carries the live session
        # cookies (slave_sid / slave_user / data_ticket etc.). Per
        # wechat-article-exporter, do NOT merge with earlier uuid_cookie or
        # follow redirect_url — both pollute the cookie set and the server
        # rejects the resulting session.
        cookie_header = _join_set_cookie(resp.headers.get_list("set-cookie"))
        if not cookie_header:
            raise RuntimeError("登录响应未携带 set-cookie")
        return token, cookie_header


# ── Step B: business calls ────────────────────────────────────────────────────

def _check_ret(payload: dict[str, Any]) -> None:
    base = payload.get("base_resp") or {}
    ret = base.get("ret", 0)
    if ret == 200003 or ret == -7:   # -7 also seen for invalid session
        raise SessionExpired(base.get("err_msg", "session expired"))
    if ret != 0:
        raise RuntimeError("mp api ret={0}: {1}".format(ret, base.get("err_msg", "")))


async def search_biz(query: str, token: str, cookie: str,
                     begin: int = 0, count: int = 5) -> list[dict[str, Any]]:
    """Search public accounts by name. Returns a list of candidates with
    `fakeid`, `nickname`, `alias`, `round_head_img`, `service_type`, ..."""
    url = "https://mp.weixin.qq.com/cgi-bin/searchbiz"
    params = {
        "action": "search_biz",
        "begin": begin, "count": count,
        "query": query, "token": token,
        "lang": "zh_CN", "f": "json", "ajax": 1,
    }
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.get(url, headers=_common_headers(cookie), params=params)
        resp.raise_for_status()
        data = resp.json()
    _check_ret(data)
    return data.get("list", []) or []


async def list_articles(fakeid: str, token: str, cookie: str,
                        begin: int = 0, count: int = 5,
                        keyword: str = "") -> tuple[list[dict[str, Any]], int]:
    """Fetch published-articles page for a given account.

    Returns (articles, total_count). Each article dict is the flattened
    appmsgex entry: title / link / cover / create_time / update_time /
    item_show_type / digest / appmsgid / aid.

    The mp endpoint returns `publish_page` as a JSON-encoded *string*
    containing another JSON-encoded `publish_info` string — we unwrap both.
    """
    url = "https://mp.weixin.qq.com/cgi-bin/appmsgpublish"
    is_searching = bool(keyword)
    params = {
        "sub": "search" if is_searching else "list",
        "search_field": "7" if is_searching else "null",
        "begin": begin, "count": count,
        "query": keyword, "fakeid": fakeid,
        "type": "101_1", "free_publish_type": 1,
        "sub_action": "list_ex",
        "token": token, "lang": "zh_CN", "f": "json", "ajax": 1,
    }
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.get(url, headers=_common_headers(cookie), params=params)
        resp.raise_for_status()
        data = resp.json()
    _check_ret(data)

    publish_page_raw = data.get("publish_page") or "{}"
    page = json.loads(publish_page_raw) if isinstance(publish_page_raw, str) else publish_page_raw
    total = int(page.get("total_count") or 0)

    articles: list[dict[str, Any]] = []
    for entry in page.get("publish_list", []):
        info_raw = entry.get("publish_info") or "{}"
        info = json.loads(info_raw) if isinstance(info_raw, str) else info_raw
        for msg in info.get("appmsgex", []) or []:
            articles.append(msg)
    return articles, total
