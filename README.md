# Lumina 图床

轻量级自托管图床。拖进来就上传，立刻拿到直链、HTML、Markdown、BBCode 四种引用格式；
同时支持**本地磁盘**与 **WebDAV 网盘**两种存储；提供完整的 RESTful API 供程序化调用。

> 零前端构建、零 ORM、零第三方鉴权库 —— 克隆下来 `npm install && npm start` 就能跑。

---

## 一、技术栈与选型说明

| 层次 | 选型 | 版本 | 为什么选它 |
| --- | --- | --- | --- |
| 运行时 | **Node.js** | ≥ 18.17（推荐 22 LTS） | 与 `sharp` / `fetch` / `FormData` 生态天然契合，容器镜像小 |
| Web 框架 | **Express** | 4.x | 中间件模型清晰，路由/错误处理语义成熟，团队熟悉度最高 |
| 数据库 | **SQLite（better-sqlite3）** | 11.x | 单文件零运维；同步 API 免去连接池与回调嵌套；性能足够单机图床量级 |
| 图像处理 | **Sharp（libvips）** | 0.34 | 目前 Node 生态最快最稳的图像库，原生支持 WebP / AVIF / 动图多帧读取与 EXIF 自动转向 |
| 文件接收 | **multer**（memoryStorage） | 2.x | 标准 multipart 解析；内存存储避免产生垃圾临时文件 |
| 配置 | **dotenv** | 16.x | 只做环境变量加载，运行时热配置走数据库 |
| 前端 | **原生 HTML5 + CSS3 + ES2020** | — | 无框架、无构建、无 node_modules 前端依赖；上传页首屏只有一个 HTML + 两个 JS |
| 鉴权 | **Node 内置 crypto**（HMAC-SHA256 + scrypt） | — | 少一个依赖少一处供应链风险；Token 结构与 JWT 一致，另附服务端吊销名单 |
| WebDAV 客户端 | **Node 内置 fetch** | — | 手写 MKCOL/PUT/DELETE/HEAD，避免引入重量级 webdav 依赖，行为完全可控 |
| 部署 | **Docker + Compose** | — | 多阶段构建 + 非 root 运行 + tini 信号转发 |

**合计生产依赖仅 5 个包**（express / better-sqlite3 / sharp / multer / dotenv）。

---

## 二、整体架构

### 2.1 分层

```
┌──────────────────────────────────────────────────────────────────────┐
│  浏览器 (原生 HTML5 + CSS3 + JS)                                      │
│  ├── index.html  上传页：拖拽 / 批量 / 剪贴板粘贴 / 客户端转 WebP      │
│  └── admin.html  管理台：登录 / 列表筛选 / 删除 / 站点与存储配置       │
└───────────────┬──────────────────────────────────────────────────────┘
                │ HTTP / JSON / multipart
┌───────────────▼──────────────────────────────────────────────────────┐
│  接入层 (Express)                                                     │
│  securityHeaders → cors → body parser → authenticate（识别身份不拦截）│
│  → 限流 → 路由 → 静态资源 → 404 → 全局错误处理                        │
└───────────────┬──────────────────────────────────────────────────────┘
                │
┌───────────────▼──────────────────────────────────────────────────────┐
│  路由层 routes/                                                       │
│  api.js（/api 与 /api/v1 双前缀） auth · upload · images · settings   │
│  pages.js（/i 直链 · /t 缩略图 · /d 下载 · /img 详情页 · /api-docs）  │
└───────────────┬──────────────────────────────────────────────────────┘
                │
┌───────────────▼──────────────────────────────────────────────────────┐
│  服务层 services/                                                     │
│  uploader.js  上传编排：处理 → 落盘 → 入库 → 生成多格式引用            │
│  image.js     Sharp 图像处理（静态 / 动态 / 矢量 三条分支）            │
│  settings.js  运行时配置中心（DB 覆盖 .env）+ scrypt 密码             │
│  storage/     存储门面 ——  LocalStorage | WebDAVStorage | 双写      │
└───────────────┬──────────────────────────────────────────────────────┘
                │
┌───────────────▼──────────────────────────────────────────────────────┐
│  数据层 db/  SQLite：images（元数据）· settings（热配置）· tokens（吊销）│
│  物理层 storage/  按 yyyy/mm 分片的原图 + _thumbs 缩略图               │
└──────────────────────────────────────────────────────────────────────┘
```

### 2.2 一次上传的完整链路

