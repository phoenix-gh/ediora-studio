FROM node:22-bookworm-slim AS backend-deps

WORKDIR /build/backend
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-dev build-essential \
    && rm -rf /var/lib/apt/lists/*
COPY backend/requirements.txt ./
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

FROM node:22-bookworm-slim AS web-deps

WORKDIR /build/web
COPY web/package.json web/pnpm-lock.yaml ./
RUN corepack enable \
    && pnpm install --frozen-lockfile --config.minimumReleaseAge=0 --config.strictDepBuilds=false

FROM web-deps AS web-build

ARG NEXT_PUBLIC_API_URL=http://localhost:8000/api
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
ARG NEXT_PUBLIC_DEVELOPER_MODE=0
ENV NEXT_PUBLIC_DEVELOPER_MODE=${NEXT_PUBLIC_DEVELOPER_MODE}
COPY web ./
RUN ./node_modules/.bin/next build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    REMOTION_BROWSER_EXECUTABLE=/usr/bin/chromium \
    PATH=/opt/venv/bin:$PATH
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      python3 python3-venv ffmpeg chromium \
      ca-certificates fonts-noto-cjk fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*
COPY --from=backend-deps /opt/venv /opt/venv
COPY backend ./
COPY web ./web
COPY --from=web-deps /build/web/node_modules ./web/node_modules
COPY --from=web-build /build/web/.next ./web/.next
EXPOSE 8000 3000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
