# syntax=docker/dockerfile:1

# ---- whisper.cpp + default model (base.en, q5_1) ---------------------------------------------
FROM node:26-bookworm-slim AS whisper
ARG WHISPER_CPP_REF=v1.8.7
RUN apt-get update && apt-get install -y --no-install-recommends build-essential cmake git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch "$WHISPER_CPP_REF" https://github.com/ggml-org/whisper.cpp /src
WORKDIR /src
# GGML_NATIVE=OFF keeps the binary portable (the build host's CPU may differ from the run host's).
# x86-64 gets AVX2/FMA/F16C, which every modern server CPU has; arm64 uses the NEON baseline.
RUN EXTRA=""; if [ "$(uname -m)" = "x86_64" ]; then EXTRA="-DGGML_AVX2=ON -DGGML_FMA=ON -DGGML_F16C=ON"; fi \
    && cmake -B build -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF $EXTRA -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build -j"$(nproc)" --config Release --target whisper-cli
RUN mkdir /models && curl -fsSL -o /models/ggml-base.en-q5_1.bin \
    https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en-q5_1.bin

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
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=whisper /src/build/bin/whisper-cli /usr/local/bin/whisper-cli
COPY --from=whisper /models /opt/models
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data WEB_DIR=/app/web/dist \
    WHISPER_BIN=/usr/local/bin/whisper-cli WHISPER_MODEL=base.en-q5_1 WHISPER_MODEL_DIR=/opt/models
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
