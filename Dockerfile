# ==========================================================================
# Lumina 图床 · 多阶段构建镜像
# 采用 debian slim 基础镜像（glibc），sharp / better-sqlite3 均有官方预编译产物，
# 无需在构建期编译原生模块，镜像构建快且可复现。
# ==========================================================================

# ------------------------------ 依赖层 ------------------------------
FROM node:22-bookworm-slim AS deps

WORKDIR /app

# 仅复制清单文件，最大化利用 Docker layer 缓存
COPY package.json package-lock.json* .npmrc* ./

# 有 lockfile 用 npm ci（可复现），否则退回 npm install。
# --ignore-scripts：本项目依赖（better-sqlite3 13.x / sharp 0.34+）的二进制均随包
# 自带或经 optionalDependencies 平台子包分发，无需任何安装脚本；而 npm 10（Node 22
# 自带）见到包内 binding.gyp 仍会注入隐式 node-gyp rebuild（无视包声明的
# gypfile:false，lockfile 也不携带该字段），configure 需要 Python 3 与 Node 源码头，
# slim 镜像没有这些工具链。跳过脚本即可直接命中包内 prebuilds，零编译、更快更稳。
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev --ignore-scripts --no-audit --no-fund; \
    else \
      npm install --omit=dev --ignore-scripts --no-audit --no-fund; \
    fi \
 && npm cache clean --force

# ------------------------------ 运行层 ------------------------------
FROM node:22-bookworm-slim AS runner

# tini 负责正确的信号转发与僵尸进程回收，保证 docker stop 能优雅退出
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/app/data \
    STORAGE_DIR=/app/storage

WORKDIR /app

# 以非 root 用户运行，降低容器逃逸风险
RUN groupadd --system --gid 1001 lumina \
 && useradd --system --uid 1001 --gid lumina --create-home lumina

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY docs ./docs
COPY examples ./examples

# 数据与存储目录：通过 volume 挂载持久化
RUN mkdir -p /app/data /app/storage \
 && chown -R lumina:lumina /app

USER lumina

EXPOSE 3000

# 容器健康检查：直接打业务健康接口，而非仅探测端口
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT}/api/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server.js"]
