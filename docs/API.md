# Lumina 图床 · RESTful API 文档

> 本文件是唯一的文档源，站点访问 `/api-docs` 时由服务端实时渲染为可浏览页面，
> 因此不存在「代码改了文档没改」的漂移问题。

## 概述

| 项目 | 说明 |
| --- | --- |
| 基础地址 | `http://<host>:<port>` 或你配置的 `PUBLIC_BASE_URL` |
| 接口前缀 | `/api` 与 `/api/v1` **完全等价**（推荐新项目使用 `/api/v1`） |
| 数据格式 | 请求与响应均为 JSON（上传接口为 `multipart/form-data`） |
| 字符编码 | UTF-8 |
| 时间字段 | 毫秒级 Unix 时间戳（`created_at`），另有 ISO 8601 形式的 `created_at_text` |
| 鉴权方式 | `Authorization: Bearer <token>`，也支持 `?token=` 与登录 Cookie |

### 统一响应结构

成功：

```json
{
  "success": true,
  "data": { },
  "pagination": { }
}
```

失败：

```json
{
  "success": false,
  "error": {
    "code": "FILE_TOO_LARGE",
    "message": "文件超过游客单文件上限 5.00 MB",
    "status": 413
  }
}
```

> 程序化处理请以 `error.code` 为准（稳定），`message` 仅用于展示。

### 权限模型

| 角色 | 说明 |
| --- | --- |
| 游客（匿名） | 可上传（受 `guest_upload_enabled` 开关与 `guest_max_file_size` 限制）、可访问图片直链与公开元数据 |
| 管理员 | 唯一账号，密码登录后获得 Token；可上传（不受游客限额）、查看列表、删除、改配置、看统计 |

---

## 鉴权 Authentication

### POST /api/auth/login

管理员登录，返回访问令牌。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| password | string | 是 | 管理员密码 |

```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"password":"admin123"}'
```

**响应**

```json
{
  "success": true,
  "data": {
    "token": "eyJzdWIiOiJhZG1pbi...xyz",
    "token_type": "Bearer",
    "expires_at": 1789977600,
    "expires_in": 604800,
    "user": { "name": "admin", "role": "admin" }
  }
}
```

> 登录成功同时会下发 `HttpOnly + SameSite=Strict` 的 Cookie，浏览器端可直接复用；
> 脚本调用请使用返回的 `token`。

### POST /api/auth/logout 🔒

吊销当前 Token。`🔒` 表示需要管理员 Token。

### GET /api/auth/me 🔒

查询当前登录态，返回 `{ user, expires_at, default_password }`。
`default_password=true` 表示仍在使用初始密码。

### POST /api/auth/password 🔒

修改管理员密码，**所有已签发的 Token 会立即失效**，并在响应中返回新的 Token。

```json
{ "old_password": "admin123", "new_password": "s3cure-pass" }
```

---

## 上传 Upload

### POST /api/upload

上传一张或多张图片。支持任意字段名，推荐 `file`（单张）或 `files`（多张）。

| 参数 | 位置 | 说明 |
| --- | --- | --- |
| file / files | form-data（文件） | 一个或多个图片文件，字段名可重复 |
| 游客单文件上限 | 配置 | 默认 `5MB`，由 `guest_max_file_size` 控制 |
| 管理员单文件上限 | 配置 | 默认 `20MB`，由 `max_file_size` 控制 |
| 单次文件数上限 | 配置 | 默认 `20`，由 `max_files` 控制 |

```bash
# 单张（游客）
curl -X POST http://localhost:3000/api/upload -F "file=@cat.png"

# 多张（管理员，带 Token）
curl -X POST http://localhost:3000/api/upload \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@a.jpg" -F "file=@b.webp" -F "file=@c.svg"
```

**响应（单张时 `data` 为对象，多张时为数组）**

