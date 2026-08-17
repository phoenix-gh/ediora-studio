# 一键开发环境启动设计

## 背景

当前宿主机开发环境需要先手动启动 `wms-dev-postgres-copy`，再手动导出根目录 `.env` 中的 `WORKER_TOKEN`，最后执行 `./dev.sh`。遗漏任一步都会导致启动失败：Token 未注入时脚本在配置校验阶段退出；PostgreSQL 容器停止时 API 在数据库初始化阶段连接 `127.0.0.1:55432` 失败并触发整体回滚。

## 目标

开发者在项目根目录只执行 `./dev.sh`，脚本即可完成根环境变量加载、PostgreSQL 依赖准备、Redis、API、Worker 和 Web 的有序启动及就绪检查。

## 环境变量加载

`dev.sh` 在读取端口、Token 和运行目录配置之前自动加载项目根目录 `.env`：

- `.env` 中的变量自动导出给 API、Worker 和 Web 子进程；
- 调用命令时已经显式设置的环境变量优先，不被 `.env` 覆盖；
- `.env` 不存在时返回明确错误，提示从 `.env.example` 创建；
- `.env` 是本地可信配置，沿用 Bash `source` 语义，支持当前文件中的引号和变量引用；
- 日志和错误信息永远不打印变量值或密钥内容。

## PostgreSQL 容器准备

新增 `ensure_postgres_ready()`，在 Redis 和应用进程启动前执行：

- 容器名由 `DEV_POSTGRES_CONTAINER` 控制，默认 `wms-dev-postgres-copy`；
- 使用 `docker inspect` 判断容器是否存在和是否正在运行；
- 容器已运行时直接进入端口就绪等待；
- 容器存在但已停止时执行 `docker start <container>`；
- 容器不存在、Docker CLI 不可用、Docker daemon 不可访问或启动失败时返回明确错误；
- 使用配置项 `DEV_POSTGRES_HOST` 和 `DEV_POSTGRES_PORT` 等待 TCP 可连接，默认分别为 `127.0.0.1` 和 `55432`；
- 等待沿用 `DEV_READY_TIMEOUT_SECONDS` 与 `DEV_POLL_INTERVAL_SECONDS`；
- PostgreSQL 是外部持久化依赖，不加入 `dev.sh` 的所有权元数据和启动回滚列表。

`./dev.sh stop` 只停止 API、Worker、Web 和脚本拥有的 Redis，不停止 PostgreSQL 容器。这样既不影响数据库持久化，也能加快下一次启动。

## 启动顺序

```text
加载根目录 .env
  → 校验 Token、端口和工具
  → PostgreSQL 容器运行且 55432 可连接
  → Redis PING 就绪
  → API /health 就绪
  → Worker ready 握手有效
  → Web HTTP 就绪
```

PostgreSQL 准备失败发生在应用单元变更前，因此不会停止当前已健康运行的 API、Worker 或 Web。若数据库已就绪、后续启动阶段失败，则继续沿用现有的逆序回滚逻辑，只回滚本次由脚本创建的服务。

## 状态与输出

启动成功摘要新增 PostgreSQL 行，显示容器名和连接地址但不显示数据库密码。`./dev.sh status` 增加 PostgreSQL 状态：容器运行且端口可连接、容器已停止、容器不存在或 Docker 不可用。

## 测试

扩展 `backend/tests/test_dev_runtime.py` 的假 Docker 工具和运行环境，覆盖：

1. 未手动导出 Token 时，脚本能从临时 `.env` 加载并启动；
2. 显式环境变量覆盖 `.env`；
3. 已停止的默认 PostgreSQL 容器被启动，端口就绪后才启动 API；
4. 已运行容器不会重复启动；
5. 容器不存在、Docker 不可用和 PostgreSQL 超时会阻止应用进程启动；
6. `stop` 不停止 PostgreSQL；
7. `status` 输出 PostgreSQL 状态；
8. 现有 Redis、API、Worker、Web 所有权和回滚测试保持通过。

README 的宿主机启动说明简化为 `./dev.sh`，并说明可覆盖的容器名、Host、Port 以及 PostgreSQL 不受 `stop` 管理。
