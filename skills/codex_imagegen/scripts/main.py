#!/usr/bin/env python3
"""
codex-imagegen: Generate images via Codex CLI's built-in image_gen tool.

Usage:
  python main.py --image output.png --prompt "A cat" [--aspect 16:9] [--ref img.png] [--timeout 300] [--retries 2] [--verbose]

Requires: codex CLI installed and authenticated (no OPENAI_API_KEY needed for built-in image_gen).
"""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Optional


# ── Types ────────────────────────────────────────────────────────────────────

@dataclass
class CliOptions:
    prompt: str = ""
    prompt_file: Optional[str] = None
    output_path: str = ""
    aspect: str = "1:1"
    ref_images: list[str] = field(default_factory=list)
    timeout_ms: int = 300_000
    retries: int = 2
    retry_delay_ms: int = 1500
    cache_dir: Optional[str] = None
    log_file: Optional[str] = None
    verbose: bool = False


@dataclass
class TokenUsage:
    input_tokens: int = 0
    cached_input_tokens: int = 0
    output_tokens: int = 0
    reasoning_tokens: int = 0


@dataclass
class ToolCall:
    id: str = ""
    tool: str = ""
    status: str = ""
    command: str = ""


@dataclass
class CodexRunResult:
    thread_id: Optional[str] = None
    tool_calls: list[ToolCall] = field(default_factory=list)
    agent_message: Optional[str] = None
    usage: Optional[TokenUsage] = None
    raw_log_path: str = ""
    duration_ms: int = 0


@dataclass
class GenerateResult:
    status: str = "ok"
    path: str = ""
    bytes: int = 0
    elapsed_seconds: float = 0
    thread_id: Optional[str] = None
    attempts: int = 0
    cached: bool = False
    usage: Optional[TokenUsage] = None
    tool_calls: list[dict] = field(default_factory=list)
    error: Optional[str] = None
    error_kind: Optional[str] = None


RETRYABLE_KINDS = {
    "spawn_failed", "timeout", "no_image_gen_tool_use",
    "output_missing", "invalid_png", "agent_refused",
}

SHELL_METACHAR = re.compile(r'[;|&`$<>\n\r()\'"]')
VALID_ASPECTS = ("1:1", "16:9", "9:16", "4:3", "2.35:1", "5:2")


class GenError(Exception):
    def __init__(self, kind: str, message: str, *, retryable: bool = False):
        self.kind = kind
        self.retryable = retryable
        super().__init__(message)


class FileLock:
    """Exclusive lock for concurrent codex exec (matches baoyu codex-imagegen)."""

    def __init__(self, lock_path: Path):
        self.lock_path = lock_path
        self._fd: Optional[int] = None

    def acquire(self, timeout_ms: int = 60_000) -> None:
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        deadline = time.time() + timeout_ms / 1000
        while time.time() < deadline:
            try:
                self._fd = os.open(self.lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                return
            except FileExistsError:
                if self._is_stale():
                    self.release(force=True)
                    continue
                time.sleep(0.2)
        raise GenError("lock_busy", f"Failed to acquire lock at {self.lock_path}", retryable=False)

    def _is_stale(self) -> bool:
        try:
            return (time.time() - self.lock_path.stat().st_mtime) > 600
        except OSError:
            return True

    def release(self, force: bool = False) -> None:
        if self._fd is not None:
            try:
                os.close(self._fd)
            except OSError:
                pass
            self._fd = None
        if force or self.lock_path.exists():
            try:
                self.lock_path.unlink()
            except OSError:
                pass


def assert_safe_path(label: str, value: str) -> None:
    if SHELL_METACHAR.search(value):
        raise GenError(
            "invalid_args",
            f"{label} contains shell metacharacters unsafe for codex instruction: {value}",
            retryable=False,
        )


def resolve_path(p: str, cwd: Path) -> str:
    path = Path(p).expanduser()
    return str(path if path.is_absolute() else (cwd / path).resolve())


def result_to_json(result: GenerateResult) -> str:
    d: dict[str, Any] = {
        "status": result.status,
        "path": result.path,
        "bytes": result.bytes,
        "elapsed_seconds": result.elapsed_seconds,
        "thread_id": result.thread_id,
        "attempts": result.attempts,
        "cached": result.cached,
        "usage": asdict(result.usage) if result.usage else None,
        "tool_calls": result.tool_calls,
    }
    if result.error is not None:
        d["error"] = result.error
    if result.error_kind is not None:
        d["error_kind"] = result.error_kind
    return json.dumps(d, default=str)


# ── Logger ───────────────────────────────────────────────────────────────────

class JsonLogger:
    def __init__(self, log_file: Optional[str], verbose: bool):
        self.log_file = log_file
        self.verbose = verbose

    def _log(self, level: str, event: str, extra: dict | None = None):
        entry = {"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ"), "level": level, "event": event}
        if extra:
            entry.update(extra)
        line = json.dumps(entry, default=str)
        if self.verbose:
            extras = " ".join(f"{k}={v}" for k, v in (extra or {}).items())
            print(f"[{level}] {event} {extras}", file=sys.stderr)
        if self.log_file:
            Path(self.log_file).parent.mkdir(parents=True, exist_ok=True)
            with open(self.log_file, "a") as f:
                f.write(line + "\n")

    def info(self, event, extra=None):
        self._log("info", event, extra)

    def warn(self, event, extra=None):
        self._log("warn", event, extra)

    def error(self, event, extra=None):
        self._log("error", event, extra)


