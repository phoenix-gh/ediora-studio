#!/usr/bin/env bash
set -euo pipefail

CONTAINER_NAME="${WMS_LOCAL_ASR_CONTAINER:-wemedia-local-asr}"
IMAGE="${WMS_LOCAL_ASR_IMAGE:-ghcr.io/speaches-ai/speaches:0.8.3-cuda}"
PORT="${WMS_LOCAL_ASR_PORT:-8001}"
MODEL_CACHE_VOLUME="${WMS_LOCAL_ASR_CACHE_VOLUME:-wemedia-whisper-model-cache}"

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
        --env WHISPER__INFERENCE_DEVICE="${WMS_LOCAL_ASR_DEVICE:-cuda}" \
        --env WHISPER__COMPUTE_TYPE="${WMS_LOCAL_ASR_COMPUTE_TYPE:-float16}" \
        --volume "${MODEL_CACHE_VOLUME}:/home/ubuntu/.cache/huggingface/hub" \
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
