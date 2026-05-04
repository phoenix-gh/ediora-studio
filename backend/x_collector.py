"""
X (Twitter) timeline collector via camofox-browser.

Flow:
  1. Import stored cookies into a camofox session
  2. Navigate to https://x.com/home
  3. Scroll N times, extract @usernames from tweet author links
  4. For each new username, visit their profile and parse follower count
  5. If followers >= threshold → upsert into x_blogger_candidates
"""
import re
import json
import httpx
from datetime import datetime, timezone
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.dialects.sqlite import insert as _sqlite_insert

from models import XBloggerCandidate, XPost, XPostMetrics
from sqlalchemy import update as _update

# ── camofox helpers ───────────────────────────────────────────────────────────

async def _cfg():
    from config import get_config
    return await get_config()


async def _camofox(cfg: dict) -> tuple[str, dict, str]:
    """Return (base_url, headers, user_id) for camofox API calls."""
    base = (cfg.get("camofox_url") or "http://localhost:9377").rstrip("/")
    headers: dict = {}
    key = cfg.get("camofox_api_key") or ""
    if key:
        headers["Authorization"] = f"Bearer {key}"
    user_id = cfg.get("camofox_user_id") or "wemedia_x"
    return base, headers, user_id


async def _create_tab(client: httpx.AsyncClient, base: str, headers: dict, user_id: str, url: str) -> str:
    body: dict = {"userId": user_id, "sessionKey": user_id, "url": url}
    r = await client.post(f"{base}/tabs", json=body, headers=headers)
    r.raise_for_status()
    data = r.json()
    # camofox returns "tabId" (not "id")
    return data.get("tabId") or data.get("id") or data["tabId"]


async def _snapshot(client: httpx.AsyncClient, base: str, tab_id: str, headers: dict, user_id: str) -> str:
    r = await client.get(f"{base}/tabs/{tab_id}/snapshot", params={"userId": user_id}, headers=headers)
    r.raise_for_status()
    data = r.json()
    if isinstance(data, str):
        return data
    return data.get("snapshot") or data.get("content") or json.dumps(data)


async def _scroll(client: httpx.AsyncClient, base: str, tab_id: str, headers: dict):
    await client.post(f"{base}/tabs/{tab_id}/scroll", json={"direction": "down"}, headers=headers)


async def _evaluate(client: httpx.AsyncClient, base: str, tab_id: str, user_id: str, expression: str) -> str:
    """Run a JS expression in the tab and return the string result."""
    try:
        r = await client.post(
            f"{base}/tabs/{tab_id}/evaluate",
            json={"userId": user_id, "expression": expression},
        )
        if r.status_code == 200:
            data = r.json()
            return str(data.get("result") or "")
    except Exception:
        pass
    return ""


async def _close_session(client: httpx.AsyncClient, base: str, headers: dict, user_id: str):
    try:
        await client.delete(f"{base}/sessions/{user_id}", headers=headers)
    except Exception:
        pass


# ── Cookie format conversion ──────────────────────────────────────────────────

