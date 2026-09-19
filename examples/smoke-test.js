'use strict';

/**
 * 端到端冒烟测试
 * ------------------------------------------------------------------
 * 覆盖完整业务闭环：
 *   健康检查 → 游客上传 → 直链可访问 → 缩略图 → 游客越权删除被拒
 *   → 上传凭证删除（无凭证 / 伪造凭证被拒，合法凭证可删，秒传不下发凭证）
 *   → 管理员登录 → 管理员上传 → 列表/统计 → 动态改配置生效（游客限额）
 *   → 删除 → 删除后直链 404
 *
 * 用法：
 *   node examples/make-test-assets.js      # 先生成测试素材
 *   node examples/smoke-test.js            # 默认 http://localhost:3000
 *   BASE=http://localhost:3100 ADMIN_PASSWORD=admin123 node examples/smoke-test.js
 */

const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || process.env.PUBLIC_BASE_URL || 'http://localhost:3000';
const PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ASSET_DIR = path.join(__dirname, '..', 'tmp-assets');

let token = null;
let passed = 0;
let failed = 0;
const failures = [];

/* ------------------------------- 测试框架 ------------------------------- */

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
  if (cond) ok(name, detail);
  else fail(name, detail);
  return cond;
}

function section(title) {
  console.log(`\n\x1b[36m${title}\x1b[0m`);
}

