'use strict';

/**
 * WebDAV 存储驱动端到端测试
 * ------------------------------------------------------------------
 * 在进程内起一个「最小可用的 WebDAV 服务端」（MKCOL / PUT / GET / HEAD / DELETE +
 * Basic 认证），然后把图床的存储驱动切到 webdav，验证：
 *   1. 连接自检（探针写入 + 删除）
 *   2. 上传时确实发起 MKCOL 建目录与 PUT 写文件
 *   3. 生成的直链指向本站代理路由（/i/<key>），绝不含 WebDAV 真实地址；
 *      访问直链时由后端通过 WebDAV 协议认证回源并代理转发
 *   4. 缩略图仍由图床本地服务（WebDAV 场景下列表依然秒开）
 *   5. 删除时向 WebDAV 发起 DELETE
 *   6. 最后把驱动恢复为 local
 *
 * 用法：BASE=http://localhost:3000 ADMIN_PASSWORD=admin123 node examples/webdav-test.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:3000';
const PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DAV_PORT = Number(process.env.DAV_PORT || 3210);
const DAV_USER = 'demo';
const DAV_PASS = 'secret';
const ASSET_DIR = path.join(__dirname, '..', 'tmp-assets');

let token = null;
let passed = 0;
let failed = 0;
const failures = [];

function ok(name, detail = '') {
  passed += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? `  \x1b[90m${detail}\x1b[0m` : ''}`);
}
function fail(name, detail = '') {
  failed += 1;
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  \x1b[31m${detail}\x1b[0m` : ''}`);
}
function assert(cond, name, detail = '') {
  (cond ? ok : fail)(name, detail);
  return cond;
}
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`);

/* ======================= 最小 WebDAV 服务端 ======================= */

/**
 * 内存文件系统：key -> Buffer；另有操作日志用于断言
 *
 * 刻意模拟真实网盘的两条路径：
 *   /dav/...    需要 Basic 认证（读写入口，仅图床后端使用）
 *   /public/... 只读、免认证（模拟某些网盘的可选公开入口，本测试不依赖它）
 * 图床的对外直链不指向这里任何一条，而是指向本站 /i/<key> 代理路由。
 */
function createMockWebDAV() {
  const files = new Map();
  const log = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${DAV_PORT}`);
    const rawPath = decodeURIComponent(url.pathname);
    const isPublic = rawPath.startsWith('/public/');
    const key = rawPath.replace(/^\/(dav|public)\/?/, '').replace(/\/$/, '');

    const auth = req.headers.authorization || '';
    const expected = `Basic ${Buffer.from(`${DAV_USER}:${DAV_PASS}`).toString('base64')}`;

    // 公开路径只放行只读方法；私有路径一律要求认证
    if (isPublic) {
      if (!['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(405);
        return res.end('Method Not Allowed on public path');
      }
    } else if (auth !== expected) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="mock-dav"' });
      return res.end('Unauthorized');
    }

    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      log.push({ method: req.method, key, isPublic });

      switch (req.method) {
        case 'MKCOL': {
          // 目录已存在时按 RFC 4918 返回 405
          if (files.has(`dir:${key}`)) {
            res.writeHead(405);
            return res.end();
          }
          // 父目录不存在返回 409
          const parent = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '';
          if (parent && !files.has(`dir:${parent}`)) {
            res.writeHead(409);
            return res.end();
          }
          files.set(`dir:${key}`, Buffer.alloc(0));
          res.writeHead(201);
          return res.end();
        }
        case 'PUT': {
          if (!key) {
            res.writeHead(409);
            return res.end();
          }
          files.set(key, body);
          res.writeHead(201);
          return res.end();
        }
        case 'GET': {
          const data = files.get(key);
          if (!data) {
            res.writeHead(404);
            return res.end('Not Found');
          }
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': String(data.length),
          });
          return res.end(data);
        }
        case 'HEAD': {
          const data = files.get(key);
          if (data === undefined) {
            res.writeHead(404);
            return res.end();
          }
          res.writeHead(200, { 'Content-Length': String(data.length) });
          return res.end();
        }
        case 'DELETE': {
          if (!files.has(key)) {
            res.writeHead(404);
            return res.end();
          }
          files.delete(key);
          res.writeHead(204);
          return res.end();
        }
        default:
          res.writeHead(405);
          return res.end();
      }
    });
  });

  return { server, files, log };
}

/* ============================== Lumina API ============================== */

async function api(pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token && options.auth !== false) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${pathname}`, { ...options, headers });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
}