```
选择/拖拽/粘贴 ──► 前端校验（扩展名 + 体积）
                      │
                      ├─► [可选] Canvas 转 WebP（客户端，服务端零开销）
                      │
                      ▼
              POST /api/upload（multipart）
                      │
        ┌─────────────┴──────────────────────────────┐
        │ 1. 限流 → 身份识别 → 按身份动态设置单文件上限 │
        │ 2. multer 收流到内存                          │
        │ 3. probe() 真实格式探测（sharp + 魔术字节兜底）│
        │ 4. 白名单校验 + 伪装扩展名识别                 │
        │ 5. 三分支图像处理：                            │
        │      静态位图 → 转向 / 缩放 / 再压缩 / 负优化保护│
        │      动态图   → 原样保留全部帧                  │
        │      SVG      → 保持矢量，仅安全精简            │
        │ 6. sha256 秒传判定                             │
        │ 7. 写主存储（hybrid 模式同时写 WebDAV 副本）    │
        │ 8. 缩略图落本地（WebDAV 场景下列表依然秒开）    │
        │ 9. 写 SQLite 元数据                            │
        │10. 组装直链 / HTML / Markdown / BBCode 响应     │
        └─────────────────────────────────────────────┘
                      ▼
              前端渲染结果卡片（可一键复制任一格式）
```

### 2.3 存储抽象

统一的存储契约，三种模式运行时可切换（写入 SQLite，无需重启）：

```js
put(key, buffer, mime) -> { key, size }   // 写
remove(key)            -> boolean          // 删
exists(key)            -> boolean          // 查
url(key, baseUrl)      -> string           // 对外直链
```

| 模式 | 行为 | 直链来源 |
| --- | --- | --- |
| `local` | 仅本地磁盘 | `<站点>/i/<yyyy/mm/id.ext>` |
| `webdav` | 仅远端网盘 | `WEBDAV_PUBLIC_URL` + `/` + key |
| `hybrid` | 本地 + WebDAV 双写 | 走本地（本地必定可公开访问），WebDAV 作异地备份 |

副本写入失败只告警不阻断上传；主存储失败则整体失败并返回 `STORAGE_WRITE_FAILED`。
缩略图**恒存本地**，因此即便主存储是慢速网盘，管理台列表依然瞬时加载。

---

## 三、目录结构

