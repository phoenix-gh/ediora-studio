import os
import uuid
from fastapi import APIRouter, UploadFile, File, HTTPException
from fastapi.responses import FileResponse

router = APIRouter(prefix="/upload", tags=["upload"])

UPLOADS_DIR = os.path.join(os.path.dirname(__file__), "..", "uploads")
ALLOWED_TYPES = {"image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml"}
MAX_SIZE = 10 * 1024 * 1024  # 10 MB


@router.post("/image")
async def upload_image(file: UploadFile = File(...)):
    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(400, f"不支持的文件类型: {file.content_type}")

    data = await file.read()
    if len(data) > MAX_SIZE:
        raise HTTPException(413, "文件超过 10MB 限制")

    ext = file.filename.rsplit(".", 1)[-1] if file.filename and "." in file.filename else "png"
    filename = f"{uuid.uuid4().hex}.{ext}"
    path = os.path.join(UPLOADS_DIR, filename)
    os.makedirs(UPLOADS_DIR, exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)

    return {"url": f"/api/uploads/{filename}", "filename": filename}


@router.get("/file/{filename}")
async def get_upload(filename: str):
    # Basic path traversal guard
    if ".." in filename or "/" in filename:
        raise HTTPException(400, "Invalid filename")
    path = os.path.join(UPLOADS_DIR, filename)
    if not os.path.isfile(path):
        raise HTTPException(404, "Not found")
    return FileResponse(path)
