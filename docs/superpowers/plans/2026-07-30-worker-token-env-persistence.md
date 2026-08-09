# WMS Worker Token 本机持久化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将当前健康 API 容器使用的 `WMS_WORKER_TOKEN` 安全持久化到根目录 `.env`，供后续 Docker Compose 重建自动复用。

**Architecture:** 根目录 `.env` 作为本机 Compose 环境文件，只保存当前 token。先用 `apply_patch` 创建无敏感信息的占位文件，再从 API 容器读取 token、严格验证后进行一次机械替换；所有验证只输出长度和一致性，不输出值。

**Tech Stack:** Docker Compose、Git ignore、POSIX shell、sed。

## Global Constraints

- 不输出或提交 token。
- 不生成或轮换 token。
- 不重启 API、Worker 或 Web。
- `.env` 权限必须为 `600`。
- `.env` 必须继续被 Git 忽略。
- 只写入 `WMS_WORKER_TOKEN`，不迁移其他密钥。

---

### Task 1: 安全创建本机 Compose 环境文件

**Files:**
- Create: `.env`（Git 忽略，本机密钥文件）

**Interfaces:**
- Consumes: `main-runtime-api-1` 容器中的 `WMS_WORKER_TOKEN`
- Produces: 根目录 `.env` 中同值的 `WMS_WORKER_TOKEN`

- [x] **Step 1: 创建不含密钥的占位文件**

使用 `apply_patch` 创建：

```dotenv
WMS_WORKER_TOKEN=__WMS_CURRENT_RUNTIME_TOKEN__
```

- [x] **Step 2: 验证并机械替换占位值**

从 `main-runtime-api-1` 的环境变量中读取 token，只在 shell 变量中保存。依次验证：

```text
token 存在
长度至少 32
只包含 A-Z、a-z、0-9、点、下划线、波浪号或连字符
.env 仍包含唯一占位符
```

验证全部通过后，用 `sed -i` 将占位符替换为 shell 变量中的当前 token，并立即 `chmod 600 .env`。命令不得回显 token。

- [x] **Step 3: 验证文件安全性**

Run:

```bash
git check-ignore -v .env
stat -c '%a' .env
```

Expected: `.gitignore` 命中 `.env`，权限为 `600`。

读取 `.env` 时只输出：

```text
dotenv_token_present=true
dotenv_token_length=64
```

不得输出 token 值。

- [x] **Step 4: 验证运行时一致性**

读取 `.env`、API 容器和 Worker 容器的 token 到 shell 变量，比较字符串是否完全一致，只输出：

```text
api_matches_dotenv=true
worker_matches_dotenv=true
```

运行 `docker compose config --format json`，通过 `jq` 只输出 API、Worker 和 Web 解析后 token 的字符长度。Expected: 三者长度均为 64。

- [x] **Step 5: 验证 Git 与服务状态**

Run:

```bash
git status --short
docker compose -p main-runtime ps api worker web
```

Expected: `git status` 不包含 `.env`；三个服务均保持运行，API 保持 healthy。
