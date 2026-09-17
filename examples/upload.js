#!/usr/bin/env node
'use strict';

/**
 * Lumina 图床 · Node.js 客户端示例（Node 18+，零依赖）
 * ------------------------------------------------------------------
 * 用法：
 *   node examples/upload.js upload images/cat.png
 *   node examples/upload.js upload a.png b.jpg c.svg --password admin123
 *   node examples/upload.js list   --password admin123 --limit 5 --order largest
 *   node examples/upload.js stats  --password admin123
 *   node examples/upload.js delete <id> --password admin123
 *   node examples/upload.js settings --password admin123 --guest-max 8mb
 *   node examples/upload.js health
 *
 * 环境变量：LUMINA_BASE / LUMINA_PASSWORD
 */

const fs = require('fs');
const path = require('path');

let BASE = (process.env.LUMINA_BASE || 'http://localhost:3000').replace(/\/+$/, '');
const ENV_PASSWORD = process.env.LUMINA_PASSWORD || '';
let TOKEN = null;

/* ------------------------------ 参数解析 ------------------------------ */

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out.flags[key] = next;
        i += 1;
      } else {
        out.flags[key] = true;
      }
    } else {
      out._.push(token);
    }
  }
  return out;
}

/* ------------------------------ HTTP 封装 ------------------------------ */

async function api(method, endpoint, { body, headers, auth = true } = {}) {
  const hdrs = { Accept: 'application/json', ...(headers || {}) };
  if (auth && TOKEN) hdrs.Authorization = `Bearer ${TOKEN}`;

  const res = await fetch(`${BASE}${endpoint}`, { method, headers: hdrs, body });

  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (_) {
    payload = { success: false, raw: text };
  }

  if (res.status >= 400 || !payload.success) {
    const message = (payload.error && payload.error.message) || payload.raw || `HTTP ${res.status}`;
    throw new Error(message);
  }
  return payload;
}