```
image-hosting/
├── package.json                 依赖与脚本（生产依赖仅 5 个）
├── .env.example                 全部环境变量说明（复制为 .env 即可用）
├── .npmrc                       包管理配置（含国内镜像与 sharp 二进制镜像开关）
├── .dockerignore
├── .gitattributes               行尾统一为 LF（CRLF 会让 CI 里的 shell 脚本报错）
├── Dockerfile                   多阶段构建，非 root 运行，内置健康检查
├── docker-compose.yml           一条命令起服务 + 数据卷 + 日志轮转
├── README.md                    本文件
│
├── .github/workflows/ci.yml     CI：静态校验 → 测试套件 → 多架构镜像构建 → 容器级验证
├── scripts/
│   ├── docker-lint.js           Docker 构建前静态校验（38 项，无需 Docker 守护进程）
│   └── ci-container-check.sh    容器级验证：把镜像跑起来断言架构、用户、健康检查
│
├── src/
│   ├── server.js                入口：初始化管理员密码 → 预热存储 → 监听 → 优雅退出
│   ├── app.js                   Express 装配（中间件顺序即安全边界）
│   │
│   ├── config/index.js          环境变量解析：支持 20mb/512kb 写法、目录自动创建、
│   │                            会话密钥自动生成并持久化到 data/.secret
│   ├── db/index.js              SQLite 建表 + 预编译语句 + 查询封装
│   │
│   ├── middleware/
│   │   ├── auth.js              身份识别（Bearer / Cookie / query）、管理员校验、
│   │   │                        游客上传开关、真实 IP 提取
│   │   ├── upload.js            multer 动态限额（按身份取不同上限）
│   │   ├── rateLimit.js         内存滑动窗口限流（上传/登录/通用三档）
│   │   └── error.js             统一错误体、CORS、安全响应头、async 包装
│   │
│   ├── routes/
│   │   ├── api.js               /api 与 /api/v1 总装配 + /health
│   │   ├── auth.js              登录 / 登出 / 当前身份 / 改密
│   │   ├── upload.js            上传 + 查询当前身份限额
│   │   ├── images.js            列表 / 详情 / 删除 / 批量删除 / 统计
│   │   ├── settings.js          公开配置 / 完整配置 / 热更新 / 存储自检
│   │   └── pages.js             图片直链、缩略图、下载、详情页、管理台、API 文档页
│   │
│   ├── services/
│   │   ├── image.js             Sharp 处理链路（静态/动态/矢量三分支）+ 格式嗅探
│   │   ├── uploader.js          上传编排 + DTO 组装（含四种引用格式）
│   │   ├── settings.js          运行时配置中心 + scrypt 密码哈希 + 存储实例懒加载
│   │   └── storage/
│   │       ├── index.js         存储门面：local / webdav / hybrid
│   │       ├── local.js         本地磁盘驱动（原子写入 + 路径穿越防护）
│   │       └── webdav.js        WebDAV 驱动（fetch 手写 MKCOL/PUT/DELETE/HEAD）
│   │
│   └── utils/
│       ├── index.js             短 ID、日志器、统一响应、ApiError
│       ├── token.js             HMAC-SHA256 签名 Token + 服务端吊销名单
│       └── markdown.js          极简 Markdown 渲染器（用于 /api-docs 页面）
│
├── public/                      前端（原生，无构建）
│   ├── index.html               上传页
│   ├── admin.html               管理台
│   ├── 404.html
│   ├── favicon.svg
│   ├── css/style.css            样式表（自定义属性 + 亮/暗色自适应 + 响应式）
│   └── js/
│       ├── common.js            请求封装、Toast、剪贴板（含 execCommand 回退）
│       ├── home.js              拖拽/批量/粘贴上传、客户端 WebP、多格式复制
│       └── admin.js             登录、统计、列表筛选删除、配置表单、存储自检
│
├── docs/
│   └── API.md                   API 文档唯一源（站点 /api-docs 实时渲染）
│
├── examples/
│   ├── make-test-assets.js      生成 PNG/JPG/WebP/AVIF/动图 GIF/SVG/6K 大图
│   ├── smoke-test.js            端到端接口测试（52 项断言）
│   ├── webdav-test.js           WebDAV 驱动测试（含内嵌模拟 WebDAV 服务端，29 项断言）
│   ├── ui-check.js              前端运行时测试（jsdom 驱动真实上传与登录，61 项断言）
│   ├── curl.sh                  14 个 curl 场景示例
│   ├── upload.py                Python 客户端（仅标准库，零依赖）
│   └── upload.js                Node 客户端（Node 18+，零依赖）
│
├── data/                        SQLite 数据库 + 会话密钥（挂载卷）
└── storage/                     图片与缩略图（挂载卷）
```

---

## 四、关键功能实现思路

### 4.1 存储抽象：一个门面统管本地与 WebDAV

`src/services/storage/index.js` 暴露统一的四个方法，路由层完全不关心文件到底落在哪。
`StorageFacade` 持有驱动数组，第 0 个是主存储：

- 写：主存储失败即抛出 502；副本失败仅记日志（异地备份不该阻断业务）。
- 删：逐个驱动尝试，任一失败都不抛错，避免删不掉导致接口卡死。
- 直链：由主存储决定（本地走 `/i/`，WebDAV 走配置的公开前缀）。

**WebDAV 手写实现要点**（`webdav.js`）：

- `MKCOL` 递归建目录：目录已存在服务端返回 `405`，必须显式放行，否则误判失败；
  父目录未就绪返回 `409`，重试一次；**空路径也要建**，因为不少自建网盘不会自动创建根目录。
- 两套地址严格区分：`remoteUrl()` 是读写地址（含远端目录），`url()` 是直链地址。
  `WEBDAV_PUBLIC_URL` 语义是「已包含远端目录的完整前缀」，因此 `url()` 只拼 key。
  > 这里踩过一个真实的坑：早期版本两者都拼目录，生成了 `.../lumina/lumina/2026/09/x.png`。
  > 现在有一条专门的断言守着它。
- 有一个容易忽视的 JS 陷阱：类上若存在 `url()` 方法，就**不能**再用 `this.url = '...'`
  存配置字符串 —— 实例属性会直接覆盖原型方法。因此根地址存为 `this.davUrl`。

### 4.2 鉴权：单管理员 + 游客上传 + 运行时限额

- **单一管理员**：密码用 `scrypt + 随机盐` 哈希后存 SQLite，仅首次启动从
  `ADMIN_PASSWORD` 初始化；改密后调用 `Tokens.revokeAll()` 踢掉全部旧会话。
- **Token**：结构同 JWT（`base64url(payload).base64url(HMAC-SHA256)`），但多了一层
  **服务端吊销名单**（`tokens` 表存 jti），所以登出/改密能立刻让已签发的 Token 失效 ——
  这是纯无状态 JWT 做不到的。