# ── Cache ────────────────────────────────────────────────────────────────────

def cache_key(prompt: str, aspect: str, refs: list[str]) -> str:
    h = hashlib.sha256()
    h.update(prompt.encode())
    h.update(b"|")
    h.update(aspect.encode())
    h.update(b"|")
    for r in sorted(refs):
        h.update(r.encode())
    return h.hexdigest()[:16]


def lookup_cache(cache_dir: str, key: str) -> Optional[str]:
    entry = Path(cache_dir) / f"{key}.png"
    if entry.exists() and entry.stat().st_size > 1000:
        return str(entry)
    return None


def store_cache(cache_dir: str, key: str, source: str):
    Path(cache_dir).mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, Path(cache_dir) / f"{key}.png")


# ── Parser ───────────────────────────────────────────────────────────────────

def derive_tool_name(item: dict) -> str:
    t = item.get("type", "")
    if t == "command_execution":
        return "shell"
    if t == "agent_message":
        return "agent_message"
    if t in ("image_gen", "image_generation"):
        return "image_gen"
    if isinstance(item.get("tool"), str):
        return item["tool"]
    return t or "unknown"


def parse_event_stream(raw: str) -> CodexRunResult:
    result = CodexRunResult()
    tool_calls_by_id: dict[str, ToolCall] = {}

    for line in raw.split("\n"):
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue

        etype = event.get("type")

        if etype == "thread.started":
            result.thread_id = event.get("thread_id")

        elif etype in ("item.started", "item.completed"):
            item = event.get("item", {})
            item_id = item.get("id", "")
            if not item_id:
                continue
            tc = ToolCall(
                id=item_id,
                tool=derive_tool_name(item),
                status=item.get("status", "completed" if etype == "item.completed" else "in_progress"),
                command=item.get("command", ""),
            )
            tool_calls_by_id[item_id] = tc
            if item.get("type") == "agent_message" and etype == "item.completed":
                result.agent_message = str(item.get("text", ""))

        elif etype == "turn.completed":
            u = event.get("usage")
            if u:
                result.usage = TokenUsage(
                    input_tokens=u.get("input_tokens", 0),
                    cached_input_tokens=u.get("cached_input_tokens", 0),
                    output_tokens=u.get("output_tokens", 0),
                    reasoning_tokens=u.get("reasoning_output_tokens", 0),
                )

    result.tool_calls = list(tool_calls_by_id.values())
    return result


# ── Validator ────────────────────────────────────────────────────────────────

def codex_home() -> Path:
    if v := os.environ.get("CODEX_HOME"):
        return Path(v)
    # pwd 从 /etc/passwd 读真实 home，不受 $HOME 被覆盖影响（如 Hermes profile 环境）wwwwwwwwwww
    import pwd
    real_home = pwd.getpwuid(os.getuid()).pw_dir
    return Path(real_home) / ".codex"


