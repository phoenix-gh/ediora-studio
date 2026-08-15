# Spike: feedgrab Python API — X (Twitter) Integration

Date: 2026-05-25  
feedgrab version: 0.24.1 (commit b1a58d3)

---

## Install result

```
pip install "feedgrab[all] @ git+https://github.com/iBigQiang/feedgrab.git"
Successfully installed feedgrab-0.24.1
```

All deps already present in wems env. Clean install.

---

## Python entry points

`import feedgrab; dir(feedgrab)` — top-level namespace is minimal:
```
['__builtins__', '__cached__', '__doc__', '__file__', '__loader__',
 '__name__', '__package__', '__path__', '__spec__', '__version__']
```

No re-exports at package root. Public API lives in two layers:

**`feedgrab.reader.UniversalReader`** — high-level async dispatcher:
```python
from feedgrab.reader import UniversalReader

r = UniversalReader()
content: UnifiedContent = await r.read(url)          # single URL
contents: list[UnifiedContent] = await r.read_batch(urls)  # concurrent
```
Routes `x.com/<username>` → `twitter_user_tweets` fetcher; `x.com/<id>/status/<id>` → `twitter` (single tweet).

**`feedgrab.schema.UnifiedContent`** — dataclass returned by all fetchers:
```python
UnifiedContent(
    source_type: SourceType,   # SourceType.TWITTER
    source_name: str,          # "@screen_name"
    title: str,
    content: str,              # rendered Markdown
    url: str,
    id: str,                   # tweet_id
    fetched_at: str,
    media_type: MediaType,
    media_url: Optional[str],
    score: int,
    priority: Priority,
    category: str,
    tags: List[str],
    extra: dict,               # images, videos, user_id, created_at, metrics
)
```

---

## X-related submodules

```
feedgrab.fetchers.twitter               # single-tweet fetch (GraphQL)
feedgrab.fetchers.twitter_api           # v2 REST API alt
feedgrab.fetchers.twitter_api_user_tweets
feedgrab.fetchers.twitter_bookmarks
feedgrab.fetchers.twitter_cookies       # multi-account cookie rotation
feedgrab.fetchers.twitter_fxtwitter     # circuit-breaker via fxtwitter.com
feedgrab.fetchers.twitter_graphql       # raw GraphQL page fetchers
feedgrab.fetchers.twitter_keyword_search  # keyword/advanced search
feedgrab.fetchers.twitter_list_tweets
feedgrab.fetchers.twitter_markdown
feedgrab.fetchers.twitter_retweeters
feedgrab.fetchers.twitter_search_people
feedgrab.fetchers.twitter_search_tweets
feedgrab.fetchers.twitter_thread
feedgrab.fetchers.twitter_user_lists
feedgrab.fetchers.twitter_user_tweets   # timeline (paginated GraphQL)
```

---

## Timeline call

`UniversalReader.read("https://x.com/<username>")` dispatches to
`fetch_user_tweets(profile_url, cookies, mode="tweets")` in `twitter_user_tweets`.

Signature:
```python
async def fetch_user_tweets(
    profile_url: str,
    cookies: dict,   # {"auth_token": "...", "ct0": "..."}
    mode: str = "tweets"   # "tweets" | "likes" | "replies"
) -> dict:
    # returns: {total, fetched, skipped, failed, list_path}
```

Without cookies the call raises:
```
RuntimeError: 未找到 Twitter Cookie，请先运行: feedgrab login twitter
```

When authenticated (sessions/twitter.json present), the function paginates
UserTweets GraphQL and writes per-tweet Markdown files, returning a summary dict.
The `UniversalReader.read()` wrapper converts that into a `UnifiedContent`
with `content` = rendered Markdown of the whole batch summary.

---

## Keyword search

Direct Python import — **viable**:
```python
from feedgrab.fetchers.twitter_keyword_search import search_twitter_keyword

result = await search_twitter_keyword(
    keyword="AI",
    lang="zh",
    days=1,
    min_faves=0,
    sort="live",           # "live" = Latest, "top" = Top
    max_results=100,
    exclude_retweets=True,
    save_tweets=False,
)
# returns: {total, saved, query, output_path, csv_path, tweets: list[dict]}
# tweets[i]: {id, url, text, user, metrics, created_at, ...}
```

Each tweet dict in `result["tweets"]` is the raw parsed entry before
`UnifiedContent` wrapping — use `feedgrab.schema.from_twitter(tweet_dict)`
to convert.

CLI equivalent (confirmed working in this env):
```
feedgrab x-so "query" [--lang zh] [--days 1] [--sort live|top]
```

---

## Auth configuration

Priority order (from `twitter_cookies.py` docstring):

1. **Env vars**: `X_AUTH_TOKEN` + `X_CT0`
2. **Cookie file**: `sessions/x.json` (or `x_2.json`, `x_3.json` for rotation)
3. **Playwright session**: `sessions/twitter.json`
4. **Chrome CDP**: running Chrome with `--remote-debugging-port` (port via `CHROME_CDP_PORT`, default 9222)

`sessions/` directory is resolved via `FEEDGRAB_DATA_DIR` env var (default: `sessions` relative to cwd).

Multi-account rotation: place `sessions/x.json`, `sessions/x_2.json`, etc.
On 429, call `mark_cookie_rate_limited()` — the loader skips that token for 15 min.

For Ediora integration: set `X_AUTH_TOKEN` + `X_CT0` as env vars,
or write `sessions/x.json` from stored credentials.

---

## Decision

**Python import: viable for both timeline + search**

- `fetch_user_tweets(url, cookies)` — direct async call, returns structured dict
- `search_twitter_keyword(keyword, ...)` — direct async call, returns `{tweets: list[dict]}`
- Both are well-documented, typed, and tested in this env
- `UnifiedContent` is a clean dataclass — no subprocess required
- Auth is injectable via env vars (`X_AUTH_TOKEN` / `X_CT0`) — no file-side config needed
- No subprocess needed

---

## Timeline read approach

**Choice: Option 4 — lower-level GraphQL paginator (`fetch_user_by_screen_name` +
`fetch_user_tweets_page` + `parse_user_tweets_entries` + `extract_tweet_data`).**

Rationale: `fetch_user_tweets()` only returns a summary dict + writes Markdown files;
the `list_path` JSON uses a reduced status record shape (no `text`/`likes`/`views`).
Going one level lower gives us the full `extract_tweet_data` dicts — the same flat
shape used by keyword search — without writing any files. `UniversalReader.read()`
wraps this but discards the tweet list entirely (returns a text summary `UnifiedContent`).
The lower-level path is already well-tested in the feedgrab codebase itself.
