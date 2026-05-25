import asyncio
import base64
import hashlib
from datetime import datetime, timezone, timedelta
from typing import Optional, Any

from fastapi import APIRouter, HTTPException, Query, Depends
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db
from models import WechatArticle, WechatAccount, WechatCredential
import wechat_mp_client as mp
import wechat_img_cache as wimg

router = APIRouter(prefix="/wechat", tags=["wechat"])


# ── Schemas ────────────────────────────────────────────────────────────────────

class ArticleCreate(BaseModel):
    url: str


class ArticleOut(BaseModel):
    id: str
    biz: str
    account_name: str
    title: str
    url: str
    cover_url: str
    digest: str
    content: str = ""
    published_at: datetime
    collected_at: datetime
    model_config = {"from_attributes": True}


class AuthState(BaseModel):
    logged_in: bool
    nickname: str = ""
    avatar: str = ""
    expires_at: Optional[datetime] = None
    expired: bool = False


class QrCodeOut(BaseModel):
    qr_data_url: str         # base64 image data URL
    login_token: str         # opaque uuid cookie to round-trip


class LoginPoll(BaseModel):
    login_token: str


class PollOut(BaseModel):
    status: int
    acct_size: int = 0


class FinalizeOut(BaseModel):
    nickname: str = ""
    avatar: str = ""
    expires_at: datetime


class AccountCandidate(BaseModel):
    fakeid: str
    nickname: str
    alias: str = ""
    round_head_img: str = ""
    service_type: int = 0


class AccountSubscribe(BaseModel):
    fakeid: str
    nickname: str
    alias: str = ""
    avatar: str = ""


class AccountOut(BaseModel):
    biz: str
    name: str
    avatar_url: str
    description: str = ""
    muted: bool = False
    last_collected_at: Optional[datetime] = None
    model_config = {"from_attributes": True}


class SyncResult(BaseModel):
    biz: str
    new_articles: int
    total_seen: int


# ── Helpers ────────────────────────────────────────────────────────────────────

async def _get_active_credential(db: AsyncSession) -> WechatCredential:
    cred = await db.get(WechatCredential, 1)
    if not cred or not cred.token or not cred.cookie:
        raise HTTPException(401, "未登录公众平台，请先扫码登录")
    if cred.expires_at and cred.expires_at <= datetime.now(timezone.utc):
        raise HTTPException(401, "公众平台登录已过期，请重新扫码")
    return cred


async def _mark_credential_expired(db: AsyncSession) -> None:
    cred = await db.get(WechatCredential, 1)
    if cred:
        cred.expires_at = datetime.now(timezone.utc)
        await db.commit()


def _article_id(url: str) -> str:
    return hashlib.md5(url.encode()).hexdigest()


async def _sync_account(db: AsyncSession, account: WechatAccount,
                        token: str, cookie: str, pages: int = 1,
                        page_size: int = 20) -> SyncResult:
    new_count = 0
    total_seen = 0
    for p in range(pages):
        try:
            articles, _total = await mp.list_articles(
                fakeid=account.biz, token=token, cookie=cookie,
                begin=p * page_size, count=page_size,
            )
        except mp.SessionExpired:
            await _mark_credential_expired(db)
            raise HTTPException(401, "公众平台登录已过期，请重新扫码")
        if not articles:
            break
        total_seen += len(articles)
        for entry in articles:
            link = entry.get("link") or ""
            if not link:
                continue
            aid = _article_id(link)
            if await db.get(WechatArticle, aid):
                continue
            ts = int(entry.get("create_time") or entry.get("update_time") or 0)
            published_at = (datetime.fromtimestamp(ts, tz=timezone.utc)
                            if ts else datetime.now(timezone.utc))
            db.add(WechatArticle(
                id=aid,
                biz=account.biz,
                account_name=account.name,
                title=(entry.get("title") or "")[:500],
                url=link,
                cover_url=entry.get("cover") or "",
                digest=(entry.get("digest") or "")[:1000],
                published_at=published_at,
            ))
            new_count += 1
        # be gentle to avoid risk-control throttling
        if p < pages - 1:
            await asyncio.sleep(2)
    account.last_collected_at = datetime.now(timezone.utc)
    await db.commit()
    return SyncResult(biz=account.biz, new_articles=new_count, total_seen=total_seen)


