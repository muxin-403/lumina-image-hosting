'use strict';

/**
 * 轻量签名 Token（结构同 JWT，HMAC-SHA256）
 * ------------------------------------------------------------------
 * 不引入 jsonwebtoken 依赖，仅用 Node 内置 crypto 实现：
 *   token = base64url(payload) + "." + base64url(hmacSHA256(payload, secret))
 *
 * 相比纯 JWT 多了一层「服务端吊销名单」（tokens 表）：
 * 登出、改密时可立即让已签发的 Token 失效。
 */

const crypto = require('crypto');
const config = require('../config');
const { base64UrlEncode, base64UrlDecode } = require('./index');
const { Tokens } = require('../db');

function sign(payload) {
  const body = base64UrlEncode(JSON.stringify(payload));
  const sig = base64UrlEncode(
    crypto.createHmac('sha256', config.sessionSecret).update(body).digest(),
  );
  return `${body}.${sig}`;
}

function verify(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;

  const expected = base64UrlEncode(
    crypto.createHmac('sha256', config.sessionSecret).update(body).digest(),
  );
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(body).toString('utf8'));
  } catch (_) {
    return null;
  }
  if (!payload || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  // 吊销名单校验
  if (payload.jti && !Tokens.has(payload.jti)) return null;
  return payload;
}

/**
 * 签发管理员 Token 并登记吊销名单
 * @param {object} opt { user, ttl, label }
 */
function issue(opt = {}) {
  const now = Math.floor(Date.now() / 1000);
  const ttl = Number(opt.ttl) || config.tokenTtl;
  const jti = crypto.randomBytes(12).toString('hex');
  const payload = {
    sub: opt.user || config.adminUser,
    role: 'admin',
    jti,
    iat: now,
    exp: now + ttl,
    label: opt.label || 'web',
  };
  Tokens.add(jti, payload.label, (now + ttl) * 1000);
  return { token: sign(payload), payload, expiresAt: payload.exp };
}

module.exports = { sign, verify, issue };
