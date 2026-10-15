FROM node:22-slim
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*

COPY package.json server.js ./
COPY lib ./lib
COPY vendor ./vendor
COPY public ./public

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_DIR=/data
ENV TRUST_PROXY=1

RUN mkdir -p /data && chown node:node /data

EXPOSE 3000

CMD ["sh", "-c", "mkdir -p /data && chown -R node:node /data && exec gosu node node --disable-warning=ExperimentalWarning server.js"]
