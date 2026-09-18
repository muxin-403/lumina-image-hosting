# 更新日志（CHANGELOG）

本文件记录 Lumina 图床的显著变更。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
日期按东八区（UTC+8）计。

## [2026-09-18] 未发布改动

### 功能新增

- **自定义站点图标（favicon）**：新增 `src/services/favicon.js`，支持在管理台上传 / 一键恢复默认站点图标。
  - 新增管理端 API：`POST /api/favicon`（上传 / 替换）、`DELETE /api/favicon`（恢复默认）。
  - 安全：不信任扩展名与 Content-Type，按文件头（magic bytes）嗅探真实格式，仅放行 `ico / png / svg / jpg / gif / webp`，单文件上限 1MB。
  - 页面统一从 `/favicon.ico|png|svg` 出口取图，未设置时回落 `public/favicon.svg`；元信息随 SQLite 持久化，图标文件随 `DATA_DIR` 落盘。
  - 通过 `?v=<ts>` 版本号生成破缓存链接，自定义图标采用 5 分钟短缓存。
  - 新增 `examples/favicon-smoke-test.js` 冒烟测试脚本。

- **WebDAV 直链全代理化**：对外直链统一由本站代理路由 `/i/<key>` 提供，后端通过 WebDAV 协议认证回源并转发内容，**绝不 302 / 不暴露网盘真实地址与凭据**。
  - 私有网盘（如坚果云）从此**零配置**即可出图，不再要求配置可公网直读的地址或 Alist 中转。
  - `WEBDAV_PUBLIC_URL` 已废弃（仅保留兼容），`.env.example`、`README.md`、`docs/API.md` 同步更新说明。
  - `/d/:id` 强制下载与缩略图缺失回落均收敛到统一的 `proxyRemote()` 代理转发逻辑（含 502 错误处理），去除重复兜底分支。

- **客户端上传行为可配置**：新增 4 项可在管理台热更新的设置（无需重启）：
  - `client_convert_webp`：浏览器端把 JPG/PNG/BMP 转 WebP（默认开启，服务端零算力开销）。
  - `client_compress`：浏览器端按质量参数做有损压缩（默认关闭）。
  - `client_webp_quality`：客户端 WebP 质量（40–100，默认 82）。
  - `auto_copy_url`：上传完成后自动复制直链。
  - 前台上传页与管理台（`home.js` / `common.js` / `admin.js`）同步适配，管理台不再展示这些开关对应的固定项。

### 优化调整

- `examples/ui-check.js`、`examples/webdav-test.js` 适配新直链语义与代理行为，更新断言与测试路径。
- WebDAV 存储驱动的地址拆分说明重写：`remoteUrl()`（读写地址，仅服务端使用）与 `url()`（对外直链，指向本站代理）职责更清晰。

## [2026-09-17]

### 功能新增

- **Lumina 图床首次交付**：完整功能集与多架构镜像流水线一并入库（`f31d993`）。
  - 后端：Express 服务，鉴权 / 限流 / 上传 / 错误处理中间件，SQLite 元数据存储，图片处理（压缩、去重、直链）。
  - 存储驱动：本地（`local`）、WebDAV（`webdav`）、混合（`hybrid`）三模式。
  - 前端：上传页、管理台、404 页及公共脚本。
  - API 文档（`docs/API.md`）、README、`.env.example`、docker-compose、示例脚本（curl / Node / Python）齐备。
  - CI：GitHub Actions 多阶段流水线（lint、测试、多架构 Docker 镜像构建）。

### 问题修复

- 修正 `.gitignore` / `.dockerignore` 无斜杠规则误吞存储驱动源码的问题（`49dbe45`）：`storage` 目录曾被忽略规则整体排除，导致 `local.js` / `webdav.js` / `index.js` 未入库、镜像缺文件；已补齐三条驱动源码并调整忽略规则，`docker-lint.js` 增加对应守卫断言。

[2026-09-18]: https://github.com/muxin-403/lumina-image-hosting/compare/f31d993...HEAD
[2026-09-17]: https://github.com/muxin-403/lumina-image-hosting/commits/f31d993
