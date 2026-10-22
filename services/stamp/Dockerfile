FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    DATA_DIR=/data \
    TESSDATA_PREFIX=/usr/share/tesseract-ocr/5/tessdata \
    OMP_THREAD_LIMIT=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       tesseract-ocr tesseract-ocr-rus tesseract-ocr-eng ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 stamp \
    && useradd --uid 10001 --gid stamp --no-create-home --shell /usr/sbin/nologin stamp \
    && mkdir /data \
    && chown stamp:stamp /data

WORKDIR /app
COPY requirements.txt ./
RUN python -m pip install --no-cache-dir -r requirements.txt
COPY --chown=10001:10001 app ./app
COPY --chown=10001:10001 assets ./assets
COPY --chown=10001:10001 scripts ./scripts
COPY --chown=10001:10001 tests ./tests
COPY --chown=10001:10001 docs ./docs
COPY --chown=10001:10001 ["Открыть инструмент.cmd", "./"]
COPY --chown=10001:10001 Dockerfile compose.yaml compose.workshop.yaml README.md LICENSE .env.example Caddyfile.example nginx.example .dockerignore .gitignore requirements-dev.txt ./

USER 10001:10001
EXPOSE 8080
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1", "--no-proxy-headers", "--limit-concurrency", "20", "--timeout-keep-alive", "5"]
