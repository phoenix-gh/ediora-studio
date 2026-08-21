<div align="center">

# Ediora · 述策

**面向个人创作者的 AI 内容工作台**

收集信息，筛选选题，写草稿，做素材，准备发布。

<p>
  <a href="docs/user-guide/README.md">使用文档</a> ·
  <a href="docs/user-guide/quick-start.md">快速上手</a> ·
  <a href="docs/self-hosted.md">自托管部署</a> ·
  <a href="https://x.com/Mk_Flow">X / @Mk_Flow</a>
</p>

<p>
  <a href="https://github.com/phoenix-gh/ediora-studio/stargazers">
    <img src="https://img.shields.io/github/stars/phoenix-gh/ediora-studio?style=flat-square" alt="GitHub stars" />
  </a>
  <a href="https://github.com/phoenix-gh/ediora-studio/issues">
    <img src="https://img.shields.io/github/issues/phoenix-gh/ediora-studio?style=flat-square" alt="GitHub issues" />
  </a>
</p>

</div>

<p align="center">
  <img src="docs/images/ediora-readme-hero.png" alt="Ediora 将分散的信息流汇聚成内容创作流程的主视觉" width="100%" />
</p>

Ediora 是一个 AI 内容工作台，用来收集信息、筛选选题、生成草稿，并完成配图、视频和发布前准备。

它支持 RSS、YouTube、Reddit、GitHub、arXiv、X 等信息源，也支持多个 AI 模型服务。你可以把它部署在自己的机器上，把内容、任务和素材放在一起管理。

## 主要功能

- **内容采集**：把平时关注的网站和账号集中到一起
- **内容筛选**：从大量信息里找出值得继续看的内容
- **AI 写作**：根据内容或主题生成文章草稿
- **素材制作**：生成封面、配图、文字视频和数字人口播
- **发布准备**：整理草稿、素材和目标平台格式

## 核心工作流

```text
采集内容 → 判断价值 → 创建创作任务 → 编辑草稿 → 生成素材/视频 → 发布前检查
```

Ediora 负责把信息、任务、草稿和素材组织起来；最终的发布动作仍由你确认，不会因为后台任务完成就自动发布内容。

## 快速开始

### 第一次使用

如果服务已经启动，建议从[快速上手](docs/user-guide/quick-start.md)开始。它用一条连续路径带你完成首次配置、内容采集、创作任务和草稿编辑。

完整的用户文档按下面的顺序组织：

1. [首次设置](docs/user-guide/setup.md)
2. [内容采集](docs/user-guide/collect-content.md)
3. [内容筛选](docs/user-guide/select-content.md)
4. [创建草稿](docs/user-guide/create-draft.md)
5. [编辑草稿与发布准备](docs/user-guide/edit-and-prepare.md)

### 自托管部署

Linux 和 macOS 可以使用一键安装器。它会准备 Docker Compose、创建运行时数据目录、拉取应用镜像并启动服务：

```bash
curl -fsSL https://raw.githubusercontent.com/phoenix-gh/ediora-studio/main/install.sh | sh
```

启动后打开 <http://localhost:3000>。LLM、图片、语音和 HeyGen 凭据在 Ediora 的“设置”页面配置，不通过安装器收集，也不要写入浏览器端环境变量。

已有完整 checkout 时，也可以直接运行：

```bash
./install.sh
```

完整的系统要求、数据目录、升级备份、GHCR 镜像和故障恢复说明见[自托管部署文档](docs/self-hosted.md)。

### 本地开发

宿主机开发从项目根目录启动：

```bash
cp .env.example .env
# 编辑 .env，设置至少 32 个字符的 WORKER_TOKEN
./dev.sh
```

默认地址：

| 服务 | 地址 |
| --- | --- |
| Web | <http://localhost:3000> |
| API | <http://localhost:8000> |
| API 健康检查 | <http://localhost:8000/health> |

常用命令：

```bash
./dev.sh status
./dev.sh logs --no-follow
./dev.sh restart
./dev.sh stop
```

## 功能导航

| 你想完成的事情 | 文档 |
| --- | --- |
| 查看完整用户文档 | [用户文档首页](docs/user-guide/README.md) |
| 配置 AI 模型、账号和数据源 | [首次设置](docs/user-guide/setup.md) |
| 从信息源获取内容 | [内容采集](docs/user-guide/collect-content.md) |
| 筛选内容并建立创作线索 | [内容筛选](docs/user-guide/select-content.md) |
| 提交 AI 创作任务并找到结果 | [创建草稿](docs/user-guide/create-draft.md) |
| 编辑正文、检查素材和目标平台格式 | [编辑草稿](docs/user-guide/edit-and-prepare.md) |
| 查看日志、取消或安全重试任务 | [任务管理](docs/user-guide/task-management.md) |
| 排查模型、采集、任务和素材问题 | [问题排查](docs/user-guide/troubleshooting.md) |
| 制作文字视频 | [文字视频](docs/user-guide/text-video.md) |
| 制作数字人口播 | [数字人口播](docs/user-guide/digital-human.md) |
| 配置 Chrome 扩展 | [Chrome 扩展说明](chrome-extension/README.md) |
| 部署和运维 | [自托管部署](docs/self-hosted.md) |