```json
{
  "success": true,
  "data": {
    "id": "4fWYCKda9s",
    "filename": "cat.png",
    "ext": "png",
    "mime": "image/png",
    "size": 235312,
    "size_human": "229.80 KB",
    "width": 1920,
    "height": 1080,
    "pages": 1,
    "animated": false,
    "vector": false,
    "storage_driver": "local",
    "uploader": "guest",
    "created_at": 1789489113196,
    "created_at_text": "2026-09-15T16:18:33.196Z",

    "url": "http://localhost:3000/i/2026/09/4fWYCKda9s.png",
    "page_url": "http://localhost:3000/img/4fWYCKda9s",
    "thumb_url": "http://localhost:3000/t/4fWYCKda9s",

    "formats": {
      "url": "http://localhost:3000/i/2026/09/4fWYCKda9s.png",
      "thumbnail": "http://localhost:3000/t/4fWYCKda9s",
      "html": "<img src=\"...\" alt=\"cat.png\" />",
      "html_thumb": "<a href=\"...\" target=\"_blank\"><img src=\"...\" alt=\"cat.png\" /></a>",
      "markdown": "![cat.png](http://localhost:3000/i/2026/09/4fWYCKda9s.png)",
      "markdown_thumb": "[![cat.png](...thumb)](...url)",
      "bbcode": "[img]http://localhost:3000/i/2026/09/4fWYCKda9s.png[/img]",
      "bbcode_thumb": "[url=...][img]...[/img][/url]"
    },

    "duplicated": false,
    "compression": {
      "original_size": 943216,
      "final_size": 235312,
      "saved_bytes": 707904,
      "saved_percent": 75.1,
      "note": "已优化"
    }
  },
  "uploaded": 1,
  "failed": 0,
  "errors": []
}
```

**关键字段说明**

| 字段 | 说明 |
| --- | --- |
| `url` | **图片直链**，可直接嵌入网页、Markdown、论坛 |
| `page_url` | 图片详情页（含 `og:image`，适合分享） |
| `thumb_url` | 缩略图直链（WebP，列表场景省流量） |
| `formats` | 开箱即用的多格式引用文本，无需自己拼接 |
| `animated` / `pages` | 是否为动态图、总帧数（动态图原样保留，不丢帧） |
| `vector` | 是否为 SVG 矢量图（保持矢量，不栅格化） |
| `duplicated` | 内容命中秒传（相同 sha256 已存在），复用已有记录 |
| `compression` | 服务端优化前后的体积对比与说明 |

**部分失败**：多文件上传时，只要有一张成功即返回 `200`，
失败明细放在 `errors` 数组（`[{ filename, code, message }]`）；全部失败才返回错误码。

### GET /api/upload/limits

查询当前身份的实际上传限额，前端可据此做前置校验与提示。

```json
{
  "success": true,
  "data": {
    "identity": "guest",
    "guest_upload_enabled": true,
    "max_file_size": 5242880,
    "max_file_size_human": "5.00 MB",
    "max_files": 20,
    "allowed_formats": ["jpg", "jpeg", "png", "gif", "webp", "svg", "avif"]
  }
}
```

---

## 图片管理 Images

### GET /api/images 🔒

