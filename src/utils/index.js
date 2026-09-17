'use strict';

/**
 * 通用工具函数
 */

const crypto = require('crypto');
const path = require('path');

/* --------------------------- ID / 文件名生成 --------------------------- */

// 去掉容易混淆的 0/O/1/l/I
const ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ';

/** 生成 URL 安全的短 ID（默认 10 位，约 57^10 空间，足够抗碰撞） */
function shortId(len = 10) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i += 1) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return out;
}

/** 去掉路径成分，仅保留文件名，并做白名单化 */
function safeBaseName(name = '') {
  return path
    .basename(String(name))
    .replace(/[^\w\u4e00-\u9fa5.\-@()\s]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 120);
}

/** 生成 yyyy/mm 形式的日期分片（便于海量文件分目录，避免单目录文件过多） */
function dateShard(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return `${y}/${m}`;
}

/** 时间戳 -> 'YYYY-MM-DD HH:mm:ss' */
function formatTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}:${p(d.getSeconds())}`;
}

/* ------------------------------- 编码工具 ------------------------------- */

function base64UrlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64UrlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

/* --------------------------------- 杂项 --------------------------------- */

function humanSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(2)} ${units[i]}`;
}

/** 带级别的极简日志器（无第三方依赖） */
const colors = { reset: '\x1b[0m', gray: '\x1b[90m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m' };

function log(level, msg, extra) {
  const ts = formatTime(Date.now());
  const tag = {
    info: `${colors.cyan}[INFO]${colors.reset}`,
    ok: `${colors.green}[ OK ]${colors.reset}`,
    warn: `${colors.yellow}[WARN]${colors.reset}`,
    error: `${colors.red}[FAIL]${colors.reset}`,
  }[level] || '[LOG ]';
  const tail = extra === undefined ? '' : ` ${colors.gray}${typeof extra === 'string' ? extra : JSON.stringify(extra)}${colors.reset}`;
  console.log(`${colors.gray}${ts}${colors.reset} ${tag} ${msg}${tail}`);
}

const logger = {
  info: (m, e) => log('info', m, e),
  ok: (m, e) => log('ok', m, e),
  warn: (m, e) => log('warn', m, e),
  error: (m, e) => log('error', m, e),
};

/** 统一成功响应体 */
function ok(res, data, extra = {}) {
  return res.json({ success: true, data, ...extra });
}

/** 业务异常：抛出后由全局错误中间件转为统一错误响应 */
class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || `E${status}`;
  }
}

module.exports = {
  shortId,
  safeBaseName,
  dateShard,
  formatTime,
  base64UrlEncode,
  base64UrlDecode,
  humanSize,
  logger,
  ok,
  ApiError,
};
