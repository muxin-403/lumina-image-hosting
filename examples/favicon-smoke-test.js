'use strict';

/**
 * 站点图标（favicon）功能冒烟测试
 * ------------------------------------------------------------------
 * 用法：先启动服务（测试端口 + 测试管理员密码），再运行本脚本：
 *   PORT=3719 ADMIN_PASSWORD=test-favicon-123 node src/server.js
 *   node examples/favicon-smoke-test.js http://127.0.0.1:3719
 *
 * 覆盖点：
 *   1. 未登录上传被拒绝（401）
 *   2. 未设置图标时 /favicon.ico 回落默认 SVG
 *   3. 管理员上传 PNG 后 /favicon.ico 立即返回同内容 PNG
 *   4. /api/config 下发带版本号的 favicon_url
 *   5. /api/settings 回报 favicon_set / favicon_ext
 *   6. 伪装成 .svg 的文本内容被格式嗅探拒绝（400）
 *   7. DELETE 后回落默认图标
 */

const BASE = process.argv[2] || 'http://127.0.0.1:3719';
const PASSWORD = process.env.ADMIN_PASSWORD || 'test-favicon-123';

/** 1×1 透明 PNG */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let failed = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${msg}`);
  }
}

async function main() {
  console.log(`favicon 冒烟测试 → ${BASE}\n`);

  // 1. 未登录上传 → 401
  let r = await fetch(`${BASE}/api/favicon`, { method: 'POST' });
  assert(r.status === 401, '未登录上传图标被拒绝（401）');

  // 2. 默认回退
  r = await fetch(`${BASE}/favicon.ico`);
  let ct = r.headers.get('content-type') || '';
  assert(ct.includes('image/svg+xml'), `未设置时 /favicon.ico 回落默认 SVG（${ct}）`);

  // 3. 登录
  r = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const login = await r.json().catch(() => null);
  assert(r.ok && login && login.data && login.data.token, '管理员登录成功');
  const auth = { Authorization: `Bearer ${login.data.token}` };

  // 4. 上传 PNG 图标
  const png = Buffer.from(PNG_B64, 'base64');
  let fd = new FormData();
  fd.append('file', new Blob([png], { type: 'image/png' }), 'icon.png');
  r = await fetch(`${BASE}/api/favicon`, { method: 'POST', headers: auth, body: fd });
  let payload = await r.json().catch(() => null);
  assert(
    r.ok && payload && payload.data && payload.data.ext === 'png',
    `PNG 图标上传成功（ext=${payload && payload.data ? payload.data.ext : 'n/a'}）`,
  );
  const faviconUrl = payload.data.favicon_url;

  // 5. 出口立即生效
  r = await fetch(`${BASE}/favicon.ico`);
  ct = r.headers.get('content-type') || '';
  const body = Buffer.from(await r.arrayBuffer());
  assert(ct.includes('image/png'), `/favicon.ico 已返回 PNG（${ct}）`);
  assert(body.equals(png), '响应内容与上传内容一致');

  // 6. /api/config 下发带版本号地址
  r = await fetch(`${BASE}/api/config`);
  payload = await r.json();
  assert(
    payload.data.favicon_url === faviconUrl,
    `公开配置下发带版本号图标地址（${payload.data.favicon_url}）`,
  );

  // 7. /api/settings 回报状态
  r = await fetch(`${BASE}/api/settings`, { headers: auth });
  payload = await r.json();
  assert(
    payload.data.favicon_set === true && payload.data.favicon_ext === 'png',
    '管理配置回报 favicon_set / favicon_ext',
  );

  // 8. 格式嗅探拒绝伪装内容
  fd = new FormData();
  fd.append(
    'file',
    new Blob(['<html><script>alert(1)</script></html>'], { type: 'image/svg+xml' }),
    'evil.svg',
  );
  r = await fetch(`${BASE}/api/favicon`, { method: 'POST', headers: auth, body: fd });
  assert(r.status === 400, '伪装成 .svg 的文本内容被拒绝（400）');

  // 9. 恢复默认
  r = await fetch(`${BASE}/api/favicon`, { method: 'DELETE', headers: auth });
  assert(r.ok, '恢复默认成功');
  r = await fetch(`${BASE}/favicon.ico`);
  ct = r.headers.get('content-type') || '';
  assert(ct.includes('image/svg+xml'), `删除后回落默认 SVG（${ct}）`);

  console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项失败 ❌`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('测试执行失败：', err.message);
  process.exit(1);
});