async function login(password) {
  const payload = await api('POST', '/api/auth/login', {
    auth: false,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  TOKEN = payload.data.token;
  console.log(`✓ 管理员登录成功，Token 前缀 ${TOKEN.slice(0, 16)}…`);
}

/* ------------------------------- 业务动作 ------------------------------- */

function human(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${i === 0 ? n : n.toFixed(2)} ${units[i]}`;
}

async function upload(paths) {
  const form = new FormData();
  for (const p of paths) {
    if (!fs.existsSync(p)) throw new Error(`文件不存在：${p}`);
    const buf = fs.readFileSync(p);
    form.append('file', new Blob([buf]), path.basename(p));
  }

  const payload = await api('POST', '/api/upload', { body: form });
  const items = Array.isArray(payload.data) ? payload.data : [payload.data];

  console.log(`✓ 上传成功 ${items.length} 张（失败 ${payload.failed || 0} 张）\n`);
  for (const it of items) {
    const flags = [];
    if (it.vector) flags.push('矢量');
    if (it.animated) flags.push(`动态 ${it.pages} 帧`);
    if (it.duplicated) flags.push('秒传');

    const comp = it.compression || {};
    const saved = comp.saved_bytes > 0 ? `  节省 ${comp.saved_percent}%` : '';

    console.log(`  ${it.filename}`);
    console.log(`    直链      ${it.url}`);
    console.log(`    详情页    ${it.page_url}`);
    console.log(`    缩略图    ${it.thumb_url}`);
    console.log(`    尺寸      ${it.width}×${it.height}  大小 ${it.size_human}${saved}`);
    console.log(`    存储      ${it.storage_driver}  ${flags.join(' ')}`);
    console.log(`    HTML      ${it.formats.html}`);
    console.log(`    Markdown  ${it.formats.markdown}`);
    console.log(`    BBCode    ${it.formats.bbcode}`);
    console.log('');
  }
  return items;
}

async function list(flags) {
  const params = new URLSearchParams({
    page: flags.page || '1',
    limit: flags.limit || '20',
    order: flags.order || 'newest',
  });
  if (flags.uploader) params.set('uploader', flags.uploader);
  if (flags.q) params.set('q', flags.q);

  const payload = await api('GET', `/api/images?${params}`);
  const meta = payload.pagination;
  console.log(`共 ${meta.total} 张，第 ${meta.page}/${meta.pages} 页\n`);

  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  console.log(`${pad('ID', 13)}${pad('文件名', 26)}${pad('尺寸', 13)}${pad('体积', 11)}${pad('来源', 8)}直链`);
  console.log('-'.repeat(126));
  for (const it of payload.data) {
    console.log(
      `${pad(it.id, 13)}${pad(it.filename, 26)}${pad(`${it.width}×${it.height}`, 13)}` +
        `${pad(it.size_human, 11)}${pad(it.uploader, 8)}${it.url}`,
    );
  }
  return payload;
}

async function stats() {
  const { data } = await api('GET', '/api/images/stats');
  console.log('站点统计');
  console.log(`  图片总数    ${data.total}（动态图 ${data.animatedCount}，矢量图 ${data.vectorCount}）`);
  console.log(`  占用空间    ${data.total_human}`);
  console.log(`  今日上传    ${data.todayCount} 张 / ${data.today_bytes_human}`);
  console.log(`  格式分布    ${data.byExt.map((f) => `${f.ext.toUpperCase()}:${f.count}`).join('  ')}`);
  console.log(`  存储驱动    ${data.byDriver.map((f) => `${f.driver}:${f.count}`).join('  ')}`);
  return data;
}

async function remove(ids) {
  for (const id of ids) {
    await api('DELETE', `/api/images/${encodeURIComponent(id)}`);
    console.log(`✓ 已删除 ${id}`);
  }
}

function parseSize(text) {
  const m = String(text).trim().toLowerCase().match(/^([\d.]+)\s*(b|kb|mb|gb)?$/);
  if (!m) throw new Error(`无法解析的大小：${text}`);
  const mul = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[m[2] || 'b'];
  return Math.round(parseFloat(m[1]) * mul);
}

async function settings(flags) {
  const patch = {};
  if (flags['guest-max']) patch.guest_max_file_size = parseSize(flags['guest-max']);
  if (flags['guest-enabled'] !== undefined) {
    patch.guest_upload_enabled = ['true', '1', 'on', 'yes'].includes(String(flags['guest-enabled']));
  }
  if (flags.driver) patch.storage_driver = flags.driver;

  if (Object.keys(patch).length === 0) {
    const { data } = await api('GET', '/api/settings');
    console.log(JSON.stringify(data, null, 2));
    return data;
  }

  const { data } = await api('PATCH', '/api/settings', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  console.log(`✓ 已更新：${data.updated.join(', ')}`);
  for (const w of data.warnings || []) console.log(`  ⚠ ${w}`);
  return data;
}

/* --------------------------------- 入口 --------------------------------- */

async function main() {
  const { _, flags } = parseArgs(process.argv.slice(2));
  const action = _[0];

  if (flags.base) BASE = String(flags.base).replace(/\/+$/, '');
  const password = flags.password || ENV_PASSWORD;

  if (!action || action === 'help') {
    console.log([
      'Lumina 图床 · Node 客户端',
      '',
      '  node examples/upload.js health',
      '  node examples/upload.js upload <文件...> [--password xxx]',
      '  node examples/upload.js list   --password xxx [--limit 5] [--order largest] [--uploader guest]',
      '  node examples/upload.js stats  --password xxx',
      '  node examples/upload.js delete <id...> --password xxx',
      '  node examples/upload.js settings --password xxx [--guest-max 8mb] [--guest-enabled false] [--driver local]',
      '',
      '环境变量：LUMINA_BASE=http://host:port  LUMINA_PASSWORD=xxx',
    ].join('\n'));
    return;
  }

  if (['list', 'stats', 'delete', 'settings'].includes(action)) {
    if (!password) {
      console.error('✗ 该操作需要管理员密码，请加 --password 或设置 LUMINA_PASSWORD');
      process.exit(2);
    }
    await login(password);
    console.log('');
  }

  switch (action) {
    case 'health': {
      const payload = await api('GET', '/api/health', { auth: false });
      console.log(JSON.stringify(payload, null, 2));
      break;
    }
    case 'upload': {
      const files = _.slice(1);
      if (!files.length) throw new Error('请至少指定一个图片路径');
      const items = await upload(files);
      if (flags.json) console.log(JSON.stringify(items, null, 2));
      break;
    }
    case 'list':
      await list(flags);
      break;
    case 'stats':
      await stats();
      break;
    case 'delete': {
      const ids = _.slice(1);
      if (!ids.length) throw new Error('请指定图片 ID');
      await remove(ids);
      break;
    }
    case 'settings':
      await settings(flags);
      break;
    default:
      throw new Error(`未知命令：${action}`);
  }
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});

// 未使用的占位，保持 human() 可被外部脚本 require 时复用
module.exports = { upload, list, stats, remove, settings, human };
