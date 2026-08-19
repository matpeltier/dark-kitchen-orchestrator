FROM node:22-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.14.0 --activate

# Copy workspace files
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/ packages/
COPY apps/ apps/
COPY tsconfig*.json ./

# Install dependencies
RUN pnpm install --frozen-lockfile

# Build
RUN pnpm build

# Runtime data volume
VOLUME ["/data/.dark-kitchen"]

ENV DARK_KITCHEN_DATA_DIR=/data/.dark-kitchen

EXPOSE 3000

ENTRYPOINT ["node", "--experimental-sqlite", "apps/cli/dist/cli.js"]
CMD ["start", "--foreground"]
