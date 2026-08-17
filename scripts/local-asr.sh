#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="${LOCAL_ASR_CONTAINER:-ediora-local-asr}"
IMAGE="${LOCAL_ASR_IMAGE:-ghcr.io/speaches-ai/speaches:0.8.3-cuda}"
PORT="${LOCAL_ASR_PORT:-8001}"
ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
MODEL_CACHE_VOLUME="${LOCAL_ASR_CACHE_VOLUME:-}"
MODEL_CACHE_DIR="${LOCAL_ASR_CACHE_DIR:-$ROOT_DIR/data/local-asr-models}"

if [[ -n "$MODEL_CACHE_VOLUME" ]]; then
  MODEL_CACHE_MOUNT="${MODEL_CACHE_VOLUME}:/home/ubuntu/.cache/huggingface/hub"
else
  mkdir -p "$MODEL_CACHE_DIR"
  MODEL_CACHE_MOUNT="${MODEL_CACHE_DIR}:/home/ubuntu/.cache/huggingface/hub"
fi

case "${1:-start}" in
  start)
    if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
      docker start "$CONTAINER_NAME" >/dev/null
    else
      docker run -d \
        --name "$CONTAINER_NAME" \
        --restart unless-stopped \
        --gpus all \
        --publish "127.0.0.1:${PORT}:8000" \
        --env WHISPER__INFERENCE_DEVICE="${LOCAL_ASR_DEVICE:-cuda}" \
        --env WHISPER__COMPUTE_TYPE="${LOCAL_ASR_COMPUTE_TYPE:-float16}" \
        --volume "$MODEL_CACHE_MOUNT" \
        "$IMAGE" >/dev/null
    fi

    for _attempt in $(seq 1 60); do
      if curl --fail --silent --max-time 2 "http://127.0.0.1:${PORT}/health" >/dev/null; then
        printf 'Local ASR ready: http://127.0.0.1:%s/v1\n' "$PORT"
        exit 0
      fi
      sleep 1
    done
    printf 'Local ASR did not become healthy; inspect with: docker logs %s\n' "$CONTAINER_NAME" >&2
    exit 1
    ;;
  status)
    docker container inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' "$CONTAINER_NAME"
    ;;
  logs)
    exec docker logs --follow "$CONTAINER_NAME"
    ;;
  stop)
    docker stop "$CONTAINER_NAME" >/dev/null
    ;;
  *)
    printf 'Usage: %s {start|status|logs|stop}\n' "$0" >&2
    exit 2
    ;;
esac
