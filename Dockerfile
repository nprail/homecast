# syntax=docker/dockerfile:1

# Published as ghcr.io/nprail/homecast for linux/amd64 and linux/arm64.

# ---- whisper.cpp: prebuilt Linux release binary, pinned and checksum-verified -----------------
FROM debian:bookworm-slim AS whisper
ARG TARGETARCH
# whisper.cpp release b5454 (https://github.com/ggml-org/whisper.cpp/releases/tag/b5454).
ARG WHISPER_RELEASE=b5454
ARG WHISPER_SHA256_AMD64=a72becf15d7917f990f6313867a52638b82b7f9ef237fb0c980dac56a135781c
ARG WHISPER_SHA256_ARM64=6b95ebfc60447df48e70ef00a73bdc3f41679ed2d01ef465827206a2ff325149
# ggerganov/whisper.cpp ggml-base.en-q5_1.bin on Hugging Face (LFS sha256). Architecture-independent.
ARG MODEL_SHA256=4baf70dd0d7c4247ba2b81fafd9c01005ac77c2f9ef064e00dcf195d0e2fdd2f
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl libgomp1 \
    && rm -rf /var/lib/apt/lists/*
RUN set -eux; \
    case "$TARGETARCH" in \
      amd64) asset=whisper-bin-ubuntu-x64.tar.gz;   sha="$WHISPER_SHA256_AMD64" ;; \
      arm64) asset=whisper-bin-ubuntu-arm64.tar.gz; sha="$WHISPER_SHA256_ARM64" ;; \
      *) echo "unsupported architecture: $TARGETARCH"; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/whisper.tar.gz \
      "https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_RELEASE}/${asset}"; \
    echo "${sha}  /tmp/whisper.tar.gz" | sha256sum -c -; \
    mkdir -p /opt/whisper; \
    tar -xzf /tmp/whisper.tar.gz -C /opt/whisper --strip-components=1; \
    rm /tmp/whisper.tar.gz; \
    /opt/whisper/whisper-cli --help >/dev/null
RUN set -eux; \
    mkdir -p /opt/models; \
    curl -fsSL -o /opt/models/ggml-base.en-q5_1.bin \
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en-q5_1.bin"; \
    echo "${MODEL_SHA256}  /opt/models/ggml-base.en-q5_1.bin" | sha256sum -c -

# ---- build the server and the admin dashboard -------------------------------------------------
FROM node:26-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY tsconfig.base.json ./
COPY shared shared
COPY server server
COPY web web
RUN npm run build

# ---- production dependencies only -------------------------------------------------------------
FROM node:26-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace=server --include-workspace-root=false

# ---- runtime: non-root, read-only root filesystem except /data ---------------------------------
FROM node:26-bookworm-slim
# libgomp1: OpenMP runtime needed by whisper-cli. ffmpeg: audio conversion for transcripts.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libgomp1 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=whisper /opt/whisper /opt/whisper
COPY --from=whisper /opt/models /opt/models
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data WEB_DIR=/app/web/dist \
    WHISPER_BIN=/opt/whisper/whisper-cli LD_LIBRARY_PATH=/opt/whisper \
    WHISPER_MODEL=base.en-q5_1 WHISPER_MODEL_DIR=/opt/models
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
