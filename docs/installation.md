# Installation

## Prerequisites

| Requirement | Minimum | Notes                                                  |
| ----------- | ------- | ------------------------------------------------------ |
| Node.js     | 22.13   | Required for `node:sqlite` and ES modules              |
| pnpm        | 10.14   | Pinned in `package.json`                               |
| Git         | 2.5     | Required for git worktrees                             |
| acpx        | latest  | Required for ACP harnesses (Cursor, Claude Code, etc.) |

## npm (recommended)

```sh
npm install -g dark-kitchen
dark-kitchen init
dark-kitchen doctor
```

## From source

```sh
git clone https://github.com/your-org/dark-kitchen
cd dark-kitchen
pnpm install --frozen-lockfile
pnpm build
node --experimental-sqlite packages/cli/dist/cli.js doctor
```

## Docker

```sh
docker run -v $(pwd)/.dark-kitchen:/data/.dark-kitchen \
           -e GITHUB_TOKEN=$GITHUB_TOKEN \
           ghcr.io/your-org/dark-kitchen:latest start --foreground
```

## Credentials

Dark Kitchen reads credentials from environment variables. Set these before starting:

```sh
export GITHUB_TOKEN=ghp_...      # GitHub Issues + GitHub SCM
export LINEAR_API_KEY=lin_api_... # Linear tracker
export JIRA_TOKEN=...             # Jira tracker
export OPENCLAW_API_KEY=...       # OpenClaw Gateway (optional)
```

## systemd service

```ini
[Unit]
Description=Dark Kitchen Control Plane
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/dark-kitchen start --foreground
Restart=on-failure
Environment=GITHUB_TOKEN=...

[Install]
WantedBy=multi-user.target
```

## Managed capabilities

Optional E2E verification capabilities are provisioned through Dark Kitchen (not npm/apt):

```sh
dark-kitchen capabilities list
dark-kitchen capabilities ensure playwright   # Review plan, then approve
```
