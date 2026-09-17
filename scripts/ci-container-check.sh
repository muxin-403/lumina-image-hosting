#!/usr/bin/env bash
# ==========================================================================
# 容器级验证脚本
# --------------------------------------------------------------------------
# 只靠静态检查拿不到的不变式，必须把镜像真正跑起来才能确认：
#   · 目标架构正确（多架构流水线最容易「构建成功但装错架构」）
#   · 原生模块（better-sqlite3 / sharp）在目标架构上确实能加载
#     —— 服务能完成启动即证明：better-sqlite3 在 DB 初始化时加载、
#        sharp 在 services/image.js 顶层 require，任一加载失败进程直接崩溃
#   · 非 root 运行、HEALTHCHECK 探测真实业务接口
#   · /app/data 对运行用户可写（数据卷权限契约）
#   · docker stop 能优雅退出（tini 信号转发生效）
#
# 用法：
#   ci-container-check.sh <镜像引用> <平台> <期望架构> <宿主端口> [--pull]
#
#   <平台>      传给 docker run --platform，如 linux/arm64
#   <期望架构>  docker image inspect 的 Architecture 字段，如 arm64
#   [--pull]    先显式 pull 目标平台（跨架构场景必需，本地镜像则不要加）
# ==========================================================================
set -uo pipefail

IMG="${1:?缺少参数：镜像引用}"
PLATFORM="${2:?缺少参数：平台（如 linux/arm64）}"
EXPECT_ARCH="${3:?缺少参数：期望架构（如 arm64）}"
HOST_PORT="${4:?缺少参数：宿主端口}"
PULL="${5:-}"

CONTAINER="ci-verify-${EXPECT_ARCH//[^a-z0-9]/}"
FAILS=0

pass() { echo "  ✓ $1 — $2"; }
fail() { echo "  ✗ $1 — 期望 [$3]，实际 [$2]"; FAILS=$((FAILS + 1)); }
check() { # check <描述> <实际> <期望>
  if [ "$2" = "$3" ]; then pass "$1" "$2"; else fail "$1" "$2" "$3"; fi
}

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "── [$PLATFORM] 准备镜像 ──"
if [ "$PULL" = "--pull" ]; then
  # buildx 的 push 不会把镜像留在本机守护进程里，且默认只拉宿主架构，
  # 必须显式指定 --platform 才能拿到目标架构的那份
  docker pull --platform "$PLATFORM" "$IMG" >/dev/null || { echo "::error::拉取 $PLATFORM 镜像失败"; exit 1; }
  echo "  已拉取 $PLATFORM"
fi

ARCH=$(docker image inspect --format '{{.Architecture}}' "$IMG")
check "镜像架构" "$ARCH" "$EXPECT_ARCH"

echo "── [$PLATFORM] 启动容器 ──"
docker run -d --name "$CONTAINER" --platform "$PLATFORM" -p "${HOST_PORT}:3000" "$IMG" >/dev/null \
  || { echo "::error::容器启动失败"; exit 1; }

echo "── [$PLATFORM] 等待服务就绪 ──"
READY=0
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${HOST_PORT}/api/health" 2>/dev/null; then READY=1; break; fi
  sleep 1
done
if [ "$READY" -ne 1 ]; then
  echo "::error::$PLATFORM 容器未能在 60s 内响应 /api/health"
  docker logs "$CONTAINER" || true
  exit 1
fi
pass "服务已就绪" "60s 内"

echo "── [$PLATFORM] 真实指令集（原生模块能否加载的根因）──"
# 这一项是「构建成功但跑不起来」最直接的证据：QEMU 下 uname -m 会返回
# 目标架构，若 Dockerfile 平台选择有误，此处会暴露为宿主架构
case "$EXPECT_ARCH" in
  amd64) WANT_MACHINE="x86_64" ;;
  arm64) WANT_MACHINE="aarch64" ;;
  *) WANT_MACHINE="$EXPECT_ARCH" ;;
esac
check "容器内 uname -m" "$(docker exec "$CONTAINER" uname -m)" "$WANT_MACHINE"

echo "── [$PLATFORM] HTTP 可用性 ──"
for path in / /admin /api-docs /api/health /css/style.css; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${HOST_PORT}${path}")
  check "GET ${path}" "$code" "200"
done

echo "── [$PLATFORM] 镜像契约 ──"
check "运行系统" "$(docker image inspect --format '{{.Os}}' "$IMG")" "linux"
check "运行用户" "$(docker inspect --format '{{.Config.User}}' "$CONTAINER")" "lumina"
check "运行 UID" "$(docker exec "$CONTAINER" id -u)" "1001"

HC=$(docker inspect --format '{{json .Config.Healthcheck}}' "$CONTAINER")
if printf '%s' "$HC" | grep -q '/api/health'; then
  pass "HEALTHCHECK 探测 /api/health" "ok"
else
  fail "HEALTHCHECK 探测 /api/health" "$HC" "包含 /api/health"
fi

echo "── [$PLATFORM] 数据卷可写性 ──"
if docker exec "$CONTAINER" sh -c 'touch /app/data/.ci-probe && rm /app/data/.ci-probe'; then
  pass "lumina 用户可写 /app/data" "ok"
else
  fail "lumina 用户可写 /app/data" "不可写" "可写"
fi

echo "── [$PLATFORM] 优雅退出 ──"
docker stop "$CONTAINER" >/dev/null
check "docker stop 后退出码" "$(docker inspect --format '{{.State.ExitCode}}' "$CONTAINER")" "0"

echo ""
if [ "$FAILS" -ne 0 ]; then
  echo "::error::[$PLATFORM] 容器级验证失败 ${FAILS} 项"
  docker logs "$CONTAINER" 2>&1 | tail -30 || true
  exit 1
fi
echo "[$PLATFORM] 容器级验证全部通过"
