# syntax=docker/dockerfile:1
#
# videolyrics, packaged.
#
# The point of this file is that a new server needs Docker and nothing else.
# No Python, no venv, no pip, no torch, no model download, no static ffmpeg
# build dropped in ~/bin, no Node version to match. All of it is here.
#
# Build with:  ops/docker-build.sh      (which also extracts dist/ for Caddy)
# Run with:    docker compose up -d
#
# Roughly 3 GB, almost entirely torch and two acoustic models. That is the
# honest price of doing forced alignment; the models are baked in rather than
# fetched on first run so the image works on a machine with no network and a
# fresh container never stalls for two minutes inside somebody's first job.

# ---------------------------------------------------------------------------
# 1. The front end.
#
# Fonts are fetched here rather than committed, so the licence stays with
# Google and the repo stays small. This is the only stage that needs npm.
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS web

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN node scripts/fetch-fonts.mjs && npm run build

# ---------------------------------------------------------------------------
# 2. Python, torch, and the acoustic models.
#
# torch must come from PyTorch's CPU index explicitly. The default PyPI wheel
# drags in the entire CUDA runtime — about 2.5 GB of it — for a machine with
# no GPU. Installing it first also means the pinned versions in
# requirements.txt are already satisfied when pip gets there, so it cannot
# quietly pull the CUDA build back in.
# ---------------------------------------------------------------------------
FROM python:3.12-slim-bookworm AS models

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    TORCH_HOME=/opt/torch

WORKDIR /build
COPY aligner/requirements.txt ./
RUN pip install --index-url https://download.pytorch.org/whl/cpu \
        torch==2.5.1 torchaudio==2.5.1 \
 && pip install -r requirements.txt

COPY aligner/ aligner/
COPY scripts/warm-models.py scripts/warm-models.py
RUN python scripts/warm-models.py

# ---------------------------------------------------------------------------
# 3. What actually ships.
#
# The API imports nothing but Node builtins — verified, not assumed — so the
# runtime needs the `node` binary and no node_modules at all. That is why a
# single file is copied out of the Node image instead of installing Node.
# ---------------------------------------------------------------------------
FROM python:3.12-slim-bookworm AS runtime

# ffmpeg decodes the upload (aligner/audio.py shells out to it for any
# container soundfile cannot read). libstdc++6 is what the Node binary links
# against and is not in the slim Python image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg libstdc++6 \
 && rm -rf /var/lib/apt/lists/*

COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=models /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=models /opt/torch /opt/torch

WORKDIR /app
COPY server/ server/
COPY shared/ shared/
COPY aligner/ aligner/
COPY scripts/warm-models.py scripts/warm-models.py
COPY package.json ./
COPY --from=web /build/dist ./dist

# OMP_NUM_THREADS has to be a real environment variable. torch reads it when
# it is imported, so calling torch.set_num_threads() afterwards leaves the
# alignment single-threaded — measured at 93 s against 38 s for the same clip.
# Setting it here means it is already in the process environment before Python
# starts, which is the only thing that works.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3058 \
    ALIGNER_PYTHON=/usr/local/bin/python3 \
    TORCH_HOME=/opt/torch \
    DATA_DIR=/data/jobs \
    FFMPEG_BIN=/usr/bin/ffmpeg \
    FFPROBE_BIN=/usr/bin/ffprobe \
    ALIGNER_THREADS=2 \
    OMP_NUM_THREADS=2 \
    MKL_NUM_THREADS=2

# Uploads and jobs live on a volume. Without this they would be inside the
# container's writable layer and vanish on the next rebuild.
RUN useradd --system --create-home --uid 10001 app \
 && mkdir -p /data/jobs \
 && chown -R app:app /data
VOLUME ["/data"]
USER app

EXPOSE 3058

# Uses node rather than curl so the image does not have to carry curl.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3058)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.mjs"]
