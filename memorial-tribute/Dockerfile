FROM node:22-slim
WORKDIR /app

COPY package.json server.js ./
COPY lib ./lib
COPY vendor ./vendor
COPY public ./public

# Messages and the portrait live here: mount a persistent volume at /data.
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    TRUST_PROXY=1
VOLUME /data
EXPOSE 3000

USER node
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