分页查询图片列表。

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| page | int | 1 | 页码 |
| limit | int | 24 | 每页条数，最大 200 |
| q | string | — | 关键词，匹配文件名 / ID / 存储路径 |
| uploader | string | — | `admin` 或 `guest` |
| ext | string | — | 按格式筛选，如 `png` |
| order | string | newest | `newest` / `oldest` / `largest` / `smallest` |

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/api/images?page=1&limit=24&order=largest&uploader=guest"
```

**响应** 除 `data` 外还包含分页信息：

```json
{
  "success": true,
  "data": [ { "id": "...", "url": "..." } ],
  "pagination": {
    "page": 1, "limit": 24, "total": 137, "pages": 6,
    "has_next": true, "has_prev": false
  }
}
```

### GET /api/images/:id

获取单张图片的元数据（**公开接口**，无需 Token）。
适合「已知 ID 要拿直链」的场景。

### DELETE /api/images/:id 🔒

删除图片：同时移除存储中的原图、本地缩略图，并对数据库记录做软删除。

| 参数 | 说明 |
| --- | --- |
| hard=1 | 附加查询参数，执行物理删除而非软删除 |

```bash
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/images/4fWYCKda9s
```

```json
{
  "success": true,
  "data": {
    "id": "4fWYCKda9s",
    "storage_key": "2026/09/4fWYCKda9s.png",
    "shared": false,
    "hard": false,
    "message": "删除成功"
  }
}
```

> `shared=true` 表示该文件被其它记录通过秒传共享，物理文件会被保留。

### POST /api/images/batch-delete 🔒

批量删除，单次最多 200 张。

```json
{ "ids": ["4fWYCKda9s", "vbsNkGd2qU"] }
```

```json
{
  "success": true,
  "data": {
    "deleted": ["4fWYCKda9s"],
    "failed": [ { "id": "vbsNkGd2qU", "message": "图片不存在：vbsNkGd2qU" } ],
    "requested": 2
  }
}
```

### GET /api/images/stats 🔒

站点统计。

```json
{
  "success": true,
  "data": {
    "total": 137,
    "totalBytes": 48234112,
    "total_human": "46.00 MB",
    "todayCount": 12,
    "todayBytes": 3145728,
    "today_bytes_human": "3.00 MB",
    "animatedCount": 4,
    "vectorCount": 7,
    "byExt": [ { "ext": "png", "count": 90, "bytes": 30123456 } ],
    "byDriver": [ { "driver": "local", "count": 137 } ]
  }
}
```

---

## 配置 Configuration

### GET /api/config

公开配置（**无需 Token**），前端渲染用。不包含任何敏感字段。

```json
{
  "success": true,
  "data": {
    "site_name": "Lumina 图床",
    "guest_upload_enabled": true,
    "guest_max_file_size": 5242880,
    "max_file_size": 20971520,
    "max_files": 20,
    "allowed_formats": ["jpg", "jpeg", "png", "gif", "webp", "svg", "avif"],
    "thumbnail_width": 480,
    "storage_driver": "local",
    "webdav_configured": false
  }
}
```

### GET /api/settings 🔒

完整配置（管理员）。WebDAV 密码不会回传明文，仅返回 `webdav_password_set` 布尔值。

### PATCH /api/settings 🔒

热更新配置，**立即生效、无需重启**。

| 字段 | 类型 | 范围 | 说明 |
| --- | --- | --- | --- |
| site_name | string | ≤60 | 站点名称 |
| guest_upload_enabled | bool | — | 是否允许游客上传 |
| guest_max_file_size | int(字节) | 1KB–1GB | **游客单文件上限** |
| max_file_size | int(字节) | 1KB–5GB | 管理员单文件上限 |
| max_files | int | 1–100 | 单次请求文件数上限 |
| storage_driver | enum | `local`/`webdav`/`hybrid` | 存储驱动 |
| optimize | bool | — | 是否服务端再压缩 |
| optimize_quality | int | 30–100 | 压缩质量 |
| thumbnail_width | int | 64–2000 | 缩略图宽度 |
| allowed_formats | string[] | ≤20 项 | 允许的扩展名 |
| webdav_url | string | — | WebDAV 根地址 |
| webdav_username | string | — | 用户名 |
| webdav_password | string | — | 密码；**留空表示不修改** |
| webdav_directory | string | — | 远端目录，自动递归创建 |
| webdav_public_url | string | — | 直链前缀（**需已包含远端目录**），直链 = 前缀 + `/年月/文件名` |
| dedupe | bool | — | 相同内容秒传去重 |

```bash
# 把游客上传上限调整为 8MB，并开启游客上传
curl -X PATCH http://localhost:3000/api/settings \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"guest_upload_enabled":true,"guest_max_file_size":8388608}'
```

```json
{
  "success": true,
  "data": {
    "updated": ["guest_upload_enabled", "guest_max_file_size"],
    "config": { "guest_max_file_size": 8388608, "guest_max_file_size_human": "8.00 MB" },
    "warnings": []
  }
}
```

### DELETE /api/settings/:key 🔒

把某项配置恢复为环境变量 / 代码默认值。

### GET /api/storage/health 🔒

存储驱动自检。WebDAV 会实际写入并删除一个探针文件，验证读写权限。

```json
{
  "success": true,
  "data": {
    "mode": "hybrid",
    "ok": true,
    "drivers": [
      { "driver": "local", "ok": true, "message": "本地磁盘可写", "detail": "/app/storage" },
      { "driver": "webdav", "ok": true, "message": "连接成功，读写权限正常", "detail": "https://dav.example.com/remote.php/dav/files/me" }
    ]
  }
}
```

---

## 系统 System

### GET /api/health

健康检查，无需鉴权。适合容器探针 / 负载均衡健康检查。

```json
{
  "success": true,
  "data": {
    "status": "ok",
    "service": "lumina-image-hosting",
    "version": "1.0.0",
    "node": "v22.22.2",
    "uptime_seconds": 3612,
    "storage_driver": "local",
    "images": 137,
    "time": "2026-09-16T00:11:45.000Z"
  }
}
```

---

## 资源与页面路由

| 路由 | 说明 |
| --- | --- |
| `GET /i/<yyyy/mm/id.ext>` | **图片直链**（本地/混合驱动的对外地址） |
| `GET /t/:id` | 缩略图（WebP，恒存本地） |
| `GET /d/:id` | 强制下载；WebDAV 私有网盘场景下由服务端代理取流 |
| `GET /img/:id` | 图片详情页（带 `og:image`） |
| `GET /` | 上传页 |
| `GET /admin` | 管理台 |
| `GET /api-docs` | 本文档的网页版 |
| `GET /api/health` | 健康检查 |

---

## 错误码

| HTTP | code | 含义与处理建议 |
| --- | --- | --- |
| 400 | `NO_FILE` | 未收到文件，检查 form-data 字段名 |
| 400 | `MISSING_PASSWORD` | 登录未提供 password |
| 400 | `BAD_ID` | 图片 ID 非法 |
| 400 | `BAD_VALUE` / `UNKNOWN_SETTING` | 配置项非法 |
| 401 | `UNAUTHORIZED` | 缺少或无效的管理员 Token |
| 401 | `BAD_CREDENTIALS` | 密码错误 |
| 403 | `GUEST_UPLOAD_DISABLED` | 站点已关闭游客上传，改用管理员 Token |
| 404 | `IMAGE_NOT_FOUND` | 图片不存在或已删除 |
| 413 | `FILE_TOO_LARGE` | 超过身份对应的单文件上限 |
| 413 | `TOO_MANY_FILES` | 单次文件数超限 |
| 415 | `UNSUPPORTED_FORMAT` | 无法识别的图片格式（文件可能损坏或伪装扩展名） |
| 415 | `FORMAT_NOT_ALLOWED` | 格式在允许清单之外 |
| 422 | `PROCESS_FAILED` | 图片处理失败（多为文件损坏） |
| 429 | `RATE_LIMITED` | 触发限流，按响应头 `Retry-After` 重试 |
| 502 | `STORAGE_WRITE_FAILED` | 主存储写入失败（WebDAV 不可达 / 凭据错误） |
| 504 | `UPSTREAM_ERROR` / 超时 | 上游存储超时 |

### 限流

默认基于 IP 的滑动窗口限流，可通过环境变量调整或关闭（置 0 即关闭）：

| 作用域 | 环境变量 | 默认 |
| --- | --- | --- |
| 上传 | `RATE_LIMIT_UPLOAD_MAX` | 60 次 / 分钟 |
| 登录 | `RATE_LIMIT_LOGIN_MAX` | 10 次 / 分钟 |
| 通用 API | `RATE_LIMIT_API_MAX` | 600 次 / 分钟 |

响应头携带 `X-RateLimit-Limit`、`X-RateLimit-Remaining`，被限流时附加 `Retry-After`。

---

## 格式支持

| 格式 | 扩展名 | 服务端处理策略 |
| --- | --- | --- |
| JPEG | `.jpg` `.jpeg` | EXIF 自动转向 → 超尺寸等比缩小 → mozjpeg 有损再压缩 |
| PNG | `.png` | 无损再压缩（`compressionLevel: 9`），保留透明通道 |
| GIF | `.gif` | 静态：按原格式处理；**动态：原样保留全部帧** |
| WebP | `.webp` | 静态再压缩；动画 WebP 原样保留 |
| SVG | `.svg` | **保持矢量，绝不栅格化**；仅做安全精简（去注释/脚本/事件属性） |
| AVIF | `.avif` | 静态再压缩；动画 AVIF 原样保留 |

> **WebP 转换在前端完成**：上传页的「客户端转 WebP」使用 Canvas `toBlob('image/webp')`，
> 服务端零算力开销。GIF / SVG / AVIF 会自动跳过（转换会破坏动画或矢量特性）。