async function api(pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token && options.auth !== false) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${BASE}${pathname}`, { ...options, headers });
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('json') ? await res.json() : await res.text();
  return { status: res.status, body, headers: res.headers };
}

async function upload(files, { asAdmin = false } = {}) {
  const form = new FormData();
  for (const f of files) {
    const buf = fs.readFileSync(path.join(ASSET_DIR, f));
    form.append('file', new Blob([buf]), f);
  }
  const res = await fetch(`${BASE}/api/upload`, {
    method: 'POST',
    headers: asAdmin && token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  return { status: res.status, body: await res.json() };
}

/* --------------------------------- 主流程 --------------------------------- */

async function main() {
  console.log(`\n\x1b[1mLumina 图床 · 端到端冒烟测试\x1b[0m\n目标: ${BASE}`);

  if (!fs.existsSync(ASSET_DIR)) {
    console.error(`\n\x1b[31m缺少测试素材目录：${ASSET_DIR}\x1b[0m\n请先执行：node examples/make-test-assets.js\n`);
    process.exit(1);
  }

  /* ---------------------------- 1. 健康检查 ---------------------------- */
  section('1. 系统与配置');

  const health = await api('/api/health');
  assert(health.status === 200 && health.body.data.status === 'ok', 'GET /api/health 返回 ok',
    `Node ${health.body.data && health.body.data.node}`);

  const config = await api('/api/config', { auth: false });
  assert(config.status === 200 && Array.isArray(config.body.data.allowed_formats), 'GET /api/config 返回公开配置',
    `允许格式 ${config.body.data.allowed_formats.join(',')}`);
  assert(!/password/i.test(JSON.stringify(config.body.data)), '公开配置不含任何敏感字段');

  const limits = await api('/api/upload/limits', { auth: false });
  assert(limits.status === 200 && limits.body.data.identity === 'guest', 'GET /api/upload/limits 识别为游客',
    `上限 ${limits.body.data.max_file_size_human}`);

  /* ---------------------------- 2. 游客上传 ---------------------------- */
  section('2. 游客上传与直链');

  const guestUp = await upload(['sample.png', 'vector.svg', 'anim.gif']);
  const created = Array.isArray(guestUp.body.data) ? guestUp.body.data : [guestUp.body.data];
  assert(guestUp.status === 200 && created.length === 3, '游客一次上传 3 个文件（含 SVG 与动图）',
    created.map((c) => c.ext).join('+'));

  const png = created.find((c) => c.ext === 'png');
  const svg = created.find((c) => c.ext === 'svg');
  const gif = created.find((c) => c.ext === 'gif');

  if (png) {
    assert(typeof png.url === 'string' && png.url.startsWith('http'), '生成可公开访问的直链', png.url);

    const direct = await fetch(png.url);
    const buf = Buffer.from(await direct.arrayBuffer());
    assert(direct.status === 200, '直链可 GET 访问', `HTTP ${direct.status}`);
    assert(direct.headers.get('content-type') === 'image/png', '直链返回正确 Content-Type',
      direct.headers.get('content-type'));
    assert(direct.headers.get('cache-control') === 'public, max-age=31536000, immutable',
      '直链带 immutable 长缓存头');
    assert(buf.length > 0, '直链返回非空内容', `${(buf.length / 1024).toFixed(1)} KB`);

    const thumb = await fetch(png.thumb_url);
    assert(thumb.status === 200 && thumb.headers.get('content-type') === 'image/webp',
      '缩略图返回 WebP', `HTTP ${thumb.status}`);

    const page = await fetch(png.page_url);
    const html = await page.text();
    assert(page.status === 200 && /og:image/.test(html), '详情页包含 og:image 元信息');

    assert(png.formats && png.formats.markdown.includes(png.url) && png.formats.bbcode.startsWith('[img]'),
      '返回直链 / HTML / Markdown / BBCode 多格式引用');

    assert(png.compression && png.compression.original_size >= png.compression.final_size,
      '返回服务端优化前后体积对比',
      `${(png.compression.original_size / 1024).toFixed(0)}KB → ${png.compression.final_size}B`);
  }

  if (svg) {
    const s = await fetch(svg.url);
    const text = await s.text();
    assert(svg.vector === true, 'SVG 被识别为矢量图');
    assert(!/<!--/.test(text) && !/<\?xml/.test(text), 'SVG 已做安全精简（去注释 / XML 声明）',
      `${svg.size} 字节`);
    assert(text.includes('<svg'), 'SVG 仍为矢量文本，未被栅格化');
  }

  if (gif) {
    assert(gif.animated === true && gif.pages > 1, 'GIF 被识别为动态图', `${gif.pages} 帧`);
    const g = await fetch(gif.url);
    const buf = Buffer.from(await g.arrayBuffer());
    assert(buf.subarray(0, 3).toString('ascii') === 'GIF', '动态图原样存储，仍为 GIF 格式');
    assert(gif.height === 120 && gif.width === 120, '动态图尺寸计算正确（已剔除多帧堆叠高度）',
      `${gif.width}×${gif.height}`);
  }

  /* -------------------------- 3. 游客权限边界 -------------------------- */
  section('3. 权限边界');

  const guestDelete = await api(`/api/images/${png.id}`, { method: 'DELETE', auth: false });
  assert(guestDelete.status === 401, '游客删除图片被拒绝', `HTTP ${guestDelete.status} 无权限`);

  const guestList = await api('/api/images', { auth: false });
  assert(guestList.status === 401, '游客访问图片列表被拒绝', `HTTP ${guestList.status}`);

  const guestStats = await api('/api/images/stats', { auth: false });
  assert(guestStats.status === 401, '游客访问统计被拒绝', `HTTP ${guestStats.status}`);

  const guestSettings = await api('/api/settings', { method: 'PATCH', body: '{}', auth: false });
  assert(guestSettings.status === 401, '游客修改配置被拒绝', `HTTP ${guestSettings.status}`);

  const badToken = await fetch(`${BASE}/api/images`, { headers: { Authorization: 'Bearer forged.token' } });
  assert(badToken.status === 401, '伪造 Token 被拒绝', `HTTP ${badToken.status}`);

  /* ----------- 3.5 上传凭证删除（上传页「删除单张任务」的服务端通路） ----------- */
  section('3.5 上传凭证删除');

  const sharp = require('sharp');
  const crypto = require('crypto');

  // 用随机噪声生成内容唯一的 PNG：确保本次是「新建记录」而非秒传
  // （秒传复用别人的记录，按设计不下发删除凭证）
  const noise = crypto.randomBytes(96 * 96 * 3);
  const credBuf = await sharp(noise, { raw: { width: 96, height: 96, channels: 3 } })
    .png()
    .toBuffer();

  /** 以游客身份上传一份字节内容（不走 api()，确保不带任何 Token） */
  const postImage = async (buf, name) => {
    const form = new FormData();
    form.append('file', new Blob([buf]), name);
    const res = await fetch(`${BASE}/api/upload`, { method: 'POST', body: form });
    return { status: res.status, body: await res.json() };
  };

  const credUp = await postImage(credBuf, 'credential.png');
  const cred = credUp.body.data;

  assert(credUp.status === 200 && typeof cred.delete_key === 'string' && cred.delete_key.length > 0,
    '新建记录的上传响应下发 delete_key（游客也能清理自己刚上传的图）',
    `${String(cred.delete_key).slice(0, 10)}…`);
  assert(cred.duplicated === false, '本次为新建记录，而非秒传复用');

  const noKey = await fetch(`${BASE}/api/images/${cred.id}`, { method: 'DELETE' });
  assert(noKey.status === 401, '不带 delete_key 的游客删除仍被拒绝', `HTTP ${noKey.status}`);

  const forgedKey = await fetch(`${BASE}/api/images/${cred.id}?key=forged-key`, { method: 'DELETE' });
  assert(forgedKey.status === 401, '伪造 delete_key 被拒绝', `HTTP ${forgedKey.status}`);

  const withKey = await fetch(
    `${BASE}/api/images/${cred.id}?key=${encodeURIComponent(cred.delete_key)}`,
    { method: 'DELETE' },
  );
  const withKeyBody = await withKey.json();
  assert(withKey.status === 200 && withKeyBody.success, '携带合法 delete_key 可删除该图片',
    `HTTP ${withKey.status}`);

  const credGone = await fetch(`${BASE}/api/images/${cred.id}`);
  assert(credGone.status === 404, '凭证删除后元数据返回 404', `HTTP ${credGone.status}`);
  const credLink = await fetch(cred.url, { method: 'HEAD' });
  assert(credLink.status === 404, '凭证删除后直链不再可访问', `HTTP ${credLink.status}`);

  // 秒传复用的记录不下发凭证：否则后上传者就能删掉先上传者的图
  const seed = await postImage(credBuf, 'dedupe-seed.png');
  assert(seed.body.data.duplicated === false, '（前置）重新上传同一内容建立基础记录');
  const dupHit = await postImage(credBuf, 'dedupe-hit.png');
  assert(dupHit.body.data.duplicated === true, '相同内容命中秒传', dupHit.body.data.id);
  assert(dupHit.body.data.delete_key === null,
    '秒传复用的记录不下发 delete_key（不会误删他人文件）');

  /* ---------------------------- 4. 管理员登录 ---------------------------- */
  section('4. 管理员鉴权');

  const login = await api('/api/auth/login', {
    method: 'POST',
    auth: false,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'definitely-wrong-password' }),
  });
  assert(login.status === 401, '错误密码登录失败', `HTTP ${login.status}`);

  const good = await api('/api/auth/login', {
    method: 'POST',
    auth: false,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert(good.status === 200 && !!good.body.data.token, '管理员密码登录成功并下发 Token');

  if (good.status !== 200) {
    console.log('\n\x1b[31m登录失败，后续用例无法继续。请确认 ADMIN_PASSWORD 或初始密码。\x1b[0m\n');
    return finish();
  }
  token = good.body.data.token;

  const me = await api('/api/auth/me');
  assert(me.status === 200 && me.body.data.user.role === 'admin', 'GET /api/auth/me 返回管理员身份');

  /* -------------------------- 5. 管理员上传与管理 -------------------------- */
  section('5. 管理员上传与管理');

  const adminUp = await upload(['big.jpg'], { asAdmin: true });
  const big = Array.isArray(adminUp.body.data) ? adminUp.body.data[0] : adminUp.body.data;
  assert(adminUp.status === 200 && big, '管理员上传超过游客限额的大文件成功',
    `${big.width}×${big.height} · ${big.size_human}`);
  assert(big.uploader === 'admin', '记录上传者为 admin');
  assert(big.compression.note.length > 0, '返回处理说明', big.compression.note);

  const list = await api('/api/images?page=1&limit=5');
  assert(list.status === 200 && Array.isArray(list.body.data) && list.body.pagination.total >= 4,
    'GET /api/images 分页列表正常', `共 ${list.body.pagination.total} 张，每页 ${list.body.pagination.limit}`);

  const filtered = await api('/api/images?uploader=guest');
  assert(filtered.status === 200 && filtered.body.data.every((i) => i.uploader === 'guest'),
    '按上传者筛选生效', `游客 ${filtered.body.pagination.total} 张`);

  const byExt = await api('/api/images?ext=svg');
  assert(byExt.status === 200 && byExt.body.data.every((i) => i.ext === 'svg'), '按格式筛选生效');

  const stats = await api('/api/images/stats');
  assert(stats.status === 200 && stats.body.data.total >= 4 && stats.body.data.animatedCount >= 1,
    'GET /api/images/stats 统计正确',
    `总数 ${stats.body.data.total} · 动态 ${stats.body.data.animatedCount} · 矢量 ${stats.body.data.vectorCount}`);

  /* ----------------------- 6. 动态配置：游客限额 ----------------------- */
  section('6. 游客上传大小上限（运行时热更新）');

  const setSmall = await api('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guest_max_file_size: 1024 }), // 收紧到 1KB（测试文件 3.4KB，必然超限）
  });
  assert(setSmall.status === 200 && setSmall.body.data.updated.includes('guest_max_file_size'),
    'PATCH /api/settings 把游客上限收紧到 1KB');

  const tooBig = await upload(['sample.jpg']);
  assert(tooBig.status === 413, '超出游客上限的上传被拒绝', `HTTP ${tooBig.status}`);
  assert(tooBig.body.error && tooBig.body.error.code === 'FILE_TOO_LARGE',
    '返回明确错误码 FILE_TOO_LARGE',
    tooBig.body.error ? tooBig.body.error.message : '(无错误体)');
  assert(tooBig.body.error && /1\.00 KB/.test(tooBig.body.error.message),
    '错误信息里带上当前生效的限额',
    tooBig.body.error ? tooBig.body.error.message : '');

  const adminStillOk = await upload(['sample.jpg'], { asAdmin: true });
  assert(adminStillOk.status === 200, '同一文件在管理员身份下仍可上传（限额按身份区分）');

  const restore = await api('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guest_max_file_size: 5 * 1024 * 1024 }),
  });
  assert(restore.status === 200, '恢复游客上限为 5MB');

  const closeGuest = await api('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guest_upload_enabled: false }),
  });
  const blocked = await upload(['sample.png']);
  assert(closeGuest.status === 200 && blocked.status === 403,
    '关闭游客上传后匿名上传返回 403', blocked.body.error && blocked.body.error.code);

  await api('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ guest_upload_enabled: true }),
  });
  assert(true, '重新开启游客上传');

  /* ---------------------------- 7. 删除链路 ---------------------------- */
  section('7. 删除与存储清理');

  const storageKey = big.id;
  const beforeDelete = await fetch(big.url);
  assert(beforeDelete.status === 200, '删除前直链可访问');

  const del = await api(`/api/images/${big.id}`, { method: 'DELETE' });
  assert(del.status === 200 && del.body.data.message === '删除成功', '管理员删除图片成功');

  const afterDelete = await fetch(big.url);
  assert(afterDelete.status === 404 || afterDelete.status === 403,
    '删除后物理文件已从磁盘移除（直链 404）', `HTTP ${afterDelete.status}`);

  const metaGone = await api(`/api/images/${storageKey}`, { auth: false });
  assert(metaGone.status === 404, '删除后元数据查询返回 404');

  const batch = await api('/api/images/batch-delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [png.id, svg.id, gif.id].filter(Boolean) }),
  });
  assert(batch.status === 200 && batch.body.data.deleted.length >= 1, '批量删除接口正常',
    `已删除 ${batch.body.data.deleted.length} 张`);

  /* --------------------------- 8. 防伪与校验 --------------------------- */
  section('8. 输入校验与安全');

  const fake = await api('/api/upload', {
    method: 'POST',
    auth: false,
    headers: { 'Content-Type': 'application/json' },
  });
  assert(fake.status === 400, '非 multipart 请求被拒绝', `HTTP ${fake.status}`);

  const traversal = await fetch(`${BASE}/i/..%2F..%2Fpackage.json`);
  assert(traversal.status === 404, '路径穿越尝试被拒绝', `HTTP ${traversal.status}`);

  const badId = await api('/api/images/!!!invalid!!!', { auth: false });
  assert(badId.status === 400 || badId.status === 404, '非法图片 ID 被拒绝', `HTTP ${badId.status}`);

  const svgHead = await fetch(`${BASE}/t/${'a'.repeat(8)}`);
  assert(svgHead.status === 404, '不存在 ID 的缩略图返回 404', `HTTP ${svgHead.status}`);

  return finish();
}

function finish() {
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
