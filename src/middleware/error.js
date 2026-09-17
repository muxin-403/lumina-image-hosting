'use strict';

/**
 * 统一错误处理与 404
 * ------------------------------------------------------------------
 * 所有失败响应保持同一形状，方便客户端程序化处理：
 *   { success: false, error: { code, message, status } }
 */

const config = require('../config');
const { ApiError, logger } = require('../utils');

function notFound(req, res, next) {
  if (req.path.startsWith('/api/')) {
    return next(new ApiError(404, `接口不存在：${req.method} ${req.originalUrl}`, 'NOT_FOUND'));
  }
  return res.status(404).sendFile(`${config.publicDir}/404.html`, (err) => {
    if (err) {
      // 兜底：404.html 缺失时直接返回纯文本
      res.type('text/plain').send('404 Not Found');
    }
  });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  const status = Number.isInteger(err.status) ? err.status : 500;
  const code = err.code && typeof err.code === 'string' ? err.code : `E${status}`;
  const message = status >= 500 ? err.message || '服务器内部错误' : err.message || '请求失败';

  // 5xx 记录完整堆栈，4xx 只在 debug 下打印一行
  if (status >= 500) {
    logger.error(`${req.method} ${req.originalUrl} -> ${status}`, err.stack || err.message);
  } else if (!config.isProd) {
    logger.warn(`${req.method} ${req.originalUrl} -> ${status} ${message}`);
  }

  if (res.headersSent) return res.end();

  res.status(status).json({
    success: false,
    error: {
      code,
      message,
      status,
      ...(config.isProd ? {} : { path: req.originalUrl }),
    },
  });
}

/** 包装 async 路由，异常自动转交 errorHandler */
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/** 简易 CORS（按 CORS_ORIGINS 配置放开） */
function cors(req, res, next) {
  const allowed = config.corsOrigins;
  const origin = req.headers.origin;
  if (origin && (allowed.includes('*') || allowed.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', allowed.includes('*') ? '*' : origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type,Authorization,X-Requested-With,X-Api-Key',
    );
    res.setHeader('Access-Control-Max-Age', '86400');
    if (!allowed.includes('*')) res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
}

/** 基础安全响应头（等价于 helmet 的核心子集，避免额外依赖） */
function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer-when-downgrade');
  res.removeHeader('X-Powered-By');
  res.setHeader('X-Powered-By', 'Lumina/1.0');
  next();
}

module.exports = { notFound, errorHandler, asyncHandler, cors, securityHeaders };
