# zPOOL relayer + indexer. Build context = pool/ (workspace root) so the relayer can import ../sdk and the IDL.
FROM node:24-slim
WORKDIR /srv
COPY package.json package-lock.json ./
COPY sdk/package.json sdk/
COPY relayer/package.json relayer/
COPY app/package.json app/
RUN npm install --workspace sdk --workspace relayer --include-workspace-root --no-audit --no-fund
COPY sdk/src sdk/src
COPY relayer/src relayer/src
COPY program/target/idl/shieldpool.json program/target/idl/shieldpool.json
ENV NODE_ENV=production PORT=8787 DB_PATH=/data/relayer.sqlite
EXPOSE 8787
WORKDIR /srv/relayer
CMD ["npx", "tsx", "src/main.ts"]
