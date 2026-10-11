'use strict';

/**
 * 鉴权中间件
 * ------------------------------------------------------------------
 * 设计：单一管理员 + 游客匿名上传
 *   - 游客：仅可上传（需 GUEST_UPLOAD_ENABLED=1）、可访问公开直链
 *   - 管理员：上传 + 查看列表 + 删除 + 改配置 + 统计
 *
 * Token 获取途径（按优先级）：
 *   1. Authorization: Bearer <token>       —— 推荐（API / 前端）
 *   2. Cookie: lumina_token                 —— 管理台登录时下发（HttpOnly + SameSite=Strict，防 CSRF）
 *   3. ?token=<token>                       —— 仅供文件下载/图片预览等 GET 场景兜底
 */

const config = require('../config');
const { verify } = require('../utils/token');
const { ApiError } = require('../utils');

/** 解析真实客户端 IP（支持反代）
 * trustProxy 已在 app.js 按「可信代理层数」配置（TRUST_PROXY=true 视为 1 层），
 * req.ip 由 Express 从右往左解析出第一个不可信地址 —— 客户端伪造 XFF 左段无效。
 * 注意不可直接取 XFF 最左段：那是客户端完全可控的字段，会让限流形同虚设。 */
function getClientIp(req) {
  return (req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}

function extractToken(req) {
  const auth = req.headers.authorization || req.headers.Authorization;
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();

  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    for (const part of cookieHeader.split(';')) {
      const [k, ...v] = part.trim().split('=');
      if (k === config.cookieName) {
        const raw = v.join('=');
        try {
          return decodeURIComponent(raw);
        } catch (_) {
          return raw; // 畸形编码（如 %zz）按原值处理，绝不让解析环节 500
        }
      }
    }
  }

  // ?token= 仅作 GET / HEAD 场景兜底（文件下载 / 图片预览），
  // 不对写入类请求生效，避免 token 经 URL / Referer / 访问日志泄漏后被用于写操作
  if (req.query && typeof req.query.token === 'string' && ['GET', 'HEAD'].includes(req.method)) {
    return req.query.token;
  }
  return null;
}

/** 解析身份但不拦截（游客也放行） */
function authenticate(req, _res, next) {
  req.clientIp = getClientIp(req);
  req.isAdmin = false;

  const token = extractToken(req);
  if (token) {
    const payload = verify(token);
    if (payload && payload.role === 'admin') {
      req.isAdmin = true;
      req.user = { name: payload.sub, role: 'admin', jti: payload.jti };
      req.tokenPayload = payload;
    }
  }
  next();
}

/** 强制管理员 */
function requireAdmin(req, _res, next) {
  if (!req.isAdmin) {
    return next(new ApiError(401, '需要管理员权限，请先登录', 'UNAUTHORIZED'));
  }
  next();
}

/** 上传权限：管理员始终允许；游客受开关控制 */
function requireUploadPermission(req, _res, next) {
  if (req.isAdmin) return next();
  // 动态读取配置（管理台可实时开关）
  const { settings } = require('../services/settings');
  if (!settings.get('guest_upload_enabled')) {
    return next(new ApiError(403, '站点已关闭游客上传，请联系管理员', 'GUEST_UPLOAD_DISABLED'));
  }
  next();
}

module.exports = { authenticate, requireAdmin, requireUploadPermission, getClientIp, extractToken };
