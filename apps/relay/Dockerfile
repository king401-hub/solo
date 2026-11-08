# Build from the repository root:   docker build -f apps/relay/Dockerfile -t solo-relay .
FROM node:22-alpine
WORKDIR /app

# Workspace manifests first so dependency installation is cached.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/crypto/package.json packages/crypto/
COPY apps/relay/package.json apps/relay/
COPY apps/desktop/package.json apps/desktop/
RUN npm ci --workspace @solo/relay --include-workspace-root --ignore-scripts

COPY packages/shared/src packages/shared/src
COPY packages/crypto/src packages/crypto/src
COPY apps/relay/src apps/relay/src

ENV NODE_ENV=production \
    PORT=8080 \
    TRUST_PROXY=1
EXPOSE 8080
USER node
CMD ["npx", "tsx", "apps/relay/src/index.ts"]