def verify_image_gen_invoked(thread_id: Optional[str]) -> tuple[bool, str]:
    if not thread_id:
        return False, "no thread id"
    img_dir = codex_home() / "generated_images" / thread_id
    try:
        pngs = [f for f in img_dir.iterdir() if f.suffix.lower() == ".png"]
        if not pngs:
            return False, f"no PNG in {img_dir}"
        return True, ""
    except Exception as e:
        return False, f"cannot read {img_dir}: {e}"


def find_cp_to_target(tool_calls: list[ToolCall], target: str) -> bool:
    basename = Path(target).name
    for tc in tool_calls:
        if tc.tool == "shell" and tc.command:
            if (target in tc.command or basename in tc.command) and \
               any(cmd in tc.command for cmd in ["cp", "mv", "cat"]) and \
               "generated_images" in tc.command:
                return True
    return False


PNG_MAGIC = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])


def verify_output(output_path: str) -> int:
    p = Path(output_path)
    if not p.exists():
        raise GenError("output_missing", f"Output file not created: {output_path}", retryable=True)
    size = p.stat().st_size
    if size < 1000:
        raise GenError("output_missing", f"Output file too small ({size} bytes)", retryable=True)
    with open(p, "rb") as f:
        head = f.read(8)
    if head != PNG_MAGIC:
        raise GenError("invalid_png", "Output is not a valid PNG (magic mismatch)", retryable=True)
    return size


# ── Codex Spawn ──────────────────────────────────────────────────────────────

def run_codex_exec(instruction: str, timeout_ms: int, ref_images: list[str]) -> CodexRunResult:
    start = time.time()
    args = [
        "codex", "exec", "--json",
        "--sandbox", "danger-full-access",
        "--skip-git-repo-check",
    ]
    for img in ref_images:
        args.extend(["--image", img])
    args.append("-")  # read prompt from stdin

    # 构建干净环境：确保 codex 进程能找到 ~/.codex/auth.json
    import pwd
    real_home = pwd.getpwuid(os.getuid()).pw_dir
    clean_env = os.environ.copy()
    clean_env["HOME"] = real_home

    proc = subprocess.Popen(
        args,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=clean_env,
    )

    try:
        stdout, stderr = proc.communicate(input=instruction, timeout=timeout_ms / 1000)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        raise GenError("timeout", f"codex exec exceeded {timeout_ms}ms", retryable=True)

    # Save raw log
    log_dir = Path(tempfile.mkdtemp(prefix="codex-imggen-"))
    raw_log = log_dir / "stream.jsonl"
    raw_log.write_text(stdout + ("\n--- stderr ---\n" + stderr if stderr else ""))

    if proc.returncode != 0:
        if "command not found" in stderr or "not found: codex" in stderr:
            raise GenError("spawn_failed", "codex CLI not installed", retryable=True)
        raise GenError(
            "spawn_failed",
            f"codex exec exited {proc.returncode} (log: {raw_log})",
            retryable=True,
        )

    parsed = parse_event_stream(stdout)
    parsed.raw_log_path = str(raw_log)
    parsed.duration_ms = int((time.time() - start) * 1000)
    return parsed


# ── Instruction Builder ──────────────────────────────────────────────────────

def build_instruction(prompt: str, opts: CliOptions) -> str:
    ref_hint = ""
    if opts.ref_images:
        ref_hint = f'\nREFERENCE IMAGES (attached above): {len(opts.ref_images)} image(s) provided for style/composition guidance.\n'

    return f"""You have an internal tool called image_gen for image generation. Use it.

TASK: Generate an image with the spec below, then save to disk.

PROMPT:
{prompt}

ASPECT RATIO: {opts.aspect}
OUTPUT PATH: {opts.output_path}
{ref_hint}
STEPS:
1. Call image_gen with the prompt and aspect ratio above{" (using the attached reference images for guidance)" if opts.ref_images else ""}.
2. Move or copy the resulting image from Codex default location ($CODEX_HOME/generated_images/...) to: {opts.output_path}
3. Verify with: ls -la {opts.output_path}
4. Reply with ONLY this JSON line (no markdown fences, no other text):
   {{"status":"ok","path":"{opts.output_path}","bytes":<file_size_in_bytes>}}

HARD CONSTRAINTS:
- Do NOT use curl, wget, Python, or any external API.
- Do NOT use bash to fabricate an image; only image_gen produces real pixels.
- Use ONLY the image_gen internal tool."""


