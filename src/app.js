'use strict';

/**
 * Express 应用装配
 * ------------------------------------------------------------------
 * 中间件顺序（顺序即安全边界，请勿随意调整）：
 *   securityHeaders -> cors -> body parser -> authenticate(可选身份识别)
 *   -> /api 限流 -> API 路由 -> 资源与页面路由 -> 静态资源 -> 404 -> 错误处理
 */

const express = require('express');
const config = require('./config');
const { authenticate } = require('./middleware/auth');
const { apiLimiter } = require('./middleware/rateLimit');
const { cors, securityHeaders, notFound, errorHandler } = require('./middleware/error');
const apiRouter = require('./routes/api');
const pagesRouter = require('./routes/pages');

function createApp() {
  const app = express();

  // 反向代理（Nginx / Caddy / Cloudflare）后需要开启，才能拿到真实 IP 与协议
  if (config.trustProxy) app.set('trust proxy', true);
  app.disable('etag');
  app.disable('x-powered-by');

  app.use(securityHeaders);
  app.use(cors);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // 全局身份识别：解析 Token 但不拦截，后续中间件按需判断 req.isAdmin
  app.use(authenticate);

  // API（同时提供 /api 与 /api/v1，方便版本化接入）
  app.use('/api', apiLimiter(), apiRouter);
  app.use('/api/v1', apiLimiter(), apiRouter);

  // 图片资源与页面
  app.use(pagesRouter);

  // 前端静态资源
  app.use(
    express.static(config.publicDir, {
      maxAge: config.isProd ? '1h' : 0,
      extensions: ['html'],
      index: 'index.html',
    }),
  );

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