- **三条取 Token 途径**：`Authorization: Bearer`（推荐）、登录 Cookie
  （`HttpOnly + SameSite=Strict`，天然抵御 CSRF）、`?token=`（仅 GET 兜底）。
- **游客上传限额**：`upload.js` 中间件在**每个请求内**现场构造 multer 实例，
  按 `req.isAdmin` 取 `max_file_size` 或 `guest_max_file_size`。
  这样管理台改完限额立即生效，不必重启进程；错误信息里还会带上当前生效的具体数值。
- **双保险**：除 multer 的流式截断外，请求前先跑 `requireUploadPermission`
  拦下「游客开关已关闭」的情况，避免白传一遍。

### 4.3 图像处理：三条分支，绝不「一刀切」

`src/services/image.js` 按真实探测到的格式分流（用 `sharp.metadata()`，失败时
退化到魔术字节嗅探，防止损坏文件或伪装扩展名被误判）：

| 类型 | 处理 | 设计意图 |
| --- | --- | --- |
| 静态位图 | `rotate()` 按 EXIF 纠正方向 → 超尺寸等比缩小 → 按原格式再压缩 | 顺带把手机照片的朝向问题一并解决 |
| 动态图（`pages > 1`） | **原样保留全部字节** | 再编码会导致掉帧、调色板劣化、循环次数丢失 |
| SVG | 保持矢量，只做安全精简 | 栅格化会毁掉矢量「无限放大不糊」的核心价值 |

两个值得一提的细节：

1. **动图尺寸必须换算**。libvips 对多帧图像返回的 `metadata.height` 是
   「所有帧纵向堆叠后的总高度」，120×120 的三帧 GIF 会读成 `120×360`。
   必须用 `pageHeight` 修正（没有该字段时按帧数整除）。这个问题是在真实测试中
   捕获并修复的，现在有断言覆盖。
2. **负优化保护**。再压缩后如果体积反而变大，就丢弃结果沿用原始字节 ——
   优化不该让用户吃亏。

**SVG 安全精简**不只是去空白：还会剔除 `<script>`、`on*` 事件属性、
`javascript:` 协议和 `xml:base` 之类的外部引用，并在响应侧为 SVG 单独收紧
`Content-Security-Policy`，避免「上传 SVG 打穿同源」的经典问题。

**缩略图**统一输出 WebP：矢量图按 `density` 提高渲染密度再缩小（边缘更干净）、
动图只取第 1 帧作封面（否则后台列表要为每张 GIF 付几十 MB 的代价）。

### 4.4 客户端 WebP 转换

上传页的「客户端转 WebP」用 `createImageBitmap` → `canvas.toBlob('image/webp', quality)`
在浏览器内完成转换，**服务端零算力开销**。三个判断保证不帮倒忙：

1. 只处理 `jpeg / png / bmp` —— **GIF 会被转成静态单帧、SVG 会被栅格化**，
   这两类必须跳过；AVIF 本身就比 WebP 更小，也没有收益。
2. `blob.type !== 'image/webp'` 直接放弃 —— 老版本 Safari 会静默回退成 PNG。
3. 转换后体积没有变小就仍用原文件。
4. 超大图（任一边 > 16384）跳过 —— 避免 canvas 内存爆炸。

### 4.5 多格式链接生成

后端在返回 DTO 时就把八种现成文本拼好了（`formats` 字段），
前端不需要做任何字符串拼接：

`url` · `thumbnail` · `html` · `html_thumb`（缩略图包在链接里，点击看原图）·
`markdown` · `markdown_thumb` · `bbcode` · `bbcode_thumb`

前端只提供 Tab 切换 + 一键复制，另有「复制全部直链 / 复制全部 Markdown / 导出列表」，
批量场景下省掉逐个复制的机械操作。

### 4.6 热配置：改完即生效

配置读取顺序是 **SQLite `settings` 表 > `.env` > 代码默认值**。
管理台改配置走 `PATCH /api/settings`，写完立即失效存储实例缓存，下次请求按新配置重建。
因此「切换存储驱动」「改游客限额」「开关服务端优化」都不需要重启容器。
`PATCH` 有严格的白名单与类型校验，且**空字符串表示不修改**（避免前端没填的
WebDAV 密码把线上密码清空）。

### 4.7 其他值得一提的工程细节

- **秒传**：按 `sha256` 去重，命中则直接复用已有记录并标记 `duplicated: true`；
  删除时若发现同哈希仍有其它记录，则**不删物理文件**，避免误伤。