# ── Core Generate ────────────────────────────────────────────────────────────

def attempt_generate(opts: CliOptions, instruction: str, attempt: int, log: JsonLogger) -> dict:
    log.info("attempt.start", {"attempt": attempt, "output": opts.output_path, "aspect": opts.aspect})

    run = run_codex_exec(instruction, opts.timeout_ms, opts.ref_images)

    log.info("codex.completed", {
        "duration_ms": run.duration_ms,
        "thread_id": run.thread_id,
        "tool_calls": len(run.tool_calls),
        "raw_log": run.raw_log_path,
    })

    if not run.thread_id:
        raise GenError("agent_refused", "No thread id in event stream", retryable=True)

    ver_ok, ver_reason = verify_image_gen_invoked(run.thread_id)
    if not ver_ok:
        if not find_cp_to_target(run.tool_calls, opts.output_path):
            raise GenError(
                "no_image_gen_tool_use",
                f"image_gen was not invoked: {ver_reason}",
                retryable=True,
            )

    # Verify output
    file_bytes = verify_output(opts.output_path)

    return {
        "bytes": file_bytes,
        "thread_id": run.thread_id,
        "usage": run.usage,
        "tool_calls": [{"tool": tc.tool, "status": tc.status} for tc in run.tool_calls],
    }


def load_prompt(opts: CliOptions) -> str:
    short = (opts.prompt or "").strip()
    body = ""
    if opts.prompt_file:
        try:
            body = Path(opts.prompt_file).read_text(encoding="utf-8").strip()
        except OSError as e:
            raise GenError(
                "prompt_file_missing",
                f"Prompt file not found: {opts.prompt_file}",
                retryable=False,
            ) from e

    if body and short:
        return f"SUMMARY:\n{short}\n\nPROMPT:\n{body}"
    if body:
        return body
    if short:
        return short
    raise GenError("invalid_args", "--prompt or --prompt-file is required", retryable=False)


def generate(opts: CliOptions, log: JsonLogger) -> GenerateResult:
    start = time.time()
    prompt = load_prompt(opts)

    if opts.cache_dir:
        key = cache_key(prompt, opts.aspect, opts.ref_images)
        cached = lookup_cache(opts.cache_dir, key)
        if cached:
            Path(opts.output_path).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(cached, opts.output_path)
            size = Path(opts.output_path).stat().st_size
            log.info("cache.hit", {"key": key, "source": cached})
            return GenerateResult(
                status="ok", path=opts.output_path, bytes=size,
                elapsed_seconds=0, attempts=0, cached=True,
            )
        log.info("cache.miss", {"key": key})

    lock_dir = Path(opts.cache_dir) if opts.cache_dir else Path.home() / ".cache" / "baoyu-codex-imagegen"
    lock = FileLock(lock_dir / "codex-exec.lock")
    try:
        lock.acquire(60_000)
    except GenError as e:
        return GenerateResult(
            status="error",
            path=opts.output_path,
            elapsed_seconds=round(time.time() - start),
            attempts=0,
            error=str(e),
            error_kind=e.kind,
        )

    try:
        Path(opts.output_path).parent.mkdir(parents=True, exist_ok=True)
        instruction = build_instruction(prompt, opts)

        last_err: Optional[GenError] = None
        last_attempt = 0
        for attempt in range(1, opts.retries + 2):
            last_attempt = attempt
            try:
                result = attempt_generate(opts, instruction, attempt, log)

                if opts.cache_dir:
                    key = cache_key(prompt, opts.aspect, opts.ref_images)
                    store_cache(opts.cache_dir, key, opts.output_path)
                    log.info("cache.stored", {"key": key})

                return GenerateResult(
                    status="ok",
                    path=opts.output_path,
                    bytes=result["bytes"],
                    elapsed_seconds=round(time.time() - start),
                    thread_id=result["thread_id"],
                    attempts=attempt,
                    cached=False,
                    usage=result["usage"],
                    tool_calls=result["tool_calls"],
                )
            except GenError as e:
                last_err = e
                log.warn("attempt.failed", {
                    "attempt": attempt,
                    "kind": e.kind,
                    "retryable": e.retryable,
                    "error": str(e),
                })
                if not e.retryable or attempt > opts.retries:
                    break
                wait = opts.retry_delay_ms * (2 ** (attempt - 1))
                log.info("retry.wait", {"wait_ms": wait, "next_attempt": attempt + 1})
                time.sleep(wait / 1000)
            except Exception as e:
                last_err = GenError("spawn_failed", str(e), retryable=True)
                log.warn("attempt.failed", {
                    "attempt": attempt,
                    "kind": last_err.kind,
                    "retryable": last_err.retryable,
                    "error": str(e),
                })
                if attempt > opts.retries:
                    break
                wait = opts.retry_delay_ms * (2 ** (attempt - 1))
                time.sleep(wait / 1000)

        err = last_err or GenError("spawn_failed", "Unknown failure", retryable=False)
        return GenerateResult(
            status="error",
            path=opts.output_path,
            elapsed_seconds=round(time.time() - start),
            attempts=last_attempt,
            error=str(err),
            error_kind=err.kind,
        )
    finally:
        lock.release()


