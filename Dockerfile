FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY tsconfig.base.json ./
RUN npm ci
RUN npm run build
# 保留锁定版本的 tsx：workflow 在运行时仍需加载 TypeScript。
RUN node --input-type=module -e "import { readdirSync, rmSync } from 'node:fs'; for (const p of readdirSync('packages')) { rmSync('packages/' + p + '/src', { recursive: true, force: true }); }"

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep bubblewrap ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ARG INSTALL_AGENT_CLIS=false
ARG CLAUDE_CODE_PACKAGE=@anthropic-ai/claude-code
ARG CODEX_PACKAGE=@openai/codex
ARG OPENCODE_PACKAGE=opencode-ai
ARG PI_PACKAGE=@mariozechner/pi-coding-agent
RUN if [ "$INSTALL_AGENT_CLIS" = "true" ]; then \
      npm install -g "$CLAUDE_CODE_PACKAGE" "$CODEX_PACKAGE" "$OPENCODE_PACKAGE" "$PI_PACKAGE"; \
    fi
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY templates ./templates
ENV NODE_ENV=production
EXPOSE 4870
VOLUME /space
CMD ["node", "packages/cli/dist/index.js", "serve", "--host", "0.0.0.0", "--port", "4870", "--project", "/space"]
