FROM node:22.13-bookworm-slim AS base

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssh-client unzip \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.14.0 --activate

FROM base AS build

WORKDIR /opt/dark-kitchen

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY tsconfig.json tsconfig.base.json ./
COPY packages/ packages/
COPY apps/ apps/

RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm --filter dark-kitchen build
RUN mkdir -p /opt/dark-kitchen/release \
  && npm pack ./apps/cli --pack-destination /opt/dark-kitchen/release

FROM base AS runtime

ENV NODE_ENV=production

COPY --from=build /opt/dark-kitchen/release/ /tmp/dark-kitchen-package/

RUN mkdir -p /opt/dark-kitchen-runtime \
  && npm install --prefix /opt/dark-kitchen-runtime --omit=dev /tmp/dark-kitchen-package/*.tgz \
  && rm -rf /tmp/dark-kitchen-package

RUN mkdir -p /workspace /home/node/.dark-kitchen \
  && chown -R node:node /workspace /home/node/.dark-kitchen

USER node
WORKDIR /workspace

# The project bind mount owns config, SQLite/journals, and task worktrees.
# The home volume owns managed capability packages/browser/tool assets.
VOLUME ["/workspace/.dark-kitchen/runtime", "/home/node/.dark-kitchen"]

EXPOSE 18800 18801
STOPSIGNAL SIGTERM

ENTRYPOINT ["node", "--experimental-sqlite", "/opt/dark-kitchen-runtime/node_modules/dark-kitchen/dist/cli.js"]
CMD ["start", "--foreground"]