def _parse_cookies(raw: str) -> list[dict]:
    """
    Accept any common cookie format and return a JSON array ready for camofox.

    Supported formats:
      1. JSON array  — [{"name": ..., "value": ...}, ...]  (Cookie-Editor export)
      2. Raw header  — name=value; name2=value2            (DevTools copy)
      3. Netscape    — # Netscape HTTP Cookie File\\n...   (.txt export)
    """
    raw = raw.strip()

    # Format 1: JSON array
    if raw.startswith("["):
        try:
            cookies = json.loads(raw)
            if isinstance(cookies, list):
                out = []
                for c in cookies:
                    if not isinstance(c, dict) or not c.get("name"):
                        continue
                    out.append({
                        "name": c["name"],
                        "value": c.get("value", ""),
                        "domain": c.get("domain", ".x.com"),
                        "path": c.get("path", "/"),
                        "secure": c.get("secure", True),
                        "httpOnly": c.get("httpOnly", c.get("http_only", False)),
                        "sameSite": c.get("sameSite", c.get("same_site", "None")),
                    })
                return out
        except json.JSONDecodeError:
            pass

    # Format 3: Netscape (.txt)
    if "Netscape HTTP Cookie" in raw or (raw.startswith("#") and "\t" in raw):
        out = []
        for line in raw.splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            parts = line.split("\t")
            if len(parts) >= 7:
                domain, _, path, secure, _exp, name, value = parts[:7]
                out.append({
                    "name": name, "value": value,
                    "domain": domain, "path": path,
                    "secure": secure.upper() == "TRUE",
                    "httpOnly": False, "sameSite": "None",
                })
        if out:
            return out

    # Format 2: Raw header string  auth_token=abc; ct0=xyz; ...
    out = []
    for part in raw.split(";"):
        part = part.strip()
        if not part:
            continue
        name, _, value = part.partition("=")
        name = name.strip()
        if not name:
            continue
        out.append({
            "name": name,
            "value": value.strip(),
            "domain": ".x.com",
            "path": "/",
            "secure": True,
            "httpOnly": name in ("auth_token", "ct0", "twid", "_twitter_sess"),
            "sameSite": "None",
        })
    return out


# ── Cookie import ─────────────────────────────────────────────────────────────

async def import_x_cookies(cookies_raw: str) -> dict:
    """
    Parse any cookie format, then push into the camofox session.
    Returns {"ok": bool, "error": str|None, "count": int}
    """
    cfg = await _cfg()
    base, headers, user_id = await _camofox(cfg)
    api_key = cfg.get("camofox_api_key") or ""
    if not api_key:
        return {"ok": False, "error": "camofox_api_key 未配置，cookie 导入被禁用", "count": 0}

    try:
        cookies = _parse_cookies(cookies_raw)
    except Exception as e:
        return {"ok": False, "error": f"Cookie 解析失败: {e}", "count": 0}

    if not cookies:
        return {"ok": False, "error": "未解析到任何 cookie，请检查格式", "count": 0}

    import_headers = {**headers, "Authorization": f"Bearer {api_key}"}
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(
                f"{base}/sessions/{user_id}/cookies",
                json={"cookies": cookies},
                headers=import_headers,
            )
            r.raise_for_status()
        return {"ok": True, "error": None, "count": len(cookies)}
    except Exception as e:
        return {"ok": False, "error": str(e), "count": 0}


async def open_login_session() -> dict:
    """
    Open x.com/login in camofox so the user can log in via VNC.
    Returns {"ok": bool, "tab_id": str, "novnc_url": str, "error": str|None}
    """
    cfg = await _cfg()
    base, headers, user_id = await _camofox(cfg)
    novnc_url = cfg.get("camofox_novnc_url") or "http://localhost:6080/vnc.html"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            tab_id = await _create_tab(client, base, headers, user_id, "https://x.com/i/flow/login")
        return {"ok": True, "tab_id": tab_id, "novnc_url": novnc_url, "error": None}
    except Exception as e:
        return {"ok": False, "tab_id": "", "novnc_url": novnc_url, "error": str(e)}


async def open_timeline_session() -> dict:
    """
    Inject stored cookies into camofox session and open x.com/home.
    Returns {"ok": bool, "tab_id": str, "novnc_url": str, "cookie_count": int, "error": str|None}
    """
    cfg = await _cfg()
    base, headers, user_id = await _camofox(cfg)
    novnc_url = cfg.get("camofox_novnc_url") or "http://localhost:6080/vnc.html"
    api_key = cfg.get("camofox_api_key") or ""
    cookies_raw = cfg.get("x_cookies") or ""

    if not cookies_raw:
        return {"ok": False, "tab_id": "", "novnc_url": novnc_url, "cookie_count": 0,
                "error": "未配置 X Cookie，请先在设置中填写或通过 VNC 登录"}

    cookies = _parse_cookies(cookies_raw)
    if not cookies:
        return {"ok": False, "tab_id": "", "novnc_url": novnc_url, "cookie_count": 0,
                "error": "Cookie 解析失败，请检查格式"}

    import_headers = {**headers}
    if api_key:
        import_headers["Authorization"] = f"Bearer {api_key}"

    try:
        async with httpx.AsyncClient(timeout=20) as client:
            # Inject cookies into the session
            r = await client.post(
                f"{base}/sessions/{user_id}/cookies",
                json={"cookies": cookies},
                headers=import_headers,
            )
            r.raise_for_status()

            # Open timeline tab
            tab_id = await _create_tab(client, base, headers, user_id, "https://x.com/home")

        return {"ok": True, "tab_id": tab_id, "novnc_url": novnc_url,
                "cookie_count": len(cookies), "error": None}
    except Exception as e:
        return {"ok": False, "tab_id": "", "novnc_url": novnc_url, "cookie_count": 0, "error": str(e)}


