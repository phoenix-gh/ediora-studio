# Single-File Remote Installer via `curl | sh`

## Goal

让用户在 Linux 或 macOS 的 terminal 中直接执行
`curl -fsSL .../install.sh | sh`，不需要先 clone 仓库、不需要额外的
`install.bash` 文件，也不改变现有 Docker Compose 安装行为。

## Design

- `install.sh` 是唯一安装器，并且完整使用 POSIX `sh` 语法。
- 管道执行时，脚本通过当前 stdin 直接运行；它不会重新下载自身。
- 当缺少本地 checkout 时，安装器只下载 GitHub 仓库归档，将完整 checkout
  落到 `EDIORA_INSTALL_DIR`，然后从落地的 `install.sh` 继续执行。
- 归档下载和本地执行都支持 `--yes`、`--build`、`--help`。

## Platform behavior

- Linux 上已有 Docker Engine/Compose v2 时允许继续执行，不要求发行版必须是
  Ubuntu。
- Docker 不可用时，仅 Ubuntu 22.04/24.04 可以在确认后通过官方 apt 仓库自动
  安装 Docker。
- macOS 要求 Docker Desktop 已安装并运行；缺失时输出 Docker Desktop 安装
  地址并退出，不执行 apt 或 sudo Docker 包安装。
- 其他系统报告不支持并退出。

## Preserved behavior

继续保留 `.env` 值、`data/` 持久化目录、GHCR 默认镜像、Compose 启动顺序、
Settings 中配置第三方凭据，以及 `local-asr` 作为显式可选 profile。

## Verification

- `sh -n install.sh`。
- `curl` 管道等价测试：`cat install.sh | sh -s -- --help`。
- 安装器合同测试覆盖远程归档落地、Ubuntu、已有 Docker 的其他 Linux、macOS
  Docker Desktop 提示和现有 Compose 流程。
- Linux 上运行 `bash scripts/test-install.sh` 与 Compose 配置检查。
