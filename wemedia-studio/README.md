# WeMedia Studio Frontend

Next.js 前端应用。请从本目录启动前端服务：

```bash
cd /workspace/projects/WeMediaStudio/wemedia-studio
pnpm dev
```

前端默认访问 `http://localhost:3000`，API 地址由 `.env.local` 配置：

```bash
NEXT_PUBLIC_API_URL=http://localhost:8000/api
```

后端必须从项目的 `backend/` 目录启动，否则 SQLite 的相对路径会指向错误位置。完整启动说明见项目根目录 `README.md`。

## 数字人口播本地开发

数字人口播由 Python API 保存角色、作品、版本与创作资产，Node worker 调用 HeyGen。宿主机开发时三项服务建议分别启动：

```bash
# 先生成一个长随机 token，并让 API 与 worker 共用
export WMS_WORKER_TOKEN="$(openssl rand -hex 32)"

# API（项目 backend 目录）
WMS_WORKER_TOKEN="$WMS_WORKER_TOKEN" WMS_REDIS_URL=redis://127.0.0.1:6379/0 conda run -n wems uvicorn main:app --host 0.0.0.0 --port 8000

# worker（本目录）
WMS_WORKER_TOKEN="$WMS_WORKER_TOKEN" WMS_REDIS_URL=redis://127.0.0.1:6379/0 WMS_API_URL=http://127.0.0.1:8000/api pnpm jobs:worker

# Web（本目录）
pnpm dev
```

HeyGen API Key 优先在「设置 → HeyGen」保存，也可在 API 环境中设置 `HEYGEN_API_KEY` 作为回退。角色素材只接受 PNG/JPEG 与 MP3/WAV，且发送给 HeyGen 的单文件上限为 32MB。声音克隆要求 HeyGen 套餐具备相应权限；成片完成后会被下载到后端本地 uploads，而不是长期引用 HeyGen 的临时 URL。