- **路径穿越防护**：本地驱动的 key 必须匹配 `^\d{4}/\d{2}/[A-Za-z0-9_-]+\.[a-z0-9]+$`，
  越界直接 400。静态资源用 `fs.createReadStream` + 严格正则，而非把目录交给静态中间件。
- **原子写入**：先写 `*.tmp` 再 `rename`，进程被杀不会留下半截文件。
- **统一错误体**：所有失败都是 `{ success: false, error: { code, message, status } }`，
  客户端按稳定不变的 `code` 分支即可，`message` 只用于展示。
- **API 文档单一源**：只维护 `docs/API.md`，`/api-docs` 由服务端用内置的极简
  Markdown 渲染器实时渲染（自带 TOC 高亮与代码块语言角标），不存在文档与实现漂移。

---

## 五、快速开始

### 5.1 本地直接运行

```bash
cd image-hosting
cp .env.example .env        # 按需修改，最小改动也能直接跑
npm install
npm start
```

打开 <http://localhost:3000> 即可上传；管理台 <http://localhost:3000/admin>。

> **默认管理员密码 `admin123`**，仅首次启动时由 `ADMIN_PASSWORD` 初始化。
> 启动日志会高亮提醒，**请在管理台「存储与安全」里立即修改**。

测试无需手动准备图片，`npm test` 自带 `pretest` 钩子会先自动生成测试素材：

```bash
npm start           # 一个终端启动服务
npm test            # 另开一个终端：自动生成素材 + 跑完三套测试（共 142 项断言）
```

`pretest` 会把 PNG/JPG/WebP/AVIF/动图 GIF/SVG/6K 大图写入 `tmp-assets/`，
因此**全新克隆后即可直接跑通**，不必先执行额外步骤。

单独运行某套测试前，请先执行一次 `npm run assets` 补齐素材：
`npm run test:api`（端到端接口）、`npm run test:webdav`（WebDAV 驱动）、
`npm run test:ui`（前端运行时，基于 jsdom）。

### 5.2 Docker 部署

**方式一：直接用 CI 构建好的多架构镜像**（免去本地构建，amd64 / arm64 同名同标签自动匹配）

```bash
docker pull ghcr.io/muxin-403/lumina-image-hosting:latest

docker run -d --name lumina \
  -p 3000:3000 \
  -v "$PWD/data:/app/data" \
  -v "$PWD/storage:/app/storage" \
  -e ADMIN_PASSWORD='换成一个强密码' \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  ghcr.io/muxin-403/lumina-image-hosting:latest
```

镜像同时提供 `linux/amd64` 与 `linux/arm64`，Docker 会按宿主架构自动选择，
在 Intel/AMD 服务器与树莓派、Apple Silicon、ARM 云主机上是同一条命令。
可用 `docker buildx imagetools inspect ghcr.io/muxin-403/lumina-image-hosting:latest`
查看清单里包含的平台。

**方式二：本地构建**

```bash
cp .env.example .env
# 生产环境务必修改：ADMIN_PASSWORD、SESSION_SECRET、PUBLIC_BASE_URL
docker compose up -d --build
docker compose logs -f lumina
```

> 挂载 `data/` 时必须保证容器内用户可写：镜像以 uid 1001 的 `lumina` 运行，
> 绑定挂载的宿主目录需 `chown 1001:1001 data storage`（命名卷则无需处理）。

数据持久化在两个卷：`./data`（SQLite + 会话密钥）、`./storage`（图片与缩略图）。
`SESSION_SECRET` 若未显式配置，会自动生成并写入 `data/.secret` —— 所以
**`data/` 目录丢失会导致全部登录态失效**，备份时不要漏。

### 5.3 环境变量速查

完整清单见 `.env.example`，最常调整的几项：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | 3000 | 监听端口 |
| `PUBLIC_BASE_URL` | 空 | 对外基础地址；反代/域名场景**必须配置**，否则直链会带容器内部 host |
| `TRUST_PROXY` | false | 置于 Nginx / Cloudflare 之后时设为 true，才能拿到真实 IP 与协议 |
| `ADMIN_PASSWORD` | `admin123` | 仅首次启动生效 |
| `MAX_FILE_SIZE` | `20mb` | 管理员单文件上限，支持 `20mb`/`512kb` 写法 |
| `GUEST_MAX_FILE_SIZE` | `5mb` | 游客单文件上限（管理台可热改） |
| `GUEST_UPLOAD_ENABLED` | true | 是否允许游客上传 |
| `ALLOWED_FORMATS` | `jpg,jpeg,png,gif,webp,svg,avif` | 格式白名单 |
| `STORAGE_DRIVER` | `local` | `local` / `webdav` / `hybrid` |
| `WEBDAV_URL` 等 5 项 | 空 | WebDAV 连接参数 |
| `OPTIMIZE` / `OPTIMIZE_QUALITY` | true / 82 | 服务端再压缩开关与质量 |
| `DEDUPE` | true | 相同内容秒传去重 |
| `RATE_LIMIT_*` | 见示例 | 限流阈值，置 0 关闭 |

