---
name: codex_imagegen
description: "Generate images via Codex CLI's built-in image_gen tool — no OPENAI_API_KEY needed. Use when the user asks to generate an image with Codex, or as fallback when baoyu-imagine isn't configured."
category: custom
tags: [image-generation, codex, cli]
---

# Codex ImageGen

通过 Codex CLI 内置 `image_gen` 工具生成图片，无需额外 API Key。

## 脚本位置

脚本内嵌在本 skill 的 `scripts/` 目录中：

```
scripts/
├── main.py             # Python 主脚本
├── codex-imagegen.sh   # Bash 包装器（与 baoyu-cover-image 一致）
```

调用方式（`${HERMES_SKILL_DIR}` 由 Hermes 在加载 skill 时替换为本目录绝对路径）：

```bash
python "${HERMES_SKILL_DIR}/scripts/main.py" [options]
```

```bash
"${HERMES_SKILL_DIR}/scripts/codex-imagegen.sh" [options]
```

## CLI 用法

```bash
# 基础用法
python "${HERMES_SKILL_DIR}/scripts/main.py" \
  --image output.png \
  --prompt "A cute cat in cyberpunk style"

# 16:9 横版
python "${HERMES_SKILL_DIR}/scripts/main.py" \
  --image hero.png \
  --prompt "Landscape" --aspect 16:9

# 带参考图
python "${HERMES_SKILL_DIR}/scripts/main.py" \
  --image out.png \
  --prompt "Same style as reference" --ref reference.png

# 从文件读 prompt（适合长 prompt）
python "${HERMES_SKILL_DIR}/scripts/main.py" \
  --image out.png \
  --prompt-file prompt.md

# 带缓存 + 详细日志
python "${HERMES_SKILL_DIR}/scripts/main.py" \
  --image out.png \
  --prompt "A bird" --cache-dir .cache \
  --verbose --log-file run.jsonl
```

## Python 调用

```python
import subprocess, json

skill_dir = "${HERMES_SKILL_DIR}"
cmd = [
    "python", f"{skill_dir}/scripts/main.py",
    "--image", "output.png",
    "--prompt", "A cat",
    "--aspect", "1:1",
]
result = subprocess.run(cmd, capture_output=True, text=True)
info = json.loads(result.stdout)
print(info["path"], info["bytes"])
```

## 参数说明

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--image` | 输出 PNG 路径（**必须**） | — |
| `--prompt` | 完整提示词，或与 `--prompt-file` 联用时的简短摘要 | — |
| `--prompt-file` | 从文件读取完整提示词 | — |
| `--aspect` | 宽高比：1:1, 16:9, 9:16, 4:3, 2.35:1 | `1:1` |
| `--ref` | 参考图路径（可重复使用） | — |
| `--timeout` | Codex exec 超时（**毫秒**） | `300000` |
| `--retries` | 可重试错误的重试次数 | `2` |
| `--retry-delay` | 基础重试延迟（毫秒，指数退避） | `1500` |
| `--cache-dir` | 缓存目录（启用幂等性） | 禁用 |
| `--log-file` | JSONL 日志路径 | — |
| `-v, --verbose` | 详细日志输出 | 关闭 |

## 输出格式

JSON 格式到 stdout：

```json
{
  "status": "ok",
  "path": "output.png",
  "bytes": 1986769,
  "elapsed_seconds": 56,
  "thread_id": "...",
  "attempts": 1,
  "cached": false
}
```

失败时 `status` 为 `"error"`，附带 `error` 和 `error_kind` 字段。


## 可重试错误类型

| error_kind | 说明 |
|-----------|------|
| `spawn_failed` | codex 进程启动失败 |
| `timeout` | 超时未完成 |
| `no_image_gen_tool_use` | Codex 没有调用 image_gen |
| `output_missing` | 输出文件未创建 |
| `invalid_png` | 输出不是有效 PNG |
| `agent_refused` | Codex 拒绝执行 |

## Pitfalls

1. **不要用 PTY 模式**：`codex exec --json` 是 stdin/stdout 管道模式，不是交互式。在 terminal 工具中用 `pty=true` 会卡住。
2. **输出文件是 Codex 自动管理的**：脚本会自动从 `$CODEX_HOME/generated_images/<thread_id>/` 拷贝到你指定的 `--image` 路径，不要手动处理。
3. **Codex 有时不调用 image_gen**：如果 prompt 不够明确，Codex 可能尝试用其他方式生成图片。脚本会检测并重试。
4. **工作目录影响**：相对路径基于调用时的 cwd 解析，建议用绝对路径。

## 适用场景

- 快速生成原型图，不想配置 API key
- 批量生成 + 缓存策略
- 需要参考图的图像生成
- 脚本自动化流水线中嵌入图片生成
