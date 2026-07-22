FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --config.minimumReleaseAge=0 --config.strictDepBuilds=false

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY . ./
RUN ./node_modules/.bin/next build
EXPOSE 3000
CMD ["./node_modules/.bin/next", "start"]