# ── Articles (existing) ────────────────────────────────────────────────────────

@router.get("/articles", response_model=list[ArticleOut])
async def list_articles_endpoint(
    biz: Optional[str] = Query(None),
    account: Optional[str] = Query(None),
    days: int = Query(365, ge=1, le=3650),
    limit: int = Query(200, le=1000),
    search: Optional[str] = Query(None),
    db: AsyncSession = Depends(get_db),
):
    since = datetime.now(timezone.utc) - timedelta(days=days)
    q = (
        select(WechatArticle)
        .where(WechatArticle.published_at >= since)
        .order_by(desc(WechatArticle.published_at))
        .limit(limit)
    )
    if biz:
        q = q.where(WechatArticle.biz == biz)
    if account:
        q = q.where(WechatArticle.account_name == account)
    if search:
        q = q.where(WechatArticle.title.contains(search))
    rows = (await db.execute(q)).scalars().all()
    return rows


@router.post("/articles", response_model=ArticleOut, status_code=201)
async def add_article(body: ArticleCreate, db: AsyncSession = Depends(get_db)):
    from wechat_collector import save_article
    try:
        article = await save_article(body.url, db)
    except Exception as e:
        raise HTTPException(400, f"无法抓取文章：{e}")
    return article


@router.get("/articles/{article_id}", response_model=ArticleOut)
async def get_article(article_id: str, db: AsyncSession = Depends(get_db)):
    """Get a single article with body. Lazy-fetches the rich_media_content
    block from mp.weixin.qq.com the first time content is needed."""
    art = await db.get(WechatArticle, article_id)
    if not art:
        raise HTTPException(404, "Article not found")
    if not art.content and art.url:
        from wechat_collector import fetch_article_body
        try:
            body = await fetch_article_body(art.url)
        except Exception as e:
            raise HTTPException(502, f"正文抓取失败：{e}")
        if body:
            art.content = body
            await db.commit()
            await db.refresh(art)
    return art


@router.delete("/articles/{article_id}", status_code=204)
async def delete_article(article_id: str, db: AsyncSession = Depends(get_db)):
    article = await db.get(WechatArticle, article_id)
    if not article:
        raise HTTPException(404, "Article not found")
    await db.delete(article)
    await db.commit()


# ── Auth (QR-code login) ───────────────────────────────────────────────────────

@router.get("/auth/state", response_model=AuthState)
async def auth_state(db: AsyncSession = Depends(get_db)):
    cred = await db.get(WechatCredential, 1)
    if not cred or not cred.token:
        return AuthState(logged_in=False)
    expired = bool(cred.expires_at and cred.expires_at <= datetime.now(timezone.utc))
    return AuthState(
        logged_in=not expired,
        nickname=cred.nickname,
        avatar=cred.avatar,
        expires_at=cred.expires_at,
        expired=expired,
    )


@router.post("/auth/qrcode", response_model=QrCodeOut)
async def auth_qrcode():
    try:
        png, uuid_cookie = await mp.get_qrcode()
    except Exception as e:
        raise HTTPException(502, f"获取登录二维码失败：{e}")
    qr_b64 = base64.b64encode(png).decode("ascii")
    return QrCodeOut(
        qr_data_url=f"data:image/png;base64,{qr_b64}",
        login_token=uuid_cookie,
    )


@router.post("/auth/poll", response_model=PollOut)
async def auth_poll(body: LoginPoll):
    try:
        data = await mp.poll_scan(body.login_token)
    except Exception as e:
        raise HTTPException(502, f"轮询扫码状态失败：{e}")
    return PollOut(
        status=int(data.get("status", 0) or 0),
        acct_size=int(data.get("acct_size", 0) or 0),
    )


@router.post("/auth/finalize", response_model=FinalizeOut)
async def auth_finalize(body: LoginPoll, db: AsyncSession = Depends(get_db)):
    try:
        token, cookie = await mp.complete_login(body.login_token)
    except Exception as e:
        raise HTTPException(400, f"完成登录失败：{e}")
    expires = datetime.now(timezone.utc) + timedelta(hours=2)
    cred = await db.get(WechatCredential, 1)
    if not cred:
        cred = WechatCredential(id=1)
        db.add(cred)
    cred.token = token
    cred.cookie = cookie
    cred.expires_at = expires
    # nickname/avatar can be filled later by /accounts/search self-call; leave empty for now
    await db.commit()
    return FinalizeOut(nickname=cred.nickname, avatar=cred.avatar, expires_at=expires)


