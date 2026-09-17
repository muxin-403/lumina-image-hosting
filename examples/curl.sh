#!/usr/bin/env bash
# ==========================================================================
# Lumina 图床 · curl 示例集
# 用法：BASE=http://localhost:3000 PASSWORD=admin123 bash examples/curl.sh
# ==========================================================================
set -euo pipefail

BASE="${BASE:-http://localhost:3000}"
PASSWORD="${PASSWORD:-admin123}"
IMAGE="${1:-tmp-assets/sample.png}"

# 依赖 jq 提取字段；没有 jq 时回退到 sed
have_jq() { command -v jq >/dev/null 2>&1; }

# 取 JSON 里的字符串字段（jq 优先，无 jq 时用 sed 兜底）
jget() { # jget <json> <key>
  if have_jq; then
    printf '%s' "$1" | jq -r ".data.$2 // empty"
  else
    printf '%s' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p" | head -1
  fi
}

# 探测 URL：用 HEAD 请求，只打印状态行与 Content-Type。
# 说明：
#   1) 不用 -o /dev/null —— 部分 Windows 版 curl 写 /dev/null 会返回退出码 23
#      （Failed writing body）；HEAD 无响应体，天然规避该问题。
#   2) 用变量承接输出再管道 —— 脚本开了 pipefail，curl 的非零退出码
#      会污染整条管道，进而触发 set -e 提前中断。
probe() {
  local out
  out="$(curl -sI "$@" 2>/dev/null || true)"
  printf '%s\n' "$out" | sed -n '1p;/^[Cc]ontent-[Tt]ype/p'
}

# 只要状态行
status_of() {
  local out
  out="$(curl -sI "$@" 2>/dev/null || true)"
  printf '%s\n' "$out" | sed -n '1p'
}

echo "=============================================================="
echo " 1. 服务健康检查"
echo "=============================================================="
curl -s "$BASE/api/health"; echo

echo
echo "=============================================================="
echo " 2. 游客上传（无需任何凭据）"
echo "=============================================================="
GUEST_RES=$(curl -s -X POST "$BASE/api/upload" -F "file=@$IMAGE")
echo "$GUEST_RES" | { have_jq && jq . || cat; } 2>/dev/null || echo "$GUEST_RES"

GUEST_ID=$(echo "$GUEST_RES" | { have_jq && jq -r '.data.id' || sed -n 's/.*"id":"\([^"]*\)".*/\1/p'; })
GUEST_URL=$(echo "$GUEST_RES" | { have_jq && jq -r '.data.url' || sed -n 's/.*"url":"\([^"]*\)".*/\1/p'; })
echo
echo "-> 图片 ID : $GUEST_ID"
echo "-> 直链    : $GUEST_URL"

echo
echo "=============================================================="
echo " 3. 访问直链（验证可公开访问）"
echo "=============================================================="
probe "$GUEST_URL"

echo
echo "=============================================================="
echo " 4. 游客尝试删除（预期 401 被拒绝）"
echo "=============================================================="
curl -s -X DELETE "$BASE/api/images/$GUEST_ID"; echo

echo
echo "=============================================================="
echo " 5. 管理员登录"
echo "=============================================================="
LOGIN_RES=$(curl -s -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" -d "{\"password\":\"$PASSWORD\"}")
TOKEN=$(jget "$LOGIN_RES" token)
echo "-> TOKEN: ${TOKEN:0:48}…"

AUTH=(-H "Authorization: Bearer $TOKEN")

echo
echo "=============================================================="
echo " 6. 多张批量上传（管理员，可上传更大文件）"
echo "=============================================================="
curl -s -X POST "$BASE/api/upload" "${AUTH[@]}" \
  -F "file=@tmp-assets/sample.jpg" \
  -F "file=@tmp-assets/anim.gif" \
  -F "file=@tmp-assets/vector.svg" \
  -F "file=@tmp-assets/sample.avif" \
  | { have_jq && jq '{uploaded, failed, ids: [.data[].id], urls: [.data[].url]}' || cat; }

echo
echo "=============================================================="
echo " 7. 图片列表（分页 + 筛选 + 排序）"
echo "=============================================================="
curl -s "$BASE/api/images?page=1&limit=3&order=largest" "${AUTH[@]}" \
  | { have_jq && jq '{pagination, items: [.data[] | {id, filename, size_human, width, height}]}' || cat; }

echo
echo "=============================================================="
echo " 8. 只筛选游客上传的图片"
echo "=============================================================="
curl -s "$BASE/api/images?uploader=guest&limit=2" "${AUTH[@]}" \
  | { have_jq && jq '{total: .pagination.total, ids: [.data[].id]}' || cat; }

echo
echo "=============================================================="
echo " 9. 站点统计"
echo "=============================================================="
curl -s "$BASE/api/images/stats" "${AUTH[@]}" \
  | { have_jq && jq '.data | {total, total_human, todayCount, animatedCount, vectorCount}' || cat; }

echo
echo "=============================================================="
echo " 10. 读取当前配置"
echo "=============================================================="
curl -s "$BASE/api/settings" "${AUTH[@]}" \
  | { have_jq && jq '.data | {site_name, guest_upload_enabled, guest_max_file_size, guest_max_file_size_human, storage_driver, optimize}' || cat; }

echo
echo "=============================================================="
echo " 11. 修改游客上传大小上限为 8MB（热生效，无需重启）"
echo "=============================================================="
curl -s -X PATCH "$BASE/api/settings" "${AUTH[@]}" \
  -H "Content-Type: application/json" \
  -d '{"guest_max_file_size": 8388608}' \
  | { have_jq && jq '.data | {updated, guest_max_file_size: .config.guest_max_file_size_human}' || cat; }

echo
echo "  恢复为 5MB…"
curl -s -X PATCH "$BASE/api/settings" "${AUTH[@]}" \
  -H "Content-Type: application/json" \
  -d '{"guest_max_file_size": 5242880}' >/dev/null && echo "  已恢复"

echo
echo "=============================================================="
echo " 12. 存储健康检查"
echo "=============================================================="
curl -s "$BASE/api/storage/health" "${AUTH[@]}" \
  | { have_jq && jq '.data | {mode, ok, drivers}' || cat; }

echo
echo "=============================================================="
echo " 13. 删除图片（管理员）"
echo "=============================================================="
curl -s -X DELETE "$BASE/api/images/$GUEST_ID" "${AUTH[@]}"; echo

echo
echo "  删除后直链应返回 404："
echo "  $(status_of "$GUEST_URL")"

echo
echo "=============================================================="
echo " 14. 退出登录（吊销 Token）"
echo "=============================================================="
curl -s -X POST "$BASE/api/auth/logout" "${AUTH[@]}"; echo

echo
echo "  吊销后再次调用管理接口应返回 401："
echo "  $(status_of "$BASE/api/images" "${AUTH[@]}")"

echo
echo "全部示例执行完毕。"