---

## 六、API

完整文档见 **[`docs/API.md`](docs/API.md)**，服务运行时也可直接访问
<http://localhost:3000/api-docs> 浏览同一份内容的网页版。

| 分类 | 接口 |
| --- | --- |
| 上传 | `POST /api/upload`、`GET /api/upload/limits` |
| 图片 | `GET /api/images` 🔒、`GET /api/images/:id`、`DELETE /api/images/:id` 🔒、`POST /api/images/batch-delete` 🔒、`GET /api/images/stats` 🔒 |
| 鉴权 | `POST /api/auth/login`、`POST /api/auth/logout` 🔒、`GET /api/auth/me` 🔒、`POST /api/auth/password` 🔒 |
| 配置 | `GET /api/config`、`GET/PATCH /api/settings` 🔒、`DELETE /api/settings/:key` 🔒、`GET /api/storage/health` 🔒 |
| 系统 | `GET /api/health` |

🔒 = 需要管理员 Token。`/api` 与 `/api/v1` 完全等价。

最小可用示例：

```bash
# 游客上传
curl -X POST http://localhost:3000/api/upload -F "file=@cat.png"

# 管理员登录并上传
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' -d '{"password":"admin123"}' | jq -r .data.token)
curl -X POST http://localhost:3000/api/upload -H "Authorization: Bearer $TOKEN" -F "file=@cat.png"

# 把游客上传上限改成 8MB（热生效）
curl -X PATCH http://localhost:3000/api/settings -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"guest_max_file_size":8388608}'
```

三种语言的完整客户端示例见 `examples/`：`curl.sh` · `upload.py`（仅标准库）· `upload.js`。

---

## 七、验证情况

本项目在交付前已实际运行，并在**清空 `data/` 与 `storage/` 的全新环境**下
用 `npm test` 一次性跑通全部三套测试，共 **142 项断言，0 失败**
（Windows 11 + Node v22.22.2，服务监听 3200 端口）：

| 测试套件 | 命令 | 断言数 | 结果 |
| --- | --- | --- | --- |
| 端到端接口 | `npm run test:api` | 52 | ✅ 全通过 |
| WebDAV 驱动 | `npm run test:webdav` | 29 | ✅ 全通过 |
| 前端运行时 | `npm run test:ui` | 61 | ✅ 全通过 |

### 7.1 端到端接口测试（52 项）

- 系统与配置：健康检查、公开配置不含敏感字段、限额查询
- 游客上传：PNG / SVG / 动图 GIF 一次上传；直链可 GET、Content-Type 正确、
  带 `immutable` 长缓存头、缩略图为 WebP、详情页含 `og:image`、四种引用格式齐全
- 格式处理：SVG 被识别为矢量且已精简、仍为矢量文本未被栅格化；
  GIF 识别为 3 帧动态图、原样存储、尺寸修正为 120×120
- 权限边界：游客删除 / 列表 / 统计 / 改配置均 401，伪造 Token 401
- 管理员：错误密码 401、正确密码下发 Token、身份查询
- 管理能力：6K 大图被缩放并压缩、分页 / 按来源筛选 / 按格式筛选 / 统计
- **运行时限额**：把游客上限收紧到 1KB → 上传被 413 拒绝且错误码与文案正确 →
  同一文件在管理员身份下仍可上传 → 关闭游客上传后匿名上传 403
- 删除链路：删除后物理文件消失、直链 404、元数据 404、批量删除
- 安全校验：非 multipart 请求 400、路径穿越 404、非法 ID 400

### 7.2 WebDAV 驱动测试（29 项）

内嵌一个最小 WebDAV 服务端（MKCOL / PUT / GET / HEAD / DELETE + Basic 认证，
并刻意区分「需认证的读写路径」与「免认证的只读直链路径」），验证：