async def import_session_from_camofox() -> dict:
    """
    After the user has logged in via VNC, pull the storage_state from camofox
    and save the cookies to config.
    Returns {"ok": bool, "cookie_count": int, "error": str|None}
    """
    from config import set_config
    cfg = await _cfg()
    base, headers, user_id = await _camofox(cfg)
    api_key = cfg.get("camofox_api_key") or ""
    if not api_key:
        return {"ok": False, "cookie_count": 0, "error": "camofox_api_key 未配置"}

    auth_headers = {**headers, "Authorization": f"Bearer {api_key}"}
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.get(
                f"{base}/sessions/{user_id}/storage_state",
                headers=auth_headers,
            )
            r.raise_for_status()
            state = r.json()
    except Exception as e:
        return {"ok": False, "cookie_count": 0, "error": f"获取 storage_state 失败: {e}"}

    # Extract cookies from storage_state
    # Format: {"cookies": [...], "origins": [...]}
    cookies: list[dict] = state.get("cookies", [])
    if not cookies:
        # Some versions nest under origins
        for origin in state.get("origins", []):
            if "x.com" in origin.get("origin", ""):
                cookies.extend(origin.get("localStorage", {}).get("cookies", []))

    if not cookies:
        return {"ok": False, "cookie_count": 0, "error": "storage_state 中未找到 cookie，请确认已成功登录"}

    # Normalise and save
    normalised = []
    for c in cookies:
        if not c.get("name"):
            continue
        normalised.append({
            "name": c["name"],
            "value": c.get("value", ""),
            "domain": c.get("domain", ".x.com"),
            "path": c.get("path", "/"),
            "secure": c.get("secure", True),
            "httpOnly": c.get("httpOnly", False),
            "sameSite": c.get("sameSite", "None"),
        })

    await set_config({"x_cookies": json.dumps(normalised)})
    return {"ok": True, "cookie_count": len(normalised), "error": None}


# ── Page load helpers ────────────────────────────────────────────────────────

import asyncio as _asyncio


async def _wait_for_element(
    client: httpx.AsyncClient,
    base: str,
    tab_id: str,
    user_id: str,
    selector: str,
    timeout: int = 15,
    min_count: int = 1,
) -> bool:
    """Poll until `selector` matches `min_count` elements or timeout (seconds)."""
    deadline = _asyncio.get_event_loop().time() + timeout
    while _asyncio.get_event_loop().time() < deadline:
        result = await _evaluate(
            client, base, tab_id, user_id,
            f"document.querySelectorAll({json.dumps(selector)}).length"
        )
        try:
            if int(result) >= min_count:
                return True
        except (ValueError, TypeError):
            pass
        await _asyncio.sleep(1.5)
    return False


