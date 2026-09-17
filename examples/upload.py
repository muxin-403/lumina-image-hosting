#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Lumina 图床 · Python 客户端示例（仅用标准库，零依赖）

用法：
    # 游客上传（无需密码）
    python examples/upload.py upload images/cat.png

    # 管理员上传多张 + 管理操作
    python examples/upload.py upload images/*.png --password admin123
    python examples/upload.py list   --password admin123 --limit 5 --order largest
    python examples/upload.py stats  --password admin123
    python examples/upload.py delete <id> --password admin123
    python examples/upload.py settings --password admin123 --guest-max 8mb

环境变量：
    LUMINA_BASE      服务地址，默认 http://localhost:3000
    LUMINA_PASSWORD  管理员密码
"""

import argparse
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

BASE = os.environ.get("LUMINA_BASE", "http://localhost:3000").rstrip("/")
PASSWORD = os.environ.get("LUMINA_PASSWORD", "")

TOKEN = None  # 登录后填充


# --------------------------------------------------------------------------- #
# HTTP 底层
# --------------------------------------------------------------------------- #

def request(method, path, data=None, headers=None):
    """发起请求，返回 (status, payload)。payload 优先按 JSON 解析。"""
    hdrs = {"Accept": "application/json"}
    if TOKEN:
        hdrs["Authorization"] = "Bearer " + TOKEN
    if headers:
        hdrs.update(headers)

    req = urllib.request.Request(BASE + path, data=data, headers=hdrs, method=method)

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            status, body = resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        status, body = exc.code, exc.read()

    try:
        return status, json.loads(body.decode("utf-8"))
    except Exception:
        return status, {"success": False, "raw": body.decode("utf-8", "replace")}


def ensure_ok(status, payload, action):
    if status >= 400 or not payload.get("success"):
        error = payload.get("error") or {}
        message = error.get("message") or payload.get("raw") or ("HTTP %s" % status)
        print("✗ %s 失败：%s" % (action, message), file=sys.stderr)
        sys.exit(1)
    return payload


# --------------------------------------------------------------------------- #
# multipart/form-data 手工编码（避免引入 requests 依赖）
# --------------------------------------------------------------------------- #

def encode_multipart(files):
    """files: [(field_name, filename, content_bytes)] -> (body, content_type)"""
    boundary = "----LuminaBoundary" + uuid.uuid4().hex
    crlf = b"\r\n"
    chunks = []

    for field, filename, content in files:
        ctype = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        chunks.append(("--" + boundary).encode("ascii"))
        chunks.append(
            ('Content-Disposition: form-data; name="%s"; filename="%s"' % (field, filename))
            .encode("utf-8")
        )
        chunks.append(("Content-Type: " + ctype).encode("ascii"))
        chunks.append(b"")
        chunks.append(content)

    chunks.append(("--" + boundary + "--").encode("ascii"))
    chunks.append(b"")

    return crlf.join(chunks), "multipart/form-data; boundary=" + boundary


# --------------------------------------------------------------------------- #
# 业务封装
# --------------------------------------------------------------------------- #

def login(password):
    global TOKEN
    status, payload = request(
        "POST",
        "/api/auth/login",
        data=json.dumps({"password": password}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    ensure_ok(status, payload, "登录")
    TOKEN = payload["data"]["token"]
    print("✓ 管理员登录成功，Token 前缀 %s…" % TOKEN[:16])
    return TOKEN


def upload(paths):
    files = []
    for path in paths:
        if not os.path.isfile(path):
            print("✗ 文件不存在：%s" % path, file=sys.stderr)
            sys.exit(1)
        with open(path, "rb") as handle:
            files.append(("file", os.path.basename(path), handle.read()))

    body, ctype = encode_multipart(files)
    status, payload = request("POST", "/api/upload", data=body, headers={"Content-Type": ctype})
    ensure_ok(status, payload, "上传")

    items = payload["data"] if isinstance(payload["data"], list) else [payload["data"]]
    print("✓ 上传成功 %s 张（失败 %s 张）\n" % (len(items), payload.get("failed", 0)))

    for item in items:
        flags = []
        if item.get("vector"):
            flags.append("矢量")
        if item.get("animated"):
            flags.append("动态 %s 帧" % item.get("pages"))
        if item.get("duplicated"):
            flags.append("秒传")

        compression = item.get("compression") or {}
        saved = ""
        if compression.get("saved_bytes", 0) > 0:
            saved = "  节省 %s%%" % compression.get("saved_percent")

        print("  " + item["filename"])
        print("    直链     " + item["url"])
        print("    详情页   " + item["page_url"])
        print("    缩略图   " + item["thumb_url"])
        print("    尺寸     %s×%s  大小 %s%s" % (
            item["width"], item["height"], item["size_human"], saved))
        print("    存储     %s  %s" % (item["storage_driver"], " ".join(flags)))
        print("    Markdown " + item["formats"]["markdown"])
        print("    BBCode   " + item["formats"]["bbcode"])
        print()

    return items


def list_images(page=1, limit=20, order="newest", uploader=None, keyword=None):
    query = "?page=%d&limit=%d&order=%s" % (page, limit, order)
    if uploader:
        query += "&uploader=" + uploader
    if keyword:
        query += "&q=" + urllib.parse.quote(keyword)

    status, payload = request("GET", "/api/images" + query)
    ensure_ok(status, payload, "获取列表")

    meta = payload["pagination"]
    print("共 %s 张，第 %s/%s 页\n" % (meta["total"], meta["page"], meta["pages"]))

    header = "%-14s%-26s%-14s%-11s%-8s%s" % ("ID", "文件名", "尺寸", "体积", "来源", "直链")
    print(header)
    print("-" * min(len(header) + 30, 130))
    for item in payload["data"]:
        print("%-14s%-26s%-14s%-11s%-8s%s" % (
            item["id"],
            item["filename"][:24],
            "%s×%s" % (item["width"], item["height"]),
            item["size_human"],
            item["uploader"],
            item["url"],
        ))
    return payload


def stats():
    status, payload = request("GET", "/api/images/stats")
    ensure_ok(status, payload, "获取统计")
    data = payload["data"]

    print("站点统计")
    print("  图片总数    %s（动态图 %s，矢量图 %s）" % (
        data["total"], data["animatedCount"], data["vectorCount"]))
    print("  占用空间    " + data["total_human"])
    print("  今日上传    %s 张 / %s" % (data["todayCount"], data["today_bytes_human"]))
    print("  格式分布    " + "  ".join(
        "%s:%s" % (f["ext"].upper(), f["count"]) for f in data["byExt"]))
    print("  存储驱动    " + "  ".join(
        "%s:%s" % (f["driver"], f["count"]) for f in data["byDriver"]))
    return data


def delete(image_id):
    status, payload = request("DELETE", "/api/images/" + urllib.parse.quote(image_id))
    ensure_ok(status, payload, "删除")
    print("✓ 已删除 %s" % image_id)
    return payload["data"]


def update_settings(patch):
    status, payload = request(
        "PATCH",
        "/api/settings",
        data=json.dumps(patch).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    ensure_ok(status, payload, "更新配置")
    print("✓ 已更新：" + ", ".join(payload["data"]["updated"]))
    for warning in payload["data"].get("warnings") or []:
        print("  ⚠ " + warning)
    return payload["data"]


def parse_size(text):
    """'8mb' / '512kb' / '1048576' -> int 字节"""
    text = str(text).strip().lower()
    for suffix, multiplier in (("gb", 1024 ** 3), ("mb", 1024 ** 2), ("kb", 1024), ("b", 1)):
        if text.endswith(suffix):
            return int(float(text[: -len(suffix)]) * multiplier)
    return int(text)


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def main():
    # 必须先声明 global，否则下面读 BASE 作为默认值会与 global 声明冲突
    global BASE

    parser = argparse.ArgumentParser(description="Lumina 图床 Python 客户端")
    parser.add_argument("action",
                        choices=["upload", "list", "stats", "delete", "settings", "health"])
    parser.add_argument("args", nargs="*", help="upload 传文件路径；delete 传图片 ID")
    parser.add_argument("--base", default=BASE, help="服务地址")
    parser.add_argument("--password", default=PASSWORD, help="管理员密码")
    parser.add_argument("--page", type=int, default=1)
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--order", default="newest",
                        choices=["newest", "oldest", "largest", "smallest"])
    parser.add_argument("--uploader", choices=["admin", "guest"])
    parser.add_argument("--q", help="搜索关键词")
    parser.add_argument("--guest-max", help="设置游客单文件上限，如 8mb")
    parser.add_argument("--guest-enabled", choices=["true", "false"], help="开关游客上传")
    parser.add_argument("--driver", choices=["local", "webdav", "hybrid"], help="切换存储驱动")

    opts = parser.parse_args()

    BASE = opts.base.rstrip("/")

    if opts.action in ("list", "stats", "delete", "settings"):
        if not opts.password:
            print("✗ 该操作需要管理员密码，请用 --password 或设置 LUMINA_PASSWORD",
                  file=sys.stderr)
            sys.exit(2)
        login(opts.password)

    if opts.action == "health":
        _, payload = request("GET", "/api/health")
        print(json.dumps(payload, ensure_ascii=False, indent=2))

    elif opts.action == "upload":
        if not opts.args:
            print("✗ 请至少指定一个图片路径", file=sys.stderr)
            sys.exit(2)
        upload(opts.args)

    elif opts.action == "list":
        list_images(opts.page, opts.limit, opts.order, opts.uploader, opts.q)

    elif opts.action == "stats":
        stats()

    elif opts.action == "delete":
        if not opts.args:
            print("✗ 请指定图片 ID", file=sys.stderr)
            sys.exit(2)
        for image_id in opts.args:
            delete(image_id)

    elif opts.action == "settings":
        patch = {}
        if opts.guest_max:
            patch["guest_max_file_size"] = parse_size(opts.guest_max)
        if opts.guest_enabled is not None:
            patch["guest_upload_enabled"] = opts.guest_enabled == "true"
        if opts.driver:
            patch["storage_driver"] = opts.driver

        if patch:
            update_settings(patch)
        else:
            _, payload = request("GET", "/api/settings")
            print(json.dumps(payload.get("data", payload), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