- 连接自检真的发起了 MKCOL 建目录并清理了探针文件
- 上传时按年月自动创建 `lumina/2026/09` 三级目录，文件落在配置的远端目录下
- 直链指向配置的公共前缀、**未重复拼接目录**、**无需认证即可公开访问**
- 对照组：同一路径走私有读写入口时未授权访问返回 401
- 远端字节与直链返回**逐字节一致**，且存的是优化后的版本（9.2KB → 2.3KB）
- 缩略图取用**不回源访问 WebDAV**（本地缓存命中）
- 删除时同步向远端发起 DELETE 并确认文件已移除

### 7.3 前端运行时测试（61 项，jsdom）

用 jsdom 真实加载页面并执行脚本，**驱动一次真实上传与一次真实登录**：

- 上传页：脚本零运行时异常、拖拽区/多选/格式限制就绪、配额与格式提示已由
  `/api/config` 渲染；模拟 file input change 后结果卡片渲染出缩略图、5 个格式标签、
  正确的直链，切到 Markdown 标签内容同步刷新，且**该直链可被真实 HEAD 访问（200）**
- **客户端 WebP 转换（核心需求，12 项断言）**：jsdom 本身没有 Canvas 与
  `createImageBitmap`，测试为其注入等价替身，并让 `toBlob` 吐出**真实可解码的 WebP
  字节**，使服务端 Sharp 能正常接收，从而端到端跑通「浏览器内转换 → 上传 → 落盘」：
  - JPEG 经客户端转换后上传，直链后缀为 `.webp`、卡片出现「客户端转 WebP」徽标，
    且服务端返回的 `Content-Type` 确为 `image/webp`（前后端双重确认）
  - GIF 动图 / SVG 矢量 / AVIF 三种格式**被正确跳过**，直链分别保持 `.gif` / `.svg` /
    `.avif`（canvas 会丢动画帧、会把矢量栅格化）
  - 模拟 Safari 老版本 `toBlob` 静默回退成 PNG 时，判定为「未转换」并按原格式上传，
    且**不显示**「客户端转 WebP」徽标——不虚报收益
  - 模拟浏览器完全不支持 `createImageBitmap` 时，勾选该选项会被**自动取消并提示**，
    而不是静默失败
- 管理台：未登录显示登录表单；填入密码提交后切换到控制台、显示 4 张统计卡片
  （数值来自接口）、图片列表渲染出数据行（含缩略图 / 复制 / 删除按钮）、
  分页信息、格式下拉框按统计动态填充、勾选后出现批量操作栏
- 配置表单：站点名 / 游客上限（按 MB 回填）/ 格式串 / 各开关全部正确回填；
  WebDAV 密码**不回显明文**；通过界面提交 5MB → 6MB，
  再查接口确认**服务端确实生效**，之后自动还原

### 7.4 其他检查

- 全部 32 个 JS 文件通过 `node --check` 语法校验
- `scripts/docker-lint.js` 38 项 Docker 构建前静态校验全部通过：
  Dockerfile 的每个 `COPY` 源都真实存在且未被 `.dockerignore` 误排除、
  入口文件真实且在镜像内、`EXPOSE`/`ENV PORT` 与 `src/config/index.js` 默认值一致、
  `HEALTHCHECK` 探测的路由真实存在、compose 挂载点与 `DATA_DIR`/`STORAGE_DIR` 对齐、
  非 root 运行与 tini 信号转发均已启用
- 前端 JS 引用的 55 个 DOM id 与 HTML 中定义的 id 全部对得上
- 上传页 / 管理台 / 静态资源 / favicon / 404 页面均返回 200，
  `/api-docs` 正常渲染出 9 个章节
- `examples/curl.sh` 14 个场景端到端跑通，退出码 0
- `examples/upload.py`（Python 3.13 标准库）与 `examples/upload.js`
  实测上传 / 列表 / 统计 / 改配置均正常
- `.dockerignore` 与 `Dockerfile` 交叉核对：`data/`、`storage/`、`.env`、
  `.github/` 均不会被误打进镜像，`README.md` 与 `docs/*.md` 的 `!` 例外生效

### 7.5 测试过程中发现并修复的真实缺陷

1. **动图高度算成多帧堆叠总和**：`sharp.metadata().height` 对多帧图返回 360
   （3 帧 × 120），导致详情页尺寸错误。改用 `pageHeight` 修正。
2. **直链目录被拼接两次**：`WEBDAV_PUBLIC_URL` 与远端目录同时生效，
   生成 `.../lumina/lumina/2026/09/x.png`。重新定义前者语义为「已含目录的完整前缀」。
