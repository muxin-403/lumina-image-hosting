'use strict';

/**
 * 鉴权接口
 *   POST /api/auth/login     管理员登录
 *   POST /api/auth/logout    退出（吊销当前 Token）
 *   GET  /api/auth/me        当前登录态
 *   POST /api/auth/password  修改管理员密码（会吊销全部旧会话）
 */

const express = require('express');
const config = require('../config');
const { settings } = require('../services/settings');
const { issue } = require('../utils/token');
const { ApiError, ok } = require('../utils');
const { requireAdmin } = require('../middleware/auth');
const { loginLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/error');
const { Tokens } = require('../db');

const router = express.Router();

/** 下发登录 Cookie（HttpOnly + SameSite=Strict，天然抵御 CSRF） */
function setAuthCookie(res, token, maxAgeSec) {
  const parts = [
    `${config.cookieName}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSec}`,
  ];
  if (config.isProd) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearAuthCookie(res) {
  res.append(
    'Set-Cookie',
    `${config.cookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
  );
}

router.post(
  '/login',
  loginLimiter(),
  asyncHandler(async (req, res) => {
    const password = req.body && (req.body.password || req.body.pass);
    if (!password) throw new ApiError(400, '请提供 password 字段', 'MISSING_PASSWORD');

    if (!settings.verifyPassword(password)) {
      throw new ApiError(401, '管理员密码错误', 'BAD_CREDENTIALS');
    }

    const { token, payload } = issue({ label: req.get('user-agent') || 'api' });
    setAuthCookie(res, token, config.tokenTtl);

    return ok(res, {
      token,
      token_type: 'Bearer',
      expires_at: payload.exp,
      expires_in: config.tokenTtl,
      user: { name: payload.sub, role: 'admin' },
    });
  }),
);

router.post(
  '/logout',
  requireAdmin,
  asyncHandler(async (req, res) => {
    if (req.tokenPayload && req.tokenPayload.jti) Tokens.revoke(req.tokenPayload.jti);
    clearAuthCookie(res);
    return ok(res, { logged_out: true });
  }),
);

router.get(
  '/me',
  requireAdmin,
  asyncHandler(async (req, res) =>
    ok(res, {
      user: req.user,
      expires_at: req.tokenPayload.exp,
      default_password: settings.usingDefaultPassword(),
    }),
  ),
);

router.post(
  '/password',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { old_password: oldPwd, new_password: newPwd } = req.body || {};
    if (!newPwd || String(newPwd).length < 6) {
      throw new ApiError(400, '新密码至少 6 位', 'WEAK_PASSWORD');
    }
    if (!settings.verifyPassword(oldPwd)) {
      throw new ApiError(401, '原密码不正确', 'BAD_CREDENTIALS');
    }

    settings.setPassword(String(newPwd));
    Tokens.revokeAll(); // 改密即踢出所有旧会话

    const { token, payload } = issue({ label: 'after-password-change' });
    setAuthCookie(res, token, config.tokenTtl);
    return ok(res, { token, expires_at: payload.exp, message: '密码已更新，其它会话已失效' });
  }),
);

module.exports = router;