## 重点能力与边界

### 文字视频

「创作 → 文字视频」会根据主音频和转写词级时间轴驱动 Remotion 动态文字场景，支持预览、生成、播放和下载 MP4。完整操作和当前限制见[文字视频文档](docs/user-guide/text-video.md)。

### 数字人口播

「创作 → 数字人口播」支持 HeyGen 以及 ComfyUI / MiniMax H3 路径，可管理角色、脚本、环境图和成片版本。完整的双后端流程见[数字人口播文档](docs/user-guide/digital-human.md)。

### X 即时响应助手

系统可以关注指定的 X 时间线账号，在新帖采集后判断是否值得评论、翻译引用转发、继续观察或忽略，并把建议推送到待响应页面或 Telegram。

> **重要边界：** X 即时响应只生成和推送建议，永远不会自动调用 X 的发布、回复、转发或引用接口。

## 技术架构

| 层 | 技术与职责 |
| --- | --- |
| Web | Next.js App Router 16、React、Tailwind CSS、shadcn/ui |
| API | FastAPI、async SQLAlchemy、PostgreSQL、APScheduler |
| AI | OpenAI、Anthropic、DeepSeek、通义千问、Moonshot、GLM、MiniMax、MiMo 及自定义 Provider |
| 任务 | PostgreSQL 持久化任务状态、Redis 队列、Next.js AI SDK Node worker |
| 采集 | feedgrab、RSS/Atom、yt-dlp、GitHub REST API 等适配器 |
| 扩展 | Chrome Extension，用于浏览器内的发布辅助和工作台入口 |

```text
信息源 ──→ FastAPI 采集层 ──→ PostgreSQL 内容与任务状态
                              │
Web ─────→ FastAPI API ────────┼──→ Redis ──→ Node 内容 Worker
                              │                    │
Chrome 扩展 ───────────────→ API              草稿 / 素材 / 视频
```

## 数据源

| 类别 | 来源 |
| --- | --- |
| 信息流 | RSS、YouTube、Reddit、V2EX |
| 技术内容 | GitHub Issues / Releases / Trending、arXiv、掘金、36 氪 |
| 社交内容 | X 时间线、微信公众号文章 |
| 产品发现 | Product Hunt |

## 项目结构

```text
Ediora/
├── backend/             FastAPI API、采集器、任务调度和数据库模型
├── web/                 Next.js Web 应用和 AI SDK worker
├── chrome-extension/    Chrome 浏览器扩展
├── docs/                用户使用与自托管文档
├── docker-compose.yml   自托管运行时
└── dev.sh               宿主机开发启动脚本
```

## 安全与运行边界

- Provider API Key、X session、Telegram Token 和 HeyGen 凭据由服务端保存，不能提交到 Git，也不要放入 `NEXT_PUBLIC_` 环境变量。
- 自托管运行数据默认保存在 Compose 文件旁的 `data/` 目录；升级前应备份数据库、上传资产、session、运行时 Skill 和 `.env`。
- 运行时只支持 PostgreSQL；Redis 用于队列传输，任务权威状态保存在 PostgreSQL。
- 任务执行不会代替人工确认发布；可能产生模型费用的重试操作应由操作者明确发起。

## 安装器高级选项

<details>
<summary>查看远程安装、目录选择和自动化参数</summary>

也可以先下载单文件安装器，再在目标目录运行：

```bash
curl -fsSLo install.sh https://raw.githubusercontent.com/phoenix-gh/ediora-studio/main/install.sh
chmod +x install.sh
./install.sh
```

远程命令或单独下载的安装器会让你选择安装目录：

- `1` 当前目录
- `2` `$HOME/ediora-studio`（默认）
- `3` 自定义目录

自动化场景可以用环境变量跳过目录询问：

```bash
EDIORA_INSTALL_DIR=/srv/ediora ./install.sh --yes
```

安装器只负责 Docker 环境检查、Compose 文件、运行时数据目录、镜像拉取和启动，不负责构建应用镜像。需要本地构建时，请在完整源码 checkout 中执行：

```bash
docker compose build api
docker compose up -d --no-build
```

</details>

## 参与与联系

- 提交问题或功能建议：[GitHub Issues](https://github.com/phoenix-gh/ediora-studio/issues)
- 关注项目与交流产品方向：[X / Twitter：@Mk_Flow](https://x.com/Mk_Flow)
- 从[用户文档首页](docs/user-guide/README.md)开始了解完整使用路径