# JS that extracts all visible tweets and their current metrics.
# Returns a JSON string of [{tweet_id, username, content, time, replies, reposts, likes, views}].
# Uses optional chaining (?.) throughout to avoid TypeError when elements are absent.
_EXTRACT_TWEETS_JS = r"""
(function() {
  function parseCount(s) {
    if (!s) return 0;
    var t = String(s).trim();
    var m = t.match(/([\d,\.]+)\s*([KkMmBb万亿]?)/);
    if (!m) return 0;
    var n = parseFloat(m[1].replace(/,/g, ''));
    var u = m[2];
    if (u === 'K' || u === 'k') n *= 1e3;
    else if (u === 'M' || u === 'm') n *= 1e6;
    else if (u === 'B' || u === 'b') n *= 1e9;
    else if (u === '万') n *= 1e4;
    else if (u === '亿') n *= 1e8;
    return Math.round(n);
  }
  // reply/like: aria-label has the count ("5 Replies"), analytics: only "View analytics"
  function actionCount(el, testId) {
    var btn = el.querySelector('[data-testid="' + testId + '"]');
    if (!btn) return 0;
    var label = btn.getAttribute('aria-label') || '';
    var n = parseCount(label);
    if (n > 0) return n;
    return parseCount(btn.innerText || btn.textContent || '');
  }
  // Views: X uses different DOM across languages. Check aria-labels for the count.
  // Chinese X uses "5124 次查看。查看帖子分析" or combined "N 次观看" in a group label.
  function viewCount(el) {
    var allEls = el.querySelectorAll('[aria-label]');
    for (var i = 0; i < allEls.length; i++) {
      var lbl = allEls[i].getAttribute('aria-label') || '';
      // Chinese: "5124 次查看。查看帖子分析"
      var m = lbl.match(/^([\d,\.]+[KkMmBb]?)\s*次查看/);
      if (m) return parseCount(m[1]);
      // English: "5124 Views. View post analytics"
      m = lbl.match(/^([\d,\.]+[KkMmBb]?)\s+[Vv]iews?\./);
      if (m) return parseCount(m[1]);
      // Combined group label: "14 回复、13 次转帖、56 喜欢、90 书签、5124 次观看"
      m = lbl.match(/([\d,\.]+[KkMmBb]?)\s*次观看/);
      if (m) return parseCount(m[1]);
      // English combined: "5124 views"
      m = lbl.match(/([\d,\.]+[KkMmBb]?)\s+[Vv]iews?(?:[,、]|$)/);
      if (m) return parseCount(m[1]);
    }
    // Fallback: analytics button innerText (English X)
    var btn = el.querySelector('[data-testid="analytics"]');
    if (btn) {
      var spans = btn.querySelectorAll('span');
      for (var j = 0; j < spans.length; j++) {
        var n = parseCount((spans[j].innerText || spans[j].textContent || '').trim());
        if (n > 0) return n;
      }
    }
    return 0;
  }
  var results = [];
  document.querySelectorAll('[data-testid="tweet"]').forEach(function(el) {
    try {
      var statusLink = el.querySelector('a[href*="/status/"]');
      if (!statusLink) return;
      var m = statusLink.href.match(/\/status\/(\d+)/);
      if (!m) return;
      var userLink = el.querySelector('[data-testid="User-Name"] a[href^="/"]');
      var username = '';
      if (userLink) {
        var parts = userLink.href.replace(/\/$/, '').split('/');
        username = parts[parts.length - 1] || '';
      }
      var timeEl = el.querySelector('time');
      results.push({
        tweet_id: m[1],
        username: username,
        content: el.querySelector('[data-testid="tweetText"]')?.innerText || '',
        time: timeEl ? timeEl.getAttribute('datetime') : '',
        replies: actionCount(el, 'reply'),
        reposts: actionCount(el, 'retweet'),
        likes:   actionCount(el, 'like'),
        views:   viewCount(el)
      });
    } catch(e) {}
  });
  return JSON.stringify(results);
})()
"""


# ── Parsing helpers ───────────────────────────────────────────────────────────

_USERNAME_RE = re.compile(r'(?:href|url)["\s:=]+["\']?(?:https?://(?:www\.)?(?:x|twitter)\.com)?/@?([A-Za-z0-9_]{1,50})')
_FOLLOWER_RE = re.compile(
    r'([\d,\.]+[万亿]?)\s*[KkMm]?\s*(?:Followers|followers|粉丝|关注者)',
)


