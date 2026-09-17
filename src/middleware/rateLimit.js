'use strict';

/**
 * 极简内存滑动窗口限流器（无第三方依赖）
 * ------------------------------------------------------------------
 * 单实例部署足够；多实例场景建议前置 Nginx / 网关做统一限流，
 * 或把计数下沉到 Redis（本实现刻意保持零依赖，便于开箱即用）。
 */

const config = require('../config');
const { ApiError } = require('../utils');
const { getClientIp } = require('./auth');

const buckets = new Map(); // key -> number[] 命中时间戳列表

// 定期清理过期桶，防止长期运行内存膨胀
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, list] of buckets) {
    const alive = list.filter((t) => now - t < 30 * 60_000);
    if (alive.length === 0) buckets.delete(key);
    else buckets.set(key, alive);
  }
}, 5 * 60_000);
if (sweeper.unref) sweeper.unref();

/**
 * @param {string} scope  限流维度名（upload / login / api ...）
 * @param {number} max    窗口内最大请求数
 * @param {number} windowMs 窗口长度
 */
function rateLimit(scope, max, windowMs = config.rateLimit.windowMs) {
  return function limiter(req, res, next) {
    if (!max || max <= 0) return next(); // 0 / 负数表示关闭限流

    const ip = req.clientIp || getClientIp(req) || 'unknown';
    const key = `${scope}:${ip}`;
    const now = Date.now();

    const list = (buckets.get(key) || []).filter((t) => now - t < windowMs);
    if (list.length >= max) {
      const retryAfter = Math.ceil((windowMs - (now - list[0])) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', '0');
      return next(
        new ApiError(429, `请求过于频繁，请 ${retryAfter} 秒后重试`, 'RATE_LIMITED'),
      );
    }

    list.push(now);
    buckets.set(key, list);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - list.length)));
    next();
  };
}

const uploadLimiter = () => rateLimit('upload', config.rateLimit.uploadMax);
const loginLimiter = () => rateLimit('login', config.rateLimit.loginMax);
const apiLimiter = () => rateLimit('api', config.rateLimit.apiMax);

module.exports = { rateLimit, uploadLimiter, loginLimiter, apiLimiter, buckets };