# ── CLI ──────────────────────────────────────────────────────────────────────

def build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="codex-imagegen",
        description="Generate images via Codex CLI's image_gen tool.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Stdout: single JSON line on success or failure.",
    )
    p.add_argument("--image", required=True, metavar="PATH", help="Output PNG path")
    p.add_argument(
        "--prompt",
        metavar="TEXT",
        help="Full prompt text, or a short summary when combined with --prompt-file",
    )
    p.add_argument("--prompt-file", metavar="PATH", help="Read full prompt from file")
    p.add_argument(
        "--aspect",
        default="1:1",
        choices=VALID_ASPECTS,
        help="Aspect ratio (default: 1:1)",
    )
    p.add_argument("--ref", action="append", default=[], metavar="PATH", help="Reference image (repeatable)")
    p.add_argument(
        "--timeout",
        type=int,
        default=300_000,
        metavar="MS",
        help="Codex exec timeout in milliseconds (default: 300000)",
    )
    p.add_argument("--retries", type=int, default=2, help="Retry attempts on retryable errors (default: 2)")
    p.add_argument(
        "--retry-delay",
        type=int,
        default=1500,
        metavar="MS",
        help="Base retry delay, exponential backoff (default: 1500)",
    )
    p.add_argument("--cache-dir", metavar="PATH", help="Enable idempotency cache")
    p.add_argument("--log-file", metavar="PATH", help="Append JSONL log")
    p.add_argument("-v", "--verbose", action="store_true", help="Verbose stderr logging")
    return p


def parse_args(argv: list[str] | None = None) -> CliOptions:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    if not args.prompt and not args.prompt_file:
        parser.error("at least one of --prompt or --prompt-file is required")

    cwd = Path.cwd()
    prompt_file = resolve_path(args.prompt_file, cwd) if args.prompt_file else None

    opts = CliOptions(
        prompt=(args.prompt or "").strip(),
        prompt_file=prompt_file,
        output_path=resolve_path(args.image, cwd),
        aspect=args.aspect,
        ref_images=[resolve_path(r, cwd) for r in args.ref],
        timeout_ms=args.timeout,
        retries=args.retries,
        retry_delay_ms=args.retry_delay,
        cache_dir=resolve_path(args.cache_dir, cwd) if args.cache_dir else None,
        log_file=resolve_path(args.log_file, cwd) if args.log_file else None,
        verbose=args.verbose,
    )

    assert_safe_path("--image path", opts.output_path)
    for ref in opts.ref_images:
        assert_safe_path("--ref path", ref)

    return opts


def main() -> None:
    try:
        opts = parse_args()
    except SystemExit:
        raise
    except GenError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(2)

    log = JsonLogger(opts.log_file, opts.verbose)
    log.info("start", {"output": opts.output_path, "aspect": opts.aspect, "refs": len(opts.ref_images)})

    result = generate(opts, log)
    log.info("done" if result.status == "ok" else "failed", {
        "bytes": result.bytes,
        "attempts": result.attempts,
        "cached": result.cached,
    })

    print(result_to_json(result))
    sys.exit(0 if result.status == "ok" else 1)


if __name__ == "__main__":
    main()