def _extract_usernames(snapshot: str) -> list[str]:
    """Extract unique @usernames mentioned as profile links in a snapshot."""
    found = set()
    for m in _USERNAME_RE.finditer(snapshot):
        uname = m.group(1).lower()
        # Exclude reserved paths
        if uname in {"home", "search", "explore", "notifications", "messages",
                     "settings", "i", "login", "signup", "compose", "intent",
                     "tos", "privacy", "about", "help", "support", "hashtag",
                     "twitter", "jobs", "business", "developer", "communities",
                     "spaces", "lists", "bookmarks", "trending", "who_to_follow"}:
            continue
        found.add(uname)
    return list(found)


def _parse_followers(snapshot: str) -> int | None:
    """Extract follower count from a profile page snapshot."""
    for m in _FOLLOWER_RE.finditer(snapshot):
        raw_token = m.group(1)           # e.g. "546万", "239.8M", "3,759"
        raw_full  = m.group(0)
        # Strip commas; separate numeric part from Chinese unit
        has_wan  = "万" in raw_token
        has_yi   = "亿" in raw_token
        num_str  = raw_token.replace(",", "").replace("万", "").replace("亿", "")
        try:
            n = float(num_str)
            if has_yi:
                n *= 100_000_000
            elif has_wan:
                n *= 10_000
            elif "K" in raw_full or "k" in raw_full:
                n *= 1_000
            elif "M" in raw_full or "m" in raw_full:
                n *= 1_000_000
            return int(n)
        except ValueError:
            continue
    # Fallback: look for standalone large numbers near "follower" text
    for m in re.finditer(r'(\d[\d,]{2,})\s*\n?\s*(?:Followers|followers)', snapshot):
        try:
            return int(m.group(1).replace(",", ""))
        except ValueError:
            continue
    return None


def _parse_display_name(snapshot: str, username: str) -> str:
    """Try to extract display name from profile snapshot."""
    # In camofox accessibility tree: heading "Display Name [Verified account]" [level=2]
    # Skip the keyboard-shortcuts heading (always first) and take the next level=2
    # Noise patterns that appear in all X UI languages
    _SKIP_RE = re.compile(
        r"keyboard|快捷键|who to follow|you might like|trending|what'?s happening"
        r"|'s posts$|的帖子$|的推文$",
        re.IGNORECASE,
    )
    for m in re.finditer(r'heading\s+"([^"]+)"\s+\[level=\d\]', snapshot, re.IGNORECASE):
        raw = m.group(1).strip()
        if _SKIP_RE.search(raw):
            continue
        # Strip trailing " Verified account" / " Verified"
        name = re.sub(r"\s+Verified(?:\s+account)?$", "", raw, flags=re.IGNORECASE).strip()
        # Skip site-level headings and navigation names
        if not name or name.lower() in {"x", "twitter"}:
            continue
        # If it matches "@username posts", extract the name part
        name = re.sub(r"'s posts$", "", name, flags=re.IGNORECASE).strip()
        if name and name.lower() != username.lower():
            return name[:100]
    return username


def _parse_bio(snapshot: str) -> str:
    """Extract bio from camofox accessibility-tree profile snapshot.

    In the tree the bio appears as individual `text:` lines between the
    @username line and the first "Joined …" / "Following" link.
    """
    # Locate the region between @handle mention and the "Joined" / "Following" anchor
    anchor_start = re.search(r'text:\s+"?@\S+', snapshot)
    anchor_end = re.search(r'link\s+"(?:Joined|[0-9,\.]+[KkMm]?\s+Following)', snapshot)
    if anchor_start and anchor_end and anchor_start.end() < anchor_end.start():
        region = snapshot[anchor_start.end():anchor_end.start()]
    else:
        region = snapshot

    parts: list[str] = []
    # accessibility tree lines look like:  "  - text: some content" or '  - text: "quoted"'
    for m in re.finditer(r'^[ \t]*-[ \t]+text:\s+"?([^"\n]{4,})"?\s*$', region, re.MULTILINE):
        chunk = m.group(1).strip().strip('"')
        # skip navigation / promo noise
        if re.search(r"aren.t verified|Get Verified|stand out|boosted reach|posts$|^\d", chunk, re.IGNORECASE):
            continue
        parts.append(chunk)

    return " ".join(parts)[:400]