async function patchSettings(patch) {
  return api('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

/* ================================= 主流程 ================================= */

async function main() {
  console.log(`\n\x1b[1mLumina 图床 · WebDAV 存储驱动测试\x1b[0m\n图床: ${BASE}`);

  if (!fs.existsSync(path.join(ASSET_DIR, 'sample.png'))) {
    console.error(`\n\x1b[31m缺少测试素材，请先执行：node examples/make-test-assets.js\x1b[0m\n`);
    process.exit(1);
  }

  // ---------- 启动模拟 WebDAV ----------
  const dav = createMockWebDAV();
  await new Promise((resolve) => dav.server.listen(DAV_PORT, '127.0.0.1', resolve));
  console.log(`模拟 WebDAV 服务端已启动于 http://127.0.0.1:${DAV_PORT}/dav`);

  let uploadedId = null;
  let uploadedUrl = null;

  try {
    section('1. 管理员登录');
    const login = await api('/api/auth/login', {
      method: 'POST',
      auth: false,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: PASSWORD }),
    });
    if (!assert(login.status === 200, '管理员登录成功')) return;
    token = login.body.data.token;

    section('2. 切换到 WebDAV 驱动');

    const switchRes = await patchSettings({
      storage_driver: 'webdav',
      // 关闭秒传，确保每次上传都真的走一遍 MKCOL + PUT
      dedupe: false,
      webdav_url: `http://127.0.0.1:${DAV_PORT}/dav`,
      webdav_username: DAV_USER,
      webdav_password: DAV_PASS,
      webdav_directory: 'lumina',
    });
    assert(switchRes.status === 200, 'PATCH /api/settings 切换到 WebDAV 驱动',
      `字段 ${switchRes.body.data.updated.join(', ')}`);

    const cfg = await api('/api/config', { auth: false });
    assert(cfg.body.data.storage_driver === 'webdav', '公开配置已反映新驱动',
      cfg.body.data.storage_driver);
    assert(cfg.body.data.webdav_configured === true, '公开配置标记 WebDAV 已配置');

    section('3. 存储连通性自检');

    const health = await api('/api/storage/health');
    assert(health.status === 200 && health.body.data.mode === 'webdav', '健康检查识别当前模式为 webdav');
    assert(health.body.data.ok === true, 'WebDAV 探针读写成功',
      health.body.data.drivers[0].message);
    assert(dav.log.some((l) => l.method === 'MKCOL'), '自检过程中发起了 MKCOL 建目录');
    assert(dav.log.some((l) => l.method === 'DELETE'), '自检探针文件已被清理');

    section('4. 通过 WebDAV 上传');

    dav.log.length = 0;
    const buf = fs.readFileSync(path.join(ASSET_DIR, 'sample.png'));
    const form = new FormData();
    form.append('file', new Blob([buf]), 'webdav-sample.png');

    const upRes = await fetch(`${BASE}/api/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const up = await upRes.json();
    const item = Array.isArray(up.data) ? up.data[0] : up.data;

    assert(upRes.status === 200, '上传成功', `HTTP ${upRes.status}`);
    assert(item && item.storage_driver === 'webdav', '记录中存储驱动为 webdav',
      item && item.storage_driver);
    assert(item && item.url.startsWith(`${BASE}/i/`),
      '直链指向本站代理路由 /i/<key>', item && item.url);
    assert(item && !item.url.includes(`${DAV_PORT}`) && !/\/dav\//.test(item.url),
      '直链不含 WebDAV 真实地址（主机与 /dav/ 路径均未暴露）', item && item.url);

    // 上传过程的 WebDAV 操作记录（PUT / MKCOL），断言后清空以便统计代理回源请求
    const puts = dav.log.filter((l) => l.method === 'PUT');
    assert(puts.length >= 1, 'WebDAV 收到 PUT 请求', puts.map((p) => p.key).join(', '));
    assert(puts.some((p) => p.key.startsWith('lumina/20')), '文件落在配置的远端目录下');

    const mkcols = dav.log.filter((l) => l.method === 'MKCOL');
    assert(mkcols.length >= 1, '按年月自动创建远端目录', mkcols.map((m) => m.key).join(', '));
    const remoteKey = puts[0].key;

    // 访问直链：应由后端代理回源 WebDAV 并转发内容
    dav.log.length = 0;
    const publicFetch = await fetch(item.url);
    assert(publicFetch.status === 200, '直链无需任何认证即可公开访问（访客可读）',
      `HTTP ${publicFetch.status}`);
    assert(dav.log.some((l) => l.method === 'GET'),
      '后端已通过 WebDAV 协议（认证 GET）回源取文件');
    assert(publicFetch.headers.get('content-type') === 'image/png',
      '代理转发返回了正确的 Content-Type', publicFetch.headers.get('content-type'));

    // 直接访问 WebDAV 私有入口：无认证必须被拒绝（真实地址确实未公开）
    const davBase = `http://127.0.0.1:${DAV_PORT}/dav`;
    const davGetBefore = dav.log.length;
    const privateFetch = await fetch(`${davBase}/lumina/should-not-exist.png`);
    assert(privateFetch.status === 401, '对比：WebDAV 私有路径未授权访问被拒绝',
      `HTTP ${privateFetch.status}`);
    assert(dav.log.length === davGetBefore, '未授权探测不会由图床代理放行');

    uploadedId = item.id;
    uploadedUrl = item.url;

    section('5. 远端内容一致性');

    const stored = dav.files.get(remoteKey);
    assert(!!stored, '远端确实存在该文件', remoteKey);

    if (stored) {
      // 服务端可能做过优化，因此比对「优化后的字节」而非原始字节
      const localBytes = Buffer.from(await (await fetch(item.url)).arrayBuffer());
      assert(stored.length === localBytes.length, '远端字节数与直链返回一致',
        `${stored.length} B`);
      assert(stored.equals(localBytes), '远端字节内容与直链返回完全一致');
      assert(localBytes.length <= buf.length, 'WebDAV 上存的是服务端优化后的版本',
        `${(buf.length / 1024).toFixed(1)}KB → ${(localBytes.length / 1024).toFixed(1)}KB`);
    }

    section('6. 缩略图仍由图床本地提供（不依赖 WebDAV）');

    const thumb = await fetch(item.thumb_url);
    assert(thumb.status === 200 && thumb.headers.get('content-type') === 'image/webp',
      '缩略图正常返回 WebP', `HTTP ${thumb.status}`);

    const before = dav.log.filter((l) => l.method === 'GET').length;
    await fetch(item.thumb_url);
    const after = dav.log.filter((l) => l.method === 'GET').length;
    assert(before === after, '取缩略图不会回源访问 WebDAV（本地缓存命中）');

    section('7. 元数据与管理接口');

    const meta = await api(`/api/images/${item.id}`, { auth: false });
    assert(meta.status === 200 && meta.body.data.storage_driver === 'webdav',
      '公开元数据接口返回 WebDAV 直链');

    const list = await api('/api/images?limit=5');
    assert(list.status === 200 && list.body.data.some((i) => i.id === item.id),
      '管理列表可以查询到 WebDAV 存储的图片');

    section('8. 删除时同步清理远端');

    dav.log.length = 0;
    const del = await api(`/api/images/${item.id}`, { method: 'DELETE' });
    assert(del.status === 200, '删除接口返回成功');

    const deletes = dav.log.filter((l) => l.method === 'DELETE');
    assert(deletes.length >= 1, 'WebDAV 收到 DELETE 请求', deletes.map((d) => d.key).join(', '));
    assert(!dav.files.has(remoteKey) || dav.files.get(remoteKey) === undefined,
      '远端文件已被移除', remoteKey);
  } finally {
    section('9. 恢复配置');

    if (token) {
      const restore = await patchSettings({ storage_driver: 'local', dedupe: true });
      assert(restore.status === 200 && restore.body.data.config.storage_driver === 'local',
        '存储驱动已恢复为 local，秒传已恢复');
      // 清理可能残留的测试数据
      if (uploadedId && uploadedUrl) await api(`/api/images/${uploadedId}`, { method: 'DELETE' });
    }
    dav.server.close();
  }

  console.log(`\n\x1b[1m测试结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m 项，失败 \x1b[31m${failed}\x1b[0m 项\n`);
  if (failed) {
    console.log('失败明细：');
    failures.forEach((f) => console.log(`  - ${f}`));
    console.log('');
    process.exit(1);
  }
  console.log('\x1b[32m全部通过 ✔\x1b[0m\n');
}

main().catch((err) => {
  console.error('\n\x1b[31m测试异常终止：\x1b[0m', err);
  process.exit(1);
});
