FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl unzip ca-certificates && rm -rf /var/lib/apt/lists/*
RUN ARCH="$(dpkg --print-architecture)" && case "${ARCH}" in \
      amd64) VOSK_ARCHIVE=vosk-linux-x86_64-0.3.45.zip ;; \
      arm64) VOSK_ARCHIVE=vosk-linux-aarch64-0.3.45.zip ;; \
      *) echo "Unsupported Vosk architecture: ${ARCH}" >&2; exit 1 ;; \
    esac && \
    mkdir -p /opt/vosk && \
    curl -fsSL "https://github.com/alphacep/vosk-api/releases/download/v0.3.45/${VOSK_ARCHIVE}" -o /tmp/vosk.zip && \
    unzip -q /tmp/vosk.zip -d /tmp/vosk && \
    cp -a /tmp/vosk/vosk-linux-*/. /opt/vosk/ && \
    rm -rf /tmp/vosk /tmp/vosk.zip
ENV LD_LIBRARY_PATH=/opt/vosk
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY apps ./apps
COPY packages ./packages
RUN mkdir -p /data/uploads /models && chown -R node:node /data /models
ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["npm", "run", "start:api"]
