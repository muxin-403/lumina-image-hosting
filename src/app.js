'use strict';

/**
 * Express 应用装配
 * ------------------------------------------------------------------
 * 中间件顺序（顺序即安全边界，请勿随意调整）：
 *   securityHeaders -> cors -> body parser -> authenticate(可选身份识别)
 *   -> /api 限流 -> API 路由 -> 资源与页面路由 -> 静态资源 -> 404 -> 错误处理
 */

const express = require('express');
const path = require('path');
const config = require('./config');
const { authenticate } = require('./middleware/auth');
const { apiLimiter } = require('./middleware/rateLimit');
const { cors, securityHeaders, notFound, errorHandler } = require('./middleware/error');
const apiRouter = require('./routes/api');
const pagesRouter = require('./routes/pages');

function createApp() {
  const app = express();

  // 反向代理（Nginx / Caddy / Cloudflare）后需要开启，才能拿到真实 IP 与协议。
  // trustProxy 为可信代理层数（TRUST_PROXY=true 视为 1 层），req.ip 由 Express
  // 按跳数从右往左解析，客户端伪造 X-Forwarded-For 左段无法绕过限流。
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);
  app.disable('etag');
  app.disable('x-powered-by');

  app.use(securityHeaders);
  app.use(cors);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // 全局身份识别：解析 Token 但不拦截，后续中间件按需判断 req.isAdmin
  app.use(authenticate);

  // API（同时提供 /api 与 /api/v1，方便版本化接入）。
  // 实现为「/api 单次挂载 + fallthrough 后接 /v1 别名」：此前两条独立挂载
  // 会让 /api/v1 请求被 apiLimiter 双计；而 use(['/api','/api/v1']) 数组写法
  // 在 Express 4 下 fallthrough 不会回退尝试第二个前缀，/api/v1 会直接 404。
  const apiV1Alias = express.Router();
  apiV1Alias.use('/v1', apiRouter); // 别名挂在 '/api' 之下，此处剥掉 '/v1' 前缀
  app.use('/api', apiLimiter(), apiRouter, apiV1Alias);

  // 图片资源与页面
  app.use(pagesRouter);

  // 前端静态资源。
  // 缓存策略：HTML / JS / CSS 一律 no-cache（浏览器可存副本但每次必须带 ETag 协商，
  // 未变化时 304，开销可忽略）。本项目无构建、文件名无内容 hash，若用长 max-age，
  // 发版后必然出现「新 HTML + 旧 JS/CSS」的断层窗口（管理台初始化直接报错），
  // 且源站的 max-age 会被 Cloudflare 的 Browser Cache TTL 覆盖放大——v1.6.0 上线时
  // 线上就因此断了近 5 小时。图片直链 /i/ /t/ 的 immutable 长缓存走 pages.js，不受影响。
  const NO_CACHE = 'no-cache';
  app.use(
    express.static(config.publicDir, {
      setHeaders(res, filePath) {
        const ext = path.extname(filePath).toLowerCase();
        if (ext === '.html' || ext === '.js' || ext === '.css') res.setHeader('Cache-Control', NO_CACHE);
      },
      extensions: ['html'],
      index: 'index.html',
    }),
  );

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
