# syntax=docker/dockerfile:1
FROM node:22.23.3-bookworm-slim AS codex
ARG CODEX_VERSION=0.162.0-alpha.2
RUN npm install --prefix /opt/codex --no-audit --no-fund "@openai/codex@${CODEX_VERSION}" \
    && node /opt/codex/node_modules/@openai/codex/bin/codex.js --version

FROM python:3.12.15-slim-bookworm
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOME=/home/app \
    CODEX_HOME=/home/app/.codex \
    EDITOR_HOST=0.0.0.0 \
    EDITOR_PORT=8080 \
    EDITOR_OUTPUT=/data/jobs
RUN apt-get update \
    && apt-get install --no-install-recommends -y ca-certificates libstdc++6 git ripgrep fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 app \
    && useradd --uid 10001 --gid app --create-home --shell /bin/sh app \
    && install -d -o app -g app -m 0700 /data /data/jobs /home/app/.codex
COPY --from=codex /usr/local/bin/node /usr/local/bin/node
COPY --from=codex /opt/codex /opt/codex
RUN ln -s /opt/codex/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex
WORKDIR /app
COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir --only-binary=:all: -r requirements.txt
COPY assets ./assets
COPY scripts ./scripts
COPY tests ./tests
COPY deploy/healthcheck.py deploy/check-runtime.py ./deploy/
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "/app/deploy/healthcheck.py"]
CMD ["python", "/app/scripts/render_server.py"]
