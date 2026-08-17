# Compose 本地 data 目录持久化设计

## 目标

让 `docker-compose.yml` 所在目录下的 `data/` 成为 Ediora 自托管运行时数据的唯一宿主机持久化根目录；本次不迁移现有 Docker 命名卷，改动后用全新的隔离目录验证首次安装。

## 数据边界

必须保留的数据包括 PostgreSQL 业务库、上传/生成媒体、X/feedgrab session、Web 端上传 Skill 及其启用状态。Redis 队列、调度器节流状态、头像和微信图片缓存也落入 `data/`，其中缓存可重建，Redis 不作为业务数据的权威来源。

临时视频、音频、字幕和 Cookie 文件继续写入容器 `/tmp` 或上传目录下的临时子目录，任务完成后清理，不作为独立持久化目录。内置 Skill、前端构建产物、Python/Node 依赖属于镜像内容，不映射到 `data/`。

`.env` 不是 Docker volume，但 `POSTGRES_PASSWORD`、`WORKER_TOKEN` 和 `X_SESSION_KEY` 必须继续保留；X session 文件依赖同一个 `X_SESSION_KEY` 解密。

## 目录映射

```text
data/postgres       -> /var/lib/postgresql/data
data/redis          -> /data
data/uploads        -> /app/uploads
data/sessions       -> /app/sessions
data/web-runtime    -> /app/web/.runtime
data/scheduler      -> /app/.runtime
data/avatars        -> /app/avatars
data/wechat-images  -> /app/wechat_imgs
data/local-asr-models -> /home/ubuntu/.cache/huggingface/hub
```

调度器状态文件改为通过 `SCHEDULER_STATE_FILE` 配置到 `/app/.runtime/scheduler_state.json`，避免把整个应用目录覆盖成宿主机目录。`local-asr` 保持 profile 可选，但其模型缓存使用同一 `data/` 根目录。

## 安装和升级行为

安装脚本在启动 Compose 前创建上述目录，并将 session 目录设为仅所有者可访问。Compose 使用相对 bind mount，因此无论从哪个目录复制 `docker-compose.yml`，数据都位于该 Compose 文件旁边的 `data/`。

本次不读取、复制或删除既有命名卷。旧卷继续保留；改动后的全新 Compose 项目从空的 `data/` 目录开始。后续如需迁移，另行执行显式备份/迁移流程。

## 验证

- Compose JSON 配置中的所有持久化映射均为 `bind` 且 source 为 `./data/...`。
- Compose 配置检查和相关 Python 契约测试通过。
- 全新隔离目录使用本地应用镜像启动，API、Web、Worker、PostgreSQL、Redis 均就绪。
- 验证宿主机 `data/` 下产生 PostgreSQL、Redis、上传、session、runtime 目录，且不启动可选 `local-asr`。
