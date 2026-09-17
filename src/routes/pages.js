'use strict';

/**
 * 资源路由与页面
 * ------------------------------------------------------------------
 *   GET /i/<yyyy/mm/xxx.ext>   图片直链（本地驱动；WebDAV 驱动自动 302 到对象地址）
 *   GET /t/:id                 缩略图（本地缓存，WebP）
 *   GET /d/:id                 强制下载（WebDAV 场景下由服务端代理，解决私有网盘直链不可访问）
 *   GET /img/:id               图片详情页（带 og:image，便于分享）
 *   GET /admin                 管理台
 *   GET /404 / 静态资源          public/
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { Images } = require('../db');
const { storageManager } = require('../services/settings');
const { baseUrlOf } = require('../services/uploader');
const { EXT_MIME } = require('../services/image');
const { KEY_RE } = require('../services/storage/local');
const { asyncHandler } = require('../middleware/error');
const { ApiError } = require('../utils');

const router = express.Router();

const ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
const IMMUTABLE = 'public, max-age=31536000, immutable';

function sendLocal(res, absPath, mime, opts = {}) {
  if (!fs.existsSync(absPath)) return false;
  res.setHeader('Cache-Control', opts.cache || IMMUTABLE);
  if (opts.download) {
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(opts.download)}`,
    );
  }
  // SVG 为可执行文本资源，单独收紧 CSP，避免直接访问时执行内联脚本
  if (mime === 'image/svg+xml') {
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
  res.type(mime);
  fs.createReadStream(absPath).pipe(res);
  return true;
}

/* ---------------------------- 图片直链 ---------------------------- */

router.get(
  '/i/*',
  asyncHandler(async (req, res, next) => {
    const key = req.params[0] || '';
    if (!KEY_RE.test(key)) return next(); // 非法路径直接交回 404

    const mime = EXT_MIME[path.extname(key).slice(1).toLowerCase()] || 'application/octet-stream';
    const abs = path.join(config.storageDir, key);

    if (sendLocal(res, abs, mime)) return undefined;

    // 本地不存在（例如驱动已切到 WebDAV）：按记录重定向到远端地址
    const row = Images.getByKey(key);
    if (row && row.storage_driver === 'webdav') {
      return res.redirect(302, storageManager.get().url(key, baseUrlOf(req)));
    }
    return next();
  }),
);

/* ---------------------------- 缩略图 ---------------------------- */

router.get(
  '/t/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) throw new ApiError(400, '非法的图片 ID', 'BAD_ID');

    const row = Images.get(id);
    if (!row) throw new ApiError(404, '图片不存在', 'IMAGE_NOT_FOUND');

    if (row.thumb_key) {
      const abs = path.join(config.thumbDir, row.thumb_key);
      if (sendLocal(res, abs, 'image/webp')) return undefined;
    }
    // 缩略图缺失：回落到原图（本地或 WebDAV）
    const key = row.storage_key;
    const localAbs = path.join(config.storageDir, key);
    const mime = EXT_MIME[row.ext] || 'application/octet-stream';
    if (sendLocal(res, localAbs, mime, { cache: 'public, max-age=3600' })) return undefined;
    return res.redirect(302, storageManager.get().url(key, baseUrlOf(req)));
  }),
);

/* ---------------------------- 强制下载 ---------------------------- */

router.get(
  '/d/:id',
  asyncHandler(async (req, res, next) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) return next();

    const row = Images.get(id);
    if (!row) return next();

    const mime = EXT_MIME[row.ext] || 'application/octet-stream';
    const filename = row.original_name || `${row.id}.${row.ext}`;
    const localAbs = path.join(config.storageDir, row.storage_key);
    if (sendLocal(res, localAbs, mime, { cache: 'no-store', download: filename })) return undefined;

    // WebDAV 代理下载（私有网盘场景下直链不可用时的兜底通道）
    const storage = storageManager.get();
    const remote = storage.url(row.storage_key, baseUrlOf(req));
    const upstream = await fetch(remote, {
      headers: storage.primary.authHeader ? { Authorization: storage.primary.authHeader() } : {},
    });
    if (!upstream.ok) throw new ApiError(502, `上游存储返回 ${upstream.status}`, 'UPSTREAM_ERROR');

    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    if (upstream.headers.get('content-length')) {
      res.setHeader('Content-Length', upstream.headers.get('content-length'));
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    return res.end(buf);
  }),
);

