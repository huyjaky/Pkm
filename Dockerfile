# syntax=docker/dockerfile:1.7
#
# Hoenn Link - one image with everything:
#   1. rom     : builds pokeemerald-expansion and extracts web assets (symbols, sprites, minimap)
#   2. web     : builds the React client
#   3. runtime : Miniconda env (Python API + Node battle engine) serving it all
#
# Build args:
#   ROM_REPO  git URL of the ROM source (default: rh-hideout/pokeemerald-expansion)
#   ROM_REF   branch or tag to build (default: master)

############################################################ 1. ROM build
FROM debian:trixie-slim AS rom
ARG ROM_REPO=https://github.com/rh-hideout/pokeemerald-expansion.git
ARG ROM_REF=master
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential binutils-arm-none-eabi gcc-arm-none-eabi libnewlib-arm-none-eabi \
      git libpng-dev python3 python3-pil ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 --branch "${ROM_REF}" "${ROM_REPO}" pokeemerald-expansion
WORKDIR /src/pokeemerald-expansion
RUN make -j"$(nproc)"
COPY tools/extract_assets.py /tools/extract_assets.py
RUN python3 /tools/extract_assets.py --repo /src/pokeemerald-expansion --out /assets

############################################################ 2. Web client
FROM node:22-slim AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

############################################################ 3. Runtime (Miniconda)
FROM continuumio/miniconda3:latest AS runtime
ENV PYTHONUNBUFFERED=1 \
    APP_HOME=/app \
    DATA_DIR=/data \
    ASSETS_DIR=/app/assets \
    WEB_DIR=/app/web \
    ENGINE_SCRIPT=/app/battle-engine/engine.js \
    NODE_BIN=/opt/conda/envs/pkm-online/bin/node
WORKDIR /app

COPY environment.yml ./
RUN conda env create -f environment.yml \
 && conda clean -afy

COPY battle-engine/package.json battle-engine/package-lock.json ./battle-engine/
RUN cd battle-engine && conda run -n pkm-online npm ci --omit=dev --omit=optional --no-audit --no-fund
COPY battle-engine/engine.js ./battle-engine/
COPY server/ ./server/
COPY --from=web /web/dist ./web
COPY --from=rom /assets ./assets

RUN useradd --create-home --uid 1000 hoenn && mkdir -p /data && chown hoenn:hoenn /data
USER hoenn
VOLUME ["/data"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD conda run -n pkm-online python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health').status==200 else 1)"
CMD ["conda", "run", "--no-capture-output", "-n", "pkm-online", \
     "uvicorn", "app.main:app", "--app-dir", "/app/server", "--host", "0.0.0.0", "--port", "8000", \
     "--proxy-headers", "--forwarded-allow-ips", "*"]
