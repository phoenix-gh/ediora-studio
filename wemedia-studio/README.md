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