@router.post("/auth/logout", status_code=204)
async def auth_logout(db: AsyncSession = Depends(get_db)):
    cred = await db.get(WechatCredential, 1)
    if cred:
        await db.delete(cred)
        await db.commit()


# ── Account subscription ──────────────────────────────────────────────────────

@router.get("/accounts/search", response_model=list[AccountCandidate])
async def accounts_search(
    query: str = Query(..., min_length=1),
    begin: int = Query(0, ge=0),
    count: int = Query(5, ge=1, le=5),
    db: AsyncSession = Depends(get_db),
):
    cred = await _get_active_credential(db)
    try:
        items = await mp.search_biz(query, cred.token, cred.cookie, begin, count)
    except mp.SessionExpired:
        await _mark_credential_expired(db)
        raise HTTPException(401, "公众平台登录已过期，请重新扫码")
    except Exception as e:
        raise HTTPException(502, f"搜索公众号失败：{e}")
    return [
        AccountCandidate(
            fakeid=str(it.get("fakeid", "")),
            nickname=it.get("nickname", "") or "",
            alias=it.get("alias", "") or "",
            round_head_img=it.get("round_head_img", "") or "",
            service_type=int(it.get("service_type", 0) or 0),
        )
        for it in items if it.get("fakeid")
    ]


@router.get("/accounts", response_model=list[AccountOut])
async def accounts_list(db: AsyncSession = Depends(get_db)):
    q = select(WechatAccount).order_by(desc(WechatAccount.created_at))
    rows = (await db.execute(q)).scalars().all()
    return rows


@router.post("/accounts", response_model=AccountOut, status_code=201)
async def accounts_subscribe(body: AccountSubscribe, db: AsyncSession = Depends(get_db)):
    if not body.fakeid or not body.nickname:
        raise HTTPException(400, "fakeid 和 nickname 必填")
    existing = await db.get(WechatAccount, body.fakeid)
    if existing:
        existing.name = body.nickname
        existing.avatar_url = body.avatar
        existing.note = body.alias
        await db.commit()
        return existing
    acc = WechatAccount(
        biz=body.fakeid,
        name=body.nickname,
        avatar_url=body.avatar,
        note=body.alias,
    )
    db.add(acc)
    await db.commit()
    await db.refresh(acc)
    return acc


@router.delete("/accounts/{biz}", status_code=204)
async def accounts_unsubscribe(biz: str, db: AsyncSession = Depends(get_db)):
    acc = await db.get(WechatAccount, biz)
    if not acc:
        raise HTTPException(404, "未找到该订阅账号")
    # Clean up the account's articles (no FK in the schema, so we delete by
    # biz manually). Bulk delete to avoid pulling thousands of rows into
    # memory just to drop them.
    from sqlalchemy import delete as sa_delete
    await db.execute(sa_delete(WechatArticle).where(WechatArticle.biz == biz))
    await db.delete(acc)
    await db.commit()


@router.get("/img")
async def wechat_img_proxy(url: str = Query(..., min_length=10)):
    """Proxy a mmbiz.qpic.cn / weixin image through the local cache.

    Tencent's hotlinking guard rejects browser loads cross-origin; we fetch
    server-side with the WeChat UA + Referer and serve the bytes from disk.
    """
    if "qpic.cn" not in url and "weixin" not in url:
        raise HTTPException(400, "仅允许代理微信图片域名")
    path = wimg.cached_path(url) or await wimg.fetch_and_cache(url)
    if not path:
        raise HTTPException(502, "图片下载失败")
    return FileResponse(path, headers={"Cache-Control": "public, max-age=2592000"})


@router.post("/accounts/{biz}/sync", response_model=SyncResult)
async def accounts_sync(
    biz: str,
    pages: int = Query(1, ge=1, le=10),
    db: AsyncSession = Depends(get_db),
):
    acc = await db.get(WechatAccount, biz)
    if not acc:
        raise HTTPException(404, "未找到该订阅账号")
    cred = await _get_active_credential(db)
    return await _sync_account(db, acc, cred.token, cred.cookie, pages=pages)
