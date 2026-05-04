from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from avatar_cache import cached_path, fetch_and_cache, fetch_via_browser
from database import SessionLocal
from models import XBloggerCandidate

router = APIRouter(prefix="/avatars", tags=["avatars"])


@router.get("/x/{username}")
async def x_avatar(username: str):
    # 1. Serve from local cache
    path = cached_path(username)
    if path:
        return FileResponse(path)

    # 2. Look up source URL from DB; fall back to unavatar.io if empty
    async with SessionLocal() as db:
        candidate = await db.get(XBloggerCandidate, username)
    if not candidate:
        raise HTTPException(404, "Candidate not found")
    source_url = candidate.avatar_url or f"https://unavatar.io/x/{username}"

    # 3. Try direct HTTP download (fast path)
    path = await fetch_and_cache(username, source_url)
    if path:
        return FileResponse(path)

    # 4. Fall back to browser-based extraction (bypasses unavatar.io rate limits)
    path = await fetch_via_browser(username)
    if path:
        return FileResponse(path)

    raise HTTPException(502, "Failed to fetch avatar")