/* ---------------------------- 详情页 ---------------------------- */

router.get(
  '/img/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!ID_RE.test(id)) return res.status(404).send('Not Found');

    const row = Images.get(id);
    if (!row) return res.status(404).send('Not Found');

    const base = baseUrlOf(req);
    const storage = storageManager.get();
    const url = storage.url(row.storage_key, base);
    const site = String(require('../services/settings').settings.get('site_name') || 'Lumina 图床');
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

    res.type('html').send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(row.original_name)} · ${esc(site)}</title>
<meta name="description" content="${row.width}×${row.height} · ${Math.round(row.size / 1024)} KB" />
<meta property="og:type" content="website" />
<meta property="og:title" content="${esc(row.original_name)}" />
<meta property="og:image" content="${esc(url)}" />
<meta name="twitter:card" content="summary_large_image" />
<link rel="icon" href="/favicon.svg" />
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100dvh; display:flex; flex-direction:column; align-items:center;
         justify-content:center; gap:20px; padding:28px 16px;
         font: 15px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
         background:#f5f6f8; color:#1f2328; }
  .card { max-width:min(1100px,100%); width:100%; background:#fff; border:1px solid #e5e7eb;
          border-radius:16px; padding:18px; box-shadow:0 8px 28px rgba(16,24,40,.06); }
  img { max-width:100%; max-height:70dvh; display:block; margin:0 auto; border-radius:10px; }
  .meta { display:flex; flex-wrap:wrap; gap:8px; margin-top:14px; }
  .tag { font-size:12.5px; padding:3px 9px; border-radius:999px; background:#f1f3f5; color:#57606a; }
  .row { display:flex; gap:8px; margin-top:12px; }
  input { flex:1; min-width:0; padding:10px 12px; border:1px solid #d0d7de; border-radius:9px;
          font:inherit; background:#fff; color:inherit; }
  button, a.btn { padding:10px 14px; border-radius:9px; border:1px solid #d0d7de; background:#fff;
          color:inherit; font:inherit; cursor:pointer; text-decoration:none; }
  button.primary { background:#2f6feb; border-color:#2f6feb; color:#fff; }
  @media (prefers-color-scheme: dark) {
    body { background:#0d1117; color:#e6edf3; }
    .card { background:#161b22; border-color:#30363d; }
    .tag { background:#21262d; color:#8b949e; }
    input, button, a.btn { background:#21262d; border-color:#30363d; color:#e6edf3; }
  }
</style>
</head>
<body>
  <div class="card">
    <img src="${esc(url)}" alt="${esc(row.original_name)}" />
    <div class="meta">
      <span class="tag">${esc(row.original_name)}</span>
      <span class="tag">${row.width}×${row.height}</span>
      <span class="tag">${(row.size / 1024).toFixed(1)} KB</span>
      <span class="tag">${esc(row.ext.toUpperCase())}${row.animated ? ' · 动态' : ''}${row.vector ? ' · 矢量' : ''}</span>
      <span class="tag">存储：${esc(row.storage_driver)}</span>
    </div>
    <div class="row">
      <input id="link" readonly value="${esc(url)}" />
      <button class="primary" onclick="navigator.clipboard.writeText(document.getElementById('link').value)">复制直链</button>
      <a class="btn" href="/d/${esc(row.id)}">下载</a>
    </div>
  </div>
</body>
</html>`);
  }),
);

/* ---------------------------- 管理台入口 ---------------------------- */

router.get('/admin', (_req, res) => res.sendFile(path.join(config.publicDir, 'admin.html')));
router.get('/admin/', (_req, res) => res.sendFile(path.join(config.publicDir, 'admin.html')));

/* ---------------------------- API 文档页 ---------------------------- */

/**
 * 把 docs/API.md 就地渲染成可浏览的 HTML。
 * 好处：文档只有一份 Markdown 源，避免 HTML 与 MD 两份内容长期漂移。
 */
router.get(
  '/api-docs',
  asyncHandler(async (req, res) => {
    const mdPath = path.join(config.rootDir, 'docs', 'API.md');
    let md;
    try {
      md = fs.readFileSync(mdPath, 'utf8');
    } catch (_) {
      return res.status(404).type('text/plain').send('docs/API.md 不存在');
    }

    const { render } = require('../utils/markdown');
    const { html, toc } = render(md);
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

    return res.type('html').send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>API 文档 · Lumina 图床</title>
<link rel="icon" href="/favicon.svg" />
<link rel="stylesheet" href="/css/style.css" />
<style>
  .doc-layout { display:grid; grid-template-columns: 232px 1fr; gap:34px; align-items:start; }
  .doc-toc { position:sticky; top:82px; max-height:calc(100dvh - 110px); overflow:auto;
             font-size:13.5px; padding:16px 18px; }
  .doc-toc a { display:block; padding:4px 0; color:var(--text-soft); }
  .doc-toc a:hover { color:var(--brand); }
  .doc-toc h4 { font-size:12px; text-transform:uppercase; letter-spacing:.06em;
                color:var(--text-muted); margin:0 0 8px; }
  .doc h1 { font-size:28px; margin:0 0 20px; }
  .doc h2 { font-size:21px; margin:36px 0 14px; padding-top:14px; border-top:1px solid var(--border); }
  .doc h3 { font-size:16.5px; margin:24px 0 10px; }
  .doc h4 { font-size:15px; margin:18px 0 8px; }
  .doc .anchor { opacity:0; margin-left:8px; font-size:.8em; }
  .doc h2:hover .anchor, .doc h3:hover .anchor { opacity:.5; }
  .doc p, .doc li { color:var(--text-soft); }
  .doc strong { color:var(--text); }
  .doc code { font-family:var(--mono); font-size:12.5px; background:var(--bg-soft);
              padding:2px 6px; border-radius:5px; color:var(--text); }
  .doc pre.code { position:relative; background:var(--surface-2); border:1px solid var(--border);
                  border-radius:var(--radius); padding:14px 16px; overflow:auto; margin:12px 0; }
  .doc pre.code code { background:none; padding:0; font-size:12.5px; line-height:1.65;
                       white-space:pre; color:var(--text); }
  .doc pre.code::before { content:attr(data-lang); position:absolute; top:8px; right:12px;
                          font-size:10.5px; text-transform:uppercase; letter-spacing:.06em;
                          color:var(--text-muted); }
  .doc blockquote { margin:12px 0; padding:10px 16px; border-left:3px solid var(--brand);
                    background:var(--brand-soft); border-radius:0 var(--radius-sm) var(--radius-sm) 0; }
  .doc blockquote p { margin:0; color:var(--text); }
  .doc ul, .doc ol { padding-left:22px; }
  .doc table { font-size:13.5px; }
  .doc .table-wrap { border:1px solid var(--border); border-radius:var(--radius); margin:14px 0; }
  .doc thead th { position:static; }
  .doc hr { border:0; border-top:1px solid var(--border); margin:28px 0; }
  @media (max-width:820px) { .doc-layout { grid-template-columns:1fr; } .doc-toc { display:none; } }
</style>
</head>
<body>
  <header class="topbar">
    <a class="brand" href="/">
      <svg class="logo" viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <rect x="2" y="2" width="28" height="28" rx="8" fill="#2f6feb" />
        <circle cx="16" cy="15" r="6.5" stroke="#fff" stroke-width="2" />
        <path d="M11 24l3.4-4.2 2.4 2.6 2.6-3.2L23 24" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span>Lumina 图床</span><small>API 文档</small>
    </a>
    <nav class="topnav">
      <a href="/">上传</a><a href="/admin">管理台</a>
      <a href="/api-docs" class="active">API 文档</a>
    </nav>
  </header>
  <main class="wrap wide doc-layout">
    <aside class="card doc-toc">
      <h4>目录</h4>
      ${toc.map((t) => `<a href="#${t.id}">${esc(t.text)}</a>`).join('')}
    </aside>
    <article class="doc card section">${html}</article>
  </main>
  <footer class="foot">Lumina 图床 · 文档源：<code>docs/API.md</code></footer>
</body>
</html>`);
  }),
);

module.exports = router;
