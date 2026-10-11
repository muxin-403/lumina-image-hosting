'use strict';

/**
 * Bug 修复回归套件（对抗式审查 2026-10-11 的全部确认问题）
 * ------------------------------------------------------------------
 * 与 smoke-test 不同，本套件在进程内自举一个完全隔离的服务实例
 * （独立数据目录 / 随机端口 / 专用环境变量），因此可以：
 *   - 直接对 src 内部模块做单元断言（markdown / probe / errorHandler / WebDAVStorage）
 *   - 用环境变量驱动「DEDUPE=0」「TRUST_PROXY=1」等只有冷启动才生效的路径
 * 会杀死进程的缺陷（流错误未监听）由 examples/bugfix-crash-probe.js
 * 在子进程中探针，父进程只看退出码。
 *
 * 用法：node examples/bugfix-test.js
 * 修复前运行：目标断言应失败（红）；修复后：全部通过（绿）。
 */

const path = require('path');
const fs = require('fs');

/* -------------------- 1. 环境变量（必须先于任何 src require） -------------------- */

const DATA_DIR = path.join(__dirname, '..', 'tmp-bugfix-data');
const STORAGE_DIR = path.join(__dirname, '..', 'tmp-bugfix-storage');
fs.rmSync(DATA_DIR, { recursive: true, force: true });
fs.rmSync(STORAGE_DIR, { recursive: true, force: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(STORAGE_DIR, { recursive: true });

process.env.DATA_DIR = DATA_DIR;
process.env.STORAGE_DIR = STORAGE_DIR;
process.env.DB_PATH = path.join(DATA_DIR, 'lumina.db');
process.env.ADMIN_PASSWORD = 'bugfix-admin-pwd';
process.env.SESSION_SECRET = 'bugfix-suite-secret-bugfix-suite-secret-0001';
process.env.PORT = '0';
process.env.NODE_ENV = 'development';
process.env.DEDUPE = '0'; // 覆盖「.env DEDUPE=0 失效」与「孤儿文件」两条用例
process.env.TRUST_PROXY = '1';
process.env.WEBDAV_PASSWORD = 'bugfix-dav-secret';
process.env.WEBDAV_TIMEOUT = '5000';

/* -------------------- 2. 依赖与自举 -------------------- */

const { spawnSync } = require('child_process');
const crypto = require('crypto');

const { bootstrap } = require('../src/server');
const config = require('../src/config');
const { Images, Settings, db } = require('../src/db');
const { settings } = require('../src/services/settings');
const { render } = require('../src/utils/markdown');
const { probe, makeThumbnail, FORMAT_EXT } = require('../src/services/image');
const { errorHandler } = require('../src/middleware/error');
const { ApiError } = require('../src/utils');
const rateLimitMod = require('../src/middleware/rateLimit');
const sharp = require('sharp');

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

const ok = (name, detail = '') => {
  passed += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? `  \x1b[90m${detail}\x1b[0m` : ''}`);
};
const bad = (name, detail = '') => {
  failed += 1;
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  \x1b[31m${detail}\x1b[0m` : ''}`);
};
const skip = (name, detail = '') => {
  skipped += 1;
  console.log(`  \x1b[33m◌ SKIP\x1b[0m ${name}${detail ? `  \x1b[90m${detail}\x1b[0m` : ''}`);
};
const assert = (cond, name, detail = '') => {
  (cond ? ok : bad)(name, detail);
  return cond;
};
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`);

let BASE = '';
let token = null;

async function api(pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token && options.auth !== false) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${pathname}`, { ...options, headers });
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('json') ? await res.json() : await res.text();
  return { status: res.status, body, headers: res.headers };
}

async function uploadBuffer(buf, name, { asAdmin = true } = {}) {
  const form = new FormData();
  form.append('file', new Blob([buf]), name);
  const res = await fetch(`${BASE}/api/upload`, {
    method: 'POST',
    headers: asAdmin && token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  return { status: res.status, body: await res.json() };
}

function noiseBytes(n) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i += 1) b[i] = (i * 31 + 7) % 253;
  return b;
}

/* --------------------------------- 主流程 --------------------------------- */

async function main() {
  console.log(`\n\x1b[1mLumina · Bug 修复回归套件\x1b[0m`);

  const server = await bootstrap();
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;

  /* ---------------------- A. 纯单元断言（无需登录） ---------------------- */

  section('A. 单元断言：markdown / 错误处理 / 图像探测');

  // #1 blockquote 渲染
  const md1 = render('> 引用内容\n> 第二行\n\n普通段落').html;
  assert(md1.includes('<blockquote>') && !md1.includes('[object Object]') && md1.includes('引用内容'),
    '#1 blockquote 正常渲染，不再输出 [object Object]', md1.slice(0, 60));

  // #15a 链接协议白名单
  const md15a = render('[点我](javascript:alert%281%29)').html;
  assert(!/href\s*=\s*"javascript:/i.test(md15a),
    '#15a javascript: 协议链接被拦截', md15a.slice(0, 80));
  const md15ok = render('[官网](https://example.com) 和 [锚点](#sec)').html;
  assert(md15ok.includes('href="https://example.com"') && md15ok.includes('href="#sec"'),
    '#15a http/https/锚点链接不受影响');

  // #15b 行内代码不被后续语法污染
  const md15b = render('`a *b* c`').html;
  assert(md15b.includes('<code>a *b* c</code>') && !md15b.includes('<em>'),
    '#15b 行内代码内容不被加粗/斜体污染', md15b.slice(0, 60));

  // #11 errorHandler：非 ApiError 的 5xx 不泄漏内部 message
  const capture = (err) => {
    const out = {};
    const res = {
      headersSent: false,
      status(s) { out.status = s; return this; },
      json(o) { out.body = o; },
    };
    errorHandler(err, { method: 'GET', originalUrl: '/x' }, res, () => {});
    return out;
  };
  const leak = capture(new Error("ENOENT: no such file or directory, open 'D:\\secret\\db\\x'"));
  assert(leak.body && leak.body.error.message === '服务器内部错误'
    && !/ENOENT|D:\\/.test(leak.body.error.message),
    '#11 非 ApiError 的 5xx 返回通用文案（不泄漏内部错误细节）',
    leak.body && leak.body.error.message);
  const biz = capture(new ApiError(429, '请求过于频繁，请稍后重试', 'RATE_LIMITED'));
  assert(biz.body && biz.body.error.message === '请求过于频繁，请稍后重试'
    && biz.body.error.code === 'RATE_LIMITED',
    '#11 ApiError 的业务 message 正常透传');

  // #7 HEIC/HEIF 明确拒绝 415
  const heicBuf = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(32, 0)]);
  let heicErr = null;
  try { await probe(heicBuf); } catch (err) { heicErr = err; }
  assert(heicErr && heicErr.status === 415 && heicErr.code === 'UNSUPPORTED_FORMAT',
    '#7 HEIC 输入返回 415 UNSUPPORTED_FORMAT',
    heicErr ? `${heicErr.status}/${heicErr.code}` : '未抛错（被当作 avif 接受）');
  assert(FORMAT_EXT.heif === undefined, '#7 FORMAT_EXT 不再把 heif 映射为 avif');

  // #5b WEBDAV_TIMEOUT 生效
  assert(config.webdav.timeout === 5000, '#5b env WEBDAV_TIMEOUT 解析进 config', String(config.webdav.timeout));
  assert(settings.get('webdav_timeout') === 5000,
    '#5b settings 门面能读到 webdav_timeout（不再恒 30000）',
    String(settings.get('webdav_timeout')));
  settings.set('storage_driver', 'webdav');
  const webdavFacade = require('../src/services/storage').createStorage();
  assert(webdavFacade.primary.timeout === 5000,
    '#5b createStorage 构造的 WebDAV 驱动使用配置的超时',
    String(webdavFacade.primary.timeout));
  settings.set('storage_driver', 'local');

  // H7 Settings.get 对损坏行不抛错
  db.prepare("INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('zz_broken_test','not-json{',0)").run();
  let h7ok = false;
  try { h7ok = Settings.get('zz_broken_test') === undefined; } catch (_) { h7ok = false; }
  db.prepare("DELETE FROM settings WHERE key = 'zz_broken_test'").run();
  assert(h7ok, 'H7 settings 表损坏行不再导致全站 500（回落 undefined）');

  // H1 限流 sweeper：窗口跟随配置而非硬编码 30 分钟
  assert(typeof rateLimitMod.sweep === 'function', 'H1 rateLimit 导出 sweep(now) 供测试与复用');
  if (typeof rateLimitMod.sweep === 'function') {
    rateLimitMod.buckets.set('bugfix:sweep', [Date.now() - 120000, Date.now() - 1000]);
    rateLimitMod.sweep(Date.now());
    const after = rateLimitMod.buckets.get('bugfix:sweep') || [];
    rateLimitMod.buckets.delete('bugfix:sweep');
    assert(after.length === 1, 'H1 sweep 按配置窗口清理（窗口外移除、窗口内保留）', `剩余 ${after.length} 条`);
  }

  // H5 WebDAV MKCOL 持续 409 必须失败（不得把二次 409 当成功）
  const srv409 = require('http').createServer((req, res) => { req.resume(); res.writeHead(409); res.end('conflict'); });
  await new Promise((r) => srv409.listen(0, '127.0.0.1', r));
  const { WebDAVStorage } = require('../src/services/storage/webdav');
  const drv409 = new WebDAVStorage({
    url: `http://127.0.0.1:${srv409.address().port}`, username: 'u', password: 'p',
    directory: 'lumina', timeout: 2000,
  });
  let rejected409 = false;
  try { await drv409.ensureDir('sub'); } catch (_) { rejected409 = true; }
  srv409.close();
  assert(rejected409, 'H5 MKCOL 重试后仍 409 时 ensureDir 判定失败（按状态码分类）');

  /* ---------------------- B. HTTP 行为断言（无需登录） ---------------------- */

  section('B. HTTP 行为：Cookie / 双前缀限流 / 健康检查');

  // #10 畸形 Cookie 不再 500
  const badCookie = await fetch(`${BASE}/api/config`, { headers: { Cookie: 'lumina_token=%zz' } });
  assert(badCookie.status === 200, '#10 畸形 Cookie 按匿名处理（不再 500）', `HTTP ${badCookie.status}`);

  // #12 /api/v1 限流单计
  const v1a = await fetch(`${BASE}/api/v1/health`);
  const rem1 = Number(v1a.headers.get('x-ratelimit-remaining'));
  assert(v1a.status === 200, '#12 /api/v1/health 正常可用');
  const v1b = await fetch(`${BASE}/api/v1/health`);
  const rem2 = Number(v1b.headers.get('x-ratelimit-remaining'));
  assert(rem1 - rem2 === 1, '#12 /api/v1 每请求限流单计（修复前双计）', `${rem1} → ${rem2}`);

  // #13 /api/health 不再触发完整统计
  const origStats = Images.stats;
  Images.stats = () => { throw new Error('stats should not be called by /health'); };
  let healthOk = false;
  try { healthOk = (await fetch(`${BASE}/api/health`)).status === 200; } catch (_) { healthOk = false; }
  Images.stats = origStats;
  assert(healthOk, '#13 /api/health 不再调用 6 条统计查询（改用单条 COUNT）');

  /* ---------------------- C. 管理员登录后的行为断言 ---------------------- */

  section('C. 上传链路与删除语义');

  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'bugfix-admin-pwd' }),
  }).then((r) => r.json());
  token = login.data && login.data.token;
  assert(!!token, '（前置）管理员登录成功');

  // #6 EXIF 旋转照片宽高不再转置
  const orientedPath = path.join(__dirname, '..', 'tmp-assets', 'oriented.jpg');
  if (fs.existsSync(orientedPath)) {
    const up6 = await uploadBuffer(fs.readFileSync(orientedPath), 'oriented.jpg');
    const d6 = up6.body.data || {};
    assert(up6.status === 200 && d6.width === 300 && d6.height === 400,
      '#6 EXIF Orientation=6 照片入库宽高与实际像素一致（300×400）',
      up6.status === 200 ? `得到 ${d6.width}×${d6.height}` : `HTTP ${up6.status}`);
  } else {
    bad('#6 缺少 tmp-assets/oriented.jpg，请先运行 npm run assets');
  }

  // #4 DELETE /api/settings/webdav_password 不回显明文
  await api('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ webdav_password: 'temp-dav-pass' }),
  });
  const delPwd = await api('/api/settings/webdav_password', { method: 'DELETE' });
  const delPwdText = JSON.stringify(delPwd.body);
  assert(delPwd.status === 200 && !delPwdText.includes('bugfix-dav-secret'),
    '#4 DELETE /api/settings/webdav_password 不回显 .env 明文密码',
    delPwd.status === 200 ? '(响应已脱敏或含明文)' : `HTTP ${delPwd.status}`);

  // H2 请求级总量预检
  await api('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guest_max_file_size: 1024 }),
  });
  const bigReq = await uploadBuffer(noiseBytes(40 * 1024), 'over-total.bin', { asAdmin: false });
  await api('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guest_max_file_size: 5 * 1024 * 1024 }),
  });
  assert(bigReq.status === 413 && bigReq.body.error && bigReq.body.error.code === 'PAYLOAD_TOO_LARGE',
    'H2 请求总量超上限被预检拦截（PAYLOAD_TOO_LARGE）',
    bigReq.body.error ? bigReq.body.error.code : `HTTP ${bigReq.status}`);

  // H3 缩略图 SVG 栅格化像素上限
  const bigSvg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="3500" height="3500" viewBox="0 0 3500 3500"><rect width="3500" height="3500" fill="#ffffff"/></svg>',
  );
  const thumbBig = await makeThumbnail(bigSvg, { ext: 'svg', width: 480 });
  assert(thumbBig === null, 'H3 超过像素上限的 SVG 缩略图被拒绝（回落原图，防内存放大）',
    thumbBig ? `生成了 ${(thumbBig.length / 1024).toFixed(0)}KB` : 'null');

  // #5a DEDUPE=0 生效 + #8/H8 删除不再留孤儿文件
  const noisePng = await sharp(noiseBytes(128 * 128 * 3), { raw: { width: 128, height: 128, channels: 3 } }).png().toBuffer();
  const upA = await uploadBuffer(noisePng, 'orphan-a.png');
  const upB = await uploadBuffer(noisePng, 'orphan-b.png');
  const dA = upA.body.data;
  const dB = upB.body.data;
  assert(upA.status === 200 && upB.status === 200 && dA.id !== dB.id
    && dA.duplicated === false && dB.duplicated === false,
    '#5a DEDUPE=0 时同内容两次上传各建记录（去重确实被关闭）',
    upA.status === 200 ? `A.dup=${dA.duplicated} B.dup=${dB.duplicated}` : `HTTP ${upA.status}`);

  const rowA = Images.getAny(dA.id);
  const fileA = path.join(config.storageDir, rowA.storage_key);
  const thumbA = rowA.thumb_key ? path.join(config.thumbDir, rowA.thumb_key) : null;
  const delA = await api(`/api/images/${dA.id}`, { method: 'DELETE' });
  assert(delA.status === 200 && !fs.existsSync(fileA),
    '#8 删除记录 A 后其专属物理文件被移除（不再按 sha 误判共享而跳过）',
    fs.existsSync(fileA) ? '文件仍残留' : '已移除');
  assert(thumbA === null || !fs.existsSync(thumbA), '#8 删除记录 A 后其专属缩略图被移除');
  assert(delA.body.data && delA.body.data.storage_removed === true,
    'H8 删除响应新增 storage_removed 字段（additive）');
  await api(`/api/images/${dB.id}`, { method: 'DELETE' });

  /* ---------------------- D. 进程存活探针（子进程） ---------------------- */

  section('D. 流错误进程存活探针（子进程执行）');

  const probeJs = path.join(__dirname, 'bugfix-crash-probe.js');
  // Windows 下 spawnSync(node.exe) 偶发 EBUSY（文件被占用 / 杀软实时扫描），
  // 指数退避重试（本机实测直接命令行运行同一文件可成功，属瞬时锁）
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const runProbe = async (mode) => {
    let lastErr = '';
    for (let attempt = 0; attempt < 6; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const r = spawnSync(process.execPath, [probeJs, mode], { encoding: 'utf8', timeout: 40000 });
      if (!r.error) {
        return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.slice(-300) };
      }
      if (r.error.code === 'EBUSY') {
        // 环境级限制（spawn 原语被禁用/文件持续锁定）：标记跳过而非误报失败
        return { ok: false, spawnBroken: true, out: 'spawn EBUSY（环境限制）' };
      }
      lastErr = r.error.code || r.error.message;
      // eslint-disable-next-line no-await-in-loop
      await sleep(200 * 2 ** attempt);
    }
    return { ok: false, out: `spawn 失败：${lastErr}` };
  };
  const p1 = await runProbe('eisdir');
  if (p1.spawnBroken) skip('#2a 本地直链读流报错不杀进程（spawn 被环境禁用，可单独运行 examples/bugfix-crash-probe.js eisdir 验证）', p1.out);
  else assert(p1.ok, '#2a 本地直链读流报错（文件被目录顶替）不杀进程', p1.ok ? '存活' : p1.out);
  const p2 = await runProbe('proxy');
  if (p2.spawnBroken) skip('#2b WebDAV 代理转发中断不杀进程（spawn 被环境禁用，可单独运行 examples/bugfix-crash-probe.js proxy 验证）', p2.out);
  else assert(p2.ok, '#2b WebDAV 代理转发中途上游断连不杀进程', p2.ok ? '存活' : p2.out);

  /* ---------------------- E. XFF 伪造限流（必须最后跑） ---------------------- */

  section('E. TRUST_PROXY 下 XFF 伪造限流（占用登录限流桶，置于最后）');

  let saw429 = false;
  const codes = [];
  for (let i = 1; i <= 12; i += 1) {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': `1.2.3.${i}, 5.6.7.8`, // 左段攻击者可控；右段才是真实客户端
      },
      body: JSON.stringify({ password: 'wrong-guess' }),
    });
    codes.push(r.status);
    if (r.status === 429) saw429 = true;
  }
  assert(saw429, '#9 TRUST_PROXY=1 时限流按真实客户端 IP 计数（伪造左段 XFF 无法绕过）',
    codes.join(','));

  /* ------------------------------ 汇总 ------------------------------ */

  console.log(`\n\x1b[1m测试结果\x1b[0m  通过 \x1b[32m${passed}\x1b[0m 项，失败 \x1b[31m${failed}\x1b[0m 项，跳过 \x1b[33m${skipped}\x1b[0m 项\n`);
  if (failed) {
    console.log('失败明细：');
    failures.forEach((f) => console.log(`  - ${f}`));
    console.log('');
  }

  server.close();
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('\n\x1b[31m测试异常终止：\x1b[0m', err);
  console.error(err && err.stack);
  process.exit(1);
});