3. **实例属性覆盖原型方法**：`WebDAVStorage` 构造函数里的 `this.url = '...'`
   把类上的 `url()` 方法整个覆盖，WebDAV 模式下所有上传因
   `this.primary.url is not a function` 直接 500。根地址改名 `davUrl`。
4. **WebDAV 根目录不被创建**：`ensureDir('')` 提前返回，导致远端目录不存在时
   首次写入失败（自建网盘不会自动建目录）。
5. **游客限额的热更新未被真正验证**：初版测试用的是比限额更小的文件，
   断言形同虚设；改为把限额压到 1KB 后才真正覆盖到这条路径。

### 7.6 持续集成与多架构镜像

`.github/workflows/ci.yml` 把上述验证固化到每次推送。本项目没有编译步骤，
所谓「构建」的实质就是**构建并验证 Docker 镜像**，因此流水线按由快到慢分四级，
前一级失败就不浪费后一级的时间：

| 作业 | 内容 | 触发条件 |
| --- | --- | --- |
| `lint` | 32 个 JS 文件的 `node --check` + `scripts/docker-lint.js` 38 项构建前校验 | 全部 |
| `test` | 冷启动自举 → 三套测试共 142 项断言（Node 22 与 24 双版本矩阵） | 全部 |
| `docker` | 构建多架构镜像并推送 GHCR | 全部（PR 仅构建 amd64 且不推送） |
| `verify` | 校验清单含 amd64 + arm64，并分别把两个架构的容器跑起来 | 非 PR |

**多架构的难点不在构建，而在「构建成功但跑不起来」。** 本项目依赖
`better-sqlite3` 与 `sharp` 两个原生模块：前者在数据库初始化时加载，后者在
`services/image.js` 顶层 `require` —— 任一架构装错都会让进程在启动阶段直接崩溃，
而单平台构建根本发现不了。因此 `verify` 不满足于只看清单，而是用 QEMU
把 `linux/amd64` 与 `linux/arm64` 的容器**真正启动起来**，断言：

- 清单里确实同时存在两个平台
- 容器内 `uname -m` 是目标指令集（`x86_64` / `aarch64`）
- 服务能响应 `/api/health`，即两个原生模块在目标架构上均可加载
- `/`、`/admin`、`/api-docs`、静态资源均返回 200
- 以非 root（uid 1001）运行、`HEALTHCHECK` 探测真实业务接口
- `/app/data` 对运行用户可写、`docker stop` 优雅退出（退出码 0）

镜像地址 `ghcr.io/muxin-403/lumina-image-hosting`，标签规则：
`main` → `:main` / `:latest`；`v1.2.3` 标签 → `:1.2.3` / `:1.2` / `:sha-xxxxxxx`。

---

## 八、部署建议与生产注意事项

1. **必须设置 `PUBLIC_BASE_URL`**。否则反代后面生成的直链会带 `http://` 与容器内部端口。
2. **必须开启 `TRUST_PROXY=true`**（在 Nginx/Caddy/Cloudflare 之后），
   否则限流会按反代 IP 统计、`X-Forwarded-Proto` 拿不到，直链协议可能错成 http。
3. **改掉默认管理员密码**，并显式配置 `SESSION_SECRET`（多实例部署必须一致）。
4. **备份两个目录**：`data/`（数据库 + 会话密钥）与 `storage/`（图片）。
   SQLite 已开 WAL 模式，热备份请用 `sqlite3 data/lumina.db ".backup out.db"`。
5. **反代需放宽请求体**：`client_max_body_size`（Nginx）要大于你的最大上传限制。
6. **限流**：内置限流是单进程内存实现，多副本部署请把限流下沉到网关或 Redis。
7. **WebDAV 私有网盘**：务必配置 `WEBDAV_PUBLIC_URL` 指向可公网直读的地址
   （网盘分享域名或 Alist 中转）。若网盘确实无法公开直读，可让访客走
   `/d/:id` 由服务端代理下载，但注意这会消耗服务器带宽。
8. **HTTPS**：生产环境请务必启用，Cookie 的 `Secure` 属性在
   `NODE_ENV=production` 下会自动开启。

---

## 九、已知限制

- 限流基于单进程内存，多副本部署需改用网关或 Redis 统一限流。
- 未实现图片水印、防盗链 Referer 白名单、多用户体系（需求明确为单管理员）。
- `hybrid` 双写不做事务保证：副本写入失败只记日志，需人工或定时任务对账。
- 管理台列表默认不分页展示全部缩略图，图片量很大时建议配合筛选条件使用。

---

## 十、License

MIT
