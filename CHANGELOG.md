# 更新日志（CHANGELOG）

本文件记录 Lumina 图床的显著变更。

- 格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。
- 日期按东八区（UTC+8）计，条目按「版本 + 发布日期」倒序排列，最新版本在最前。
- 变更类型固定为：功能新增 / 问题修复 / 优化调整 / 文档。
- 版本号与 `package.json` 保持一致；镜像标签由 CI 依据 Git tag 生成（当前仓库尚未打 tag，
  故下方链接暂以提交区间代替，打 tag 后可换成 `compare/v1.1.0...v1.2.0` 形式）。

## [未发布]

> 已合并但尚未归属到某个版本号的改动会累积在此处；发版时整体移入新的版本小节。

### 功能新增

- **上传列表逐张进度**：批量上传时不再显示一条统一总进度条，改为**每张图片各有一条独立的实时进度条**。
  - 文件一进入批次就为每张图建立任务卡片（本地预览缩略图 + 文件名 / 体积 + 独立进度条 + 状态徽标 + 删除按钮），上传完成后同一张卡片就地升级为带 5 种引用格式的结果卡片 —— 上传任务列表与结果列表合二为一，不再重复展示同一张图。
  - 任务状态机 `queued →（可选 converting）→ uploading → done | failed`：排队与浏览器内转码阶段拿不到字节级进度，进度条走不确定态动画而不伪造百分比；单张失败只标记自己，不中断整批。
  - 列表头部显示在途张数；原 `#progress` / `#progress-bar` / `#progress-text` 三个总进度元素已移除。

- **上传任务可单独删除（含上传进行中）**：任意状态下都能删除列表中指定的那一条，并清理其对应的资源与状态。
  - 上传中删除 → `xhr.abort()` 中断在途请求；若该张仍在排队，worker 领取到时会直接跳过；同时释放本地 `objectURL` 预览。
  - 已完成删除 → 连同服务端原图、缩略图与数据库记录一起清理，删除后直链与元数据均返回 404。
  - 新增**上传删除凭证** `delete_key`（`src/utils/deleteKey.js`）：形如 `HMAC-SHA256(sessionSecret, "lumina:delete:v1:<id>:<sha256>")`，校验使用 `timingSafeEqual` 常数时间比较。游客无需管理员 Token 即可删除自己刚上传的那一张，凭证不可伪造，且只对签发时的那条记录有效。
  - `DELETE /api/images/:id` 由「仅管理员」放宽为「管理员 Token **或** 合法 `delete_key`」两条通路；凭证通路一律软删除，`hard=1` 物理删除仍仅限管理员。
  - 秒传命中的记录**不下发**凭证（该记录由先上传者创建），避免后上传者删掉先上传者的文件。
  - 列表头「清空」改为「清空列表」并加提示：只清空本页展示，不触碰服务器上的图片（要删图片请用每条卡片上的删除按钮）。

### 优化调整

- 进度更新改为**只重绘该张卡片的进度条**（整数百分比变化时才写 DOM），不再整表重绘，避免打断用户正在进行的复制 / 切换引用格式操作。
- 卡片定位由数组下标改为任务 `uid`：删除任意一条后，其余卡片的索引与交互不再错位。

### 文档

- `docs/API.md`：`POST /api/upload` 响应新增 `delete_key` 字段说明；`DELETE /api/images/:id` 补充两条鉴权通路、`key` 参数与 401 错误码说明；权限模型表同步。
- `README.md`：新增 4.6「上传列表：逐张进度与单张删除」；4.5 中「整体进度」的表述改为「逐张进度」；目录结构与验证情况（三套测试 62 / 32 / 85，共 179 项 0 失败）同步更新。
- `examples/smoke-test.js` 新增 3.5「上传凭证删除」小节（10 项断言）；`examples/ui-check.js` 新增第 6 部分「上传列表：逐张进度与单张删除」（20 项断言）。

## [1.2.0] - 2026-09-19

### 功能新增

- **批量上传并发化**：上传页批量上传从单线程串行（逐张依次上传）重构为 worker 池并发上传。
  - 新增可配置项 `client_max_concurrency`（浏览器端最大同时在途上传数，1–6，默认 3）：支持 `.env`（`CLIENT_MAX_CONCURRENCY`）、管理台「客户端上传行为」分区热更新、`PATCH /api/settings` 三种配置方式，越界 / 非法值自动收敛到安全区间。
  - 每张图片按批次下标占用独立槽位，上传结果、进度与失败信息与原文件一一对应，不依赖完成顺序；结果列表按选择顺序合并展示。
  - 整体进度条聚合「已完成数 + 在途已传比例」，实时显示并发状态与失败计数；单张失败独立 toast 提示文件名与原因，不中断整批。
  - CLI 示例 `examples/upload.js` 同步支持并发上传：新增 `--concurrency`（别名 `-c`）参数与 `LUMINA_CONCURRENCY` 环境变量（1–10，默认 3），逐文件独立请求，按槽位收集成功明细与失败原因。

### 问题修复

- 修复管理台图片列表表头与数据行重叠的样式问题（`7c6f6ab`）。

### 优化调整

- 版本号对齐：`package.json` / `package-lock.json` 由 `1.0.0` 提升至 `1.2.0`，与本文档最新版本一致。

## [1.1.0] - 2026-09-18

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

### 文档

- 新增本更新日志，汇总 09-17 / 09-18 的交付与变更（`e5847a0`）。

## [1.0.0] - 2026-09-17

### 功能新增

- **Lumina 图床首次交付**：完整功能集与多架构镜像流水线一并入库（`f31d993`）。
  - 后端：Express 服务，鉴权 / 限流 / 上传 / 错误处理中间件，SQLite 元数据存储，图片处理（压缩、去重、直链）。
  - 存储驱动：本地（`local`）、WebDAV（`webdav`）、混合（`hybrid`）三模式。
  - 前端：上传页、管理台、404 页及公共脚本。
  - API 文档（`docs/API.md`）、README、`.env.example`、docker-compose、示例脚本（curl / Node / Python）齐备。
  - CI：GitHub Actions 多阶段流水线（lint、测试、多架构 Docker 镜像构建）。

### 问题修复

- 修正 `.gitignore` / `.dockerignore` 无斜杠规则误吞存储驱动源码的问题（`49dbe45`）：`storage` 目录曾被忽略规则整体排除，导致 `local.js` / `webdav.js` / `index.js` 未入库、镜像缺文件；已补齐三条驱动源码并调整忽略规则，`docker-lint.js` 增加对应守卫断言。

## 版本速览

| 版本 | 发布日期 | 主要变更 | 提交区间 |
| --- | --- | --- | --- |
| [1.2.0] | 2026-09-19 | 批量上传并发化（`client_max_concurrency`）、管理台表头重叠修复 | `7c6f6ab`...`HEAD` |
| [1.1.0] | 2026-09-18 | 自定义站点图标、WebDAV 直链全代理化、客户端上传行为可配置 | `66c64a8`...`7c6f6ab` |
| [1.0.0] | 2026-09-17 | 首次交付：核心图床功能、三存储驱动、多架构镜像流水线 | `f31d993`...`66c64a8` |

[未发布]: https://github.com/muxin-403/lumina-image-hosting/compare/HEAD...HEAD
[1.2.0]: https://github.com/muxin-403/lumina-image-hosting/compare/66c64a8...HEAD
[1.1.0]: https://github.com/muxin-403/lumina-image-hosting/compare/f31d993...66c64a8
[1.0.0]: https://github.com/muxin-403/lumina-image-hosting/commits/f31d993