# ── Main collection function ──────────────────────────────────────────────────

_collect_lock = _asyncio.Lock()


async def collect_x_timeline(db: AsyncSession) -> dict:
    """
    Refresh X timeline, collect recent posts + metrics, find high-follower accounts.
    Returns {"new_candidates": int, "checked": int, "new_posts": int, "error": str|None}
    """
    if _collect_lock.locked():
        return {"new_candidates": 0, "checked": 0, "new_posts": 0,
                "error": "采集任务已在运行中，跳过本次"}
    async with _collect_lock:
        return await _collect_x_timeline_inner(db)


async def _collect_x_timeline_inner(db: AsyncSession) -> dict:
    from sqlalchemy import select as _select
    from sqlalchemy.dialects.sqlite import insert as _si

    cfg = await _cfg()
    cookies_json = cfg.get("x_cookies", "")
    threshold = max(0, int(cfg.get("x_follower_threshold", 5000)))
    post_window_hours = max(1, int(cfg.get("x_post_window_hours", 4)))
    lookback_hours = max(1, int(cfg.get("x_post_lookback_hours", 24)))
    timeline_scrolls = max(1, int(cfg.get("x_timeline_scrolls", 5)))
    base, headers, user_id = await _camofox(cfg)

    if not cookies_json:
        return {"new_candidates": 0, "checked": 0, "new_posts": 0, "error": "X cookies 未配置"}

    # Import cookies first
    if cfg.get("camofox_api_key"):
        result = await import_x_cookies(cookies_json)
        if not result["ok"]:
            print(f"[x] cookie import warning: {result['error']}")

    new_candidates = 0
    checked = 0
    new_posts = 0
    now = datetime.now(timezone.utc)

    async with httpx.AsyncClient(timeout=30) as client:
        # ── Open timeline ──────────────────────────────────────────────────
        try:
            tab_id = await _create_tab(client, base, headers, user_id, "https://x.com/home")
        except Exception as e:
            return {"new_candidates": 0, "checked": 0, "new_posts": 0,
                    "error": f"打开时间线失败: {e}"}

        try:
            usernames: set[str] = set()
            # All raw tweet dicts collected this run (deduplicated by tweet_id)
            seen_tweets: dict[str, dict] = {}

            # Force a hard reload to ensure fresh timeline content (not cached)
            await _evaluate(client, base, tab_id, user_id, "window.location.reload()")
            await _asyncio.sleep(3)

            # Wait until tweets are present in the DOM (up to 15 s)
            loaded = await _wait_for_element(
                client, base, tab_id, user_id, '[data-testid="tweet"]', timeout=15, min_count=3
            )
            if not loaded:
                await _asyncio.sleep(3)  # fallback grace period

            # Scroll and collect
            for scroll_i in range(timeline_scrolls):
                # Extract tweets via JS (reliable DOM access)
                raw = await _evaluate(client, base, tab_id, user_id, _EXTRACT_TWEETS_JS)
                if not raw:
                    print(f"[x] scroll {scroll_i+1}: _evaluate returned empty — page may not be loaded yet")
                try:
                    tweets = json.loads(raw) if raw else []
                except json.JSONDecodeError as e:
                    print(f"[x] scroll {scroll_i+1}: JSON decode error: {e} (raw={raw[:100]!r})")
                    tweets = []

                print(f"[x] scroll {scroll_i+1}: extracted {len(tweets)} tweets via JS")

                for t in tweets:
                    tid = t.get("tweet_id", "")
                    if tid and tid not in seen_tweets:
                        seen_tweets[tid] = t
                    uname = (t.get("username") or "").lower()
                    if uname:
                        usernames.add(uname)

                # Also pull usernames from accessibility snapshot for breadth
                snap = await _snapshot(client, base, tab_id, headers, user_id)
                for u in _extract_usernames(snap):
                    usernames.add(u)

                await _scroll(client, base, tab_id, headers)
                # Wait for new content to load after scroll
                await _asyncio.sleep(2)

            print(f"[x] found {len(usernames)} unique usernames, {len(seen_tweets)} tweets total")

            # ── Store recent posts + metrics ───────────────────────────────
            # Pre-load follower counts for post authors already in the candidate DB
            post_authors = {(t.get("username") or "").lower() for t in seen_tweets.values() if t.get("username")}
            known_followers: dict[str, int] = {}
            for uname in post_authors:
                row = await db.get(XBloggerCandidate, uname)
                if row:
                    known_followers[uname] = row.followers

            cutoff = now.timestamp() - post_window_hours * 3600
            skipped_old = 0
            for tid, t in seen_tweets.items():
                time_str = t.get("time") or ""
                try:
                    pub_at = datetime.fromisoformat(time_str.replace("Z", "+00:00")) if time_str else now
                    pub_ts = pub_at.timestamp()
                except Exception:
                    pub_at = now
                    pub_ts = now.timestamp()

                # Skip posts older than the collect window; keep posts with unknown time
                if time_str and pub_ts < cutoff:
                    skipped_old += 1
                    continue

                uname = (t.get("username") or "").lower()
                content = t.get("content") or ""
                af = known_followers.get(uname, 0)

                # Upsert post; if author_followers later becomes known, update it
                stmt = _si(XPost).values(
                    tweet_id=tid,
                    username=uname,
                    content=content,
                    url=f"https://x.com/{uname}/status/{tid}",
                    published_at=pub_at,
                    collected_at=now,
                    author_followers=af,
                )
                if af > 0:
                    stmt = stmt.on_conflict_do_update(
                        index_elements=["tweet_id"],
                        set_={"author_followers": af},
                    )
                else:
                    stmt = stmt.on_conflict_do_nothing(index_elements=["tweet_id"])
                insert_result = await db.execute(stmt)
                if insert_result.rowcount:
                    new_posts += 1
                    age_min = round((now.timestamp() - pub_ts) / 60)
                    viral = af > 0 and t.get("views", 0) > af * 1.5
                    print(f"[x] new post @{uname} tweet_id={tid} age={age_min}min "
                          f"♥{t.get('likes',0)} 👁{t.get('views',0)}"
                          + (" 🔥viral" if viral else ""))

                # Always record metrics snapshot for recent posts
                await db.execute(
                    _si(XPostMetrics).values(
                        tweet_id=tid,
                        replies=t.get("replies", 0),
                        reposts=t.get("reposts", 0),
                        likes=t.get("likes", 0),
                        views=t.get("views", 0),
                        collected_at=now,
                    )
                )

            print(f"[x] posts: {new_posts} new, {skipped_old} older than {post_window_hours}h window skipped")

            # ── Refresh metrics for older tracked posts (up to 24 h) ────────
            # Re-visit post pages for posts not seen on current timeline scroll
            seen_ids = set(seen_tweets.keys())
            lookback = now.timestamp() - lookback_hours * 3600
            old_posts_rows = await db.execute(
                _select(XPost).where(
                    XPost.published_at >= datetime.fromtimestamp(lookback, tz=timezone.utc)
                )
            )
            old_posts = old_posts_rows.scalars().all()
            refresh_posts = [p for p in old_posts if p.tweet_id not in seen_ids]

            if refresh_posts:
                print(f"[x] refreshing metrics for {len(refresh_posts)} older posts")

            for post in refresh_posts:
                try:
                    post_tab = await _create_tab(
                        client, base, headers, user_id, post.url
                    )
                    loaded = await _wait_for_element(
                        client, base, post_tab, user_id,
                        '[data-testid="tweet"]', timeout=12, min_count=1
                    )
                    if not loaded:
                        await _asyncio.sleep(2)

                    raw = await _evaluate(client, base, post_tab, user_id, _EXTRACT_TWEETS_JS)
                    await client.delete(f"{base}/tabs/{post_tab}", headers=headers)

                    tweets = json.loads(raw) if raw else []
                    # The first tweet on the page is the post itself
                    match = next((t for t in tweets if t.get("tweet_id") == post.tweet_id), None)
                    if not match and tweets:
                        match = tweets[0]
                    if match:
                        await db.execute(
                            _si(XPostMetrics).values(
                                tweet_id=post.tweet_id,
                                replies=match.get("replies", 0),
                                reposts=match.get("reposts", 0),
                                likes=match.get("likes", 0),
                                views=match.get("views", 0),
                                collected_at=now,
                            )
                        )
                        print(f"[x] metrics @{post.username}/{post.tweet_id}: "
                              f"🔁{match.get('reposts',0)} ♥{match.get('likes',0)} 👁{match.get('views',0)}")
                except Exception as e:
                    print(f"[x] metrics refresh failed for {post.tweet_id}: {e}")

            await db.commit()

            # ── Discover new blogger candidates ────────────────────────────
            _rows = await db.execute(_select(XBloggerCandidate.username))
            known: set[str] = set(_rows.scalars().all())

            for username in usernames:
                if username in known:
                    continue

                checked += 1
                prof_snap = ""
                try:
                    prof_tab = await _create_tab(
                        client, base, headers, user_id, f"https://x.com/{username}"
                    )
                    loaded = await _wait_for_element(
                        client, base, prof_tab, user_id,
                        '[data-testid="UserName"]', timeout=12
                    )
                    if not loaded:
                        await _asyncio.sleep(3)
                    try:
                        prof_snap = await _snapshot(client, base, prof_tab, headers, user_id)
                    except Exception:
                        prof_tab = await _create_tab(
                            client, base, headers, user_id, f"https://x.com/{username}"
                        )
                        await _wait_for_element(
                            client, base, prof_tab, user_id,
                            '[data-testid="UserName"]', timeout=12
                        )
                        prof_snap = await _snapshot(client, base, prof_tab, headers, user_id)

                    prof_bio = await _evaluate(
                        client, base, prof_tab, user_id,
                        "document.querySelector('[data-testid=\"UserDescription\"]')?.innerText || ''"
                    )
                    prof_display = await _evaluate(
                        client, base, prof_tab, user_id,
                        "(document.querySelector('[data-testid=\"UserName\"] span:first-child')"
                        " || document.querySelector('h1[role=\"heading\"] span:first-child')"
                        " || document.querySelector('h2[role=\"heading\"] span:first-child'))"
                        "?.innerText || ''"
                    )
                    prof_avatar = await _evaluate(
                        client, base, prof_tab, user_id,
                        "document.querySelector('[data-testid=\"UserAvatar-Container-" + username + "\"] img,"
                        " [data-testid^=\"UserAvatar-Container\"] img')?.src || ''"
                    )
                    await client.delete(f"{base}/tabs/{prof_tab}", headers=headers)
                except Exception as e:
                    print(f"[x] profile fetch failed for @{username}: {e}")
                    continue

                followers = _parse_followers(prof_snap)
                if followers is None:
                    print(f"[x] could not parse followers for @{username}")
                    continue

                print(f"[x] @{username} followers={followers}")

                # Backfill author_followers on any posts by this user that we collected
                # this run (useful when user wasn't in candidates DB yet)
                await db.execute(
                    _update(XPost)
                    .where(XPost.username == username)
                    .where(XPost.author_followers == 0)
                    .values(author_followers=followers)
                )

                if followers >= threshold:
                    display_name = prof_display.strip() or _parse_display_name(prof_snap, username)
                    avatar_url = prof_avatar.strip() or f"https://unavatar.io/x/{username}"
                    await db.execute(
                        _sqlite_insert(XBloggerCandidate).values(
                            username=username,
                            display_name=display_name,
                            avatar_url=avatar_url,
                            followers=followers,
                            bio=prof_bio,
                            profile_url=f"https://x.com/{username}",
                            status="candidate",
                            added_at=now,
                            last_seen_at=now,
                        ).on_conflict_do_nothing(index_elements=["username"])
                    )
                    new_candidates += 1
                    print(f"[x] added candidate @{username} ({followers:,} followers)")

            await db.commit()

        finally:
            await _close_session(client, base, headers, user_id)

    return {"new_candidates": new_candidates, "checked": checked,
            "new_posts": new_posts, "error": None}
