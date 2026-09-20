ARG BASE_IMAGE=node:24-bookworm-slim
FROM ${BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive \
    PUPPETEER_SKIP_DOWNLOAD=true

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    dumb-init \
    ffmpeg \
    fonts-dejavu-core \
    fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /opt/worker-tools
COPY package.json package-lock.json ./
RUN npm ci --include=dev \
  && node -e "const fs=require('node:fs'); fs.mkdirSync('/opt/worker-tools/bin'); fs.symlinkSync(require('ffmpeg-static'), '/opt/worker-tools/bin/ffmpeg')" \
  && /opt/worker-tools/bin/ffmpeg -version \
  && /usr/bin/ffprobe -version

WORKDIR /opt/hypit
COPY vendor/hypit/ ./
RUN pnpm install --frozen-lockfile \
  && node scripts/build-public-types.mjs \
  && pnpm exec tsc -p examples/semantic-composition/packages/chat-scene/tsconfig.json \
  && pnpm store prune

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["sleep", "infinity"]
