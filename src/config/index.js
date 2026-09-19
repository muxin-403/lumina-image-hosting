'use strict';

/**
 * 配置加载模块
 * ------------------------------------------------------------------
 * 优先级：数据库 settings 表（运行时可改） > 环境变量 / .env > 内置默认值
 * 本文件只负责“环境变量层”的解析与默认值，持久化层的覆盖逻辑在
 * src/services/settings.js 中实现。
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// 项目根目录（src/config/index.js -> ../../）
const ROOT_DIR = path.resolve(__dirname, '..', '..');

// 加载 .env（不存在则静默跳过）
try {
  require('dotenv').config({ path: path.join(ROOT_DIR, '.env') });
} catch (_) {
  /* dotenv 未安装或 .env 不存在时忽略 */
}

/* ------------------------------- 工具函数 ------------------------------- */

function env(key, fallback = '') {
  const v = process.env[key];
  return v === undefined || v === null || v === '' ? fallback : v;
}

function envBool(key, fallback = false) {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on', 'y'].includes(String(v).trim().toLowerCase());
}

/** 支持 "20mb" / "512kb" / "1048576" 三种写法 */
function envSize(key, fallbackBytes) {
  const raw = process.env[key];
  if (!raw) return fallbackBytes;
  const m = String(raw).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/);
  if (!m) return fallbackBytes;
  const n = parseFloat(m[1]);
  const unit = m[2] || 'b';
  const mul = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[unit];
  return Math.round(n * mul);
}

function envInt(key, fallback) {
  const n = parseInt(process.env[key], 10);
  return Number.isFinite(n) ? n : fallback;
}

function envList(key, fallback) {
  const raw = process.env[key];
  if (!raw) return fallback;
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function stripEndSlash(u) {
  return String(u || '').replace(/\/+$/, '');
}

/* ------------------------------ 目录与密钥 ------------------------------ */

const DATA_DIR = path.resolve(ROOT_DIR, env('DATA_DIR', 'data'));
const STORAGE_DIR = path.resolve(ROOT_DIR, env('STORAGE_DIR', 'storage'));
const THUMB_DIR = path.join(STORAGE_DIR, '_thumbs');

for (const dir of [DATA_DIR, STORAGE_DIR, THUMB_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * 会话签名密钥：
 * 1) 优先读环境变量 SESSION_SECRET；
 * 2) 否则在 data/.secret 中持久化一份随机密钥（重启后已签发的 Token 依然有效）。
 */
function resolveSecret() {
  const fromEnv = env('SESSION_SECRET');
  if (fromEnv) return fromEnv;
  const secretFile = path.join(DATA_DIR, '.secret');
  try {
    if (fs.existsSync(secretFile)) {
      const s = fs.readFileSync(secretFile, 'utf8').trim();
      if (s.length >= 32) return s;
    }
    const generated = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(secretFile, generated, { mode: 0o600 });
    return generated;
  } catch (_) {
    // 极端情况下（只读文件系统）退化为进程内随机密钥
    return crypto.randomBytes(48).toString('hex');
  }
}

/* ------------------------------- 导出配置 ------------------------------- */

const config = {
  rootDir: ROOT_DIR,
  env: env('NODE_ENV', 'development'),
  isProd: env('NODE_ENV', 'development') === 'production',

  // --- 服务 ---
  host: env('HOST', '0.0.0.0'),
  port: envInt('PORT', 3000),
  trustProxy: envBool('TRUST_PROXY', false),
  siteName: env('SITE_NAME', 'Lumina 图床'),
  /** 对外可访问的基础地址，留空则按请求头自动推断（反代场景建议显式配置） */
  publicBaseUrl: stripEndSlash(env('PUBLIC_BASE_URL', '')),
  sessionSecret: resolveSecret(),
  /** 管理员 Token 有效期（秒），默认 7 天 */
  tokenTtl: envInt('TOKEN_TTL', 7 * 24 * 3600),
  /** 管理台登录会话 Cookie 名 */
  cookieName: env('COOKIE_NAME', 'lumina_token'),

  // --- 路径 ---
  dataDir: DATA_DIR,
  storageDir: STORAGE_DIR,
  thumbDir: THUMB_DIR,
  dbPath: path.resolve(ROOT_DIR, env('DB_PATH', path.join('data', 'lumina.db'))),
  publicDir: path.join(ROOT_DIR, 'public'),

  /** 相同内容秒传（按 sha256 去重，避免重复占用空间） */
  dedupe: envBool('DEDUPE', true),

  // --- 管理员（首次启动时用于初始化密码哈希，之后以数据库为准） ---
  adminUser: env('ADMIN_USER', 'admin'),
  adminPassword: env('ADMIN_PASSWORD', ''),

  // --- 上传限制 ---
  /** 管理员单文件上限（默认 20MB） */
  maxFileSize: envSize('MAX_FILE_SIZE', 20 * 1024 * 1024),
  /** 一次请求最多文件数（默认 20） */
  maxFiles: envInt('MAX_FILES', 20),
  /** 是否允许游客上传 */
  guestUploadEnabled: envBool('GUEST_UPLOAD_ENABLED', true),
  /** 游客单文件上限（默认 5MB） */
  guestMaxFileSize: envSize('GUEST_MAX_FILE_SIZE', 5 * 1024 * 1024),
  /** 允许的格式（扩展名） */
  allowedFormats: envList('ALLOWED_FORMATS', [
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'avif',
  ]),

  // --- 客户端上传行为（可在管理台热更新，前端不再展示这些开关） ---
  /** 浏览器端把 JPG/PNG/BMP 转成 WebP（默认开启，服务端零算力开销） */
  clientConvertWebp: envBool('CLIENT_CONVERT_WEBP', true),
  /** 浏览器端按质量参数做有损压缩（默认关闭：仅转格式，质量按 100 处理） */
  clientCompress: envBool('CLIENT_COMPRESS', false),
  /** 开启客户端压缩时的 WebP 质量（40–100） */
  clientWebpQuality: envInt('CLIENT_WEBP_QUALITY', 82),
  /** 浏览器端批量上传的最大并发数（1–6；HTTP/1.1 下浏览器对同域并发连接上限约 6，设更高只会排队） */
  clientMaxConcurrency: envInt('CLIENT_MAX_CONCURRENCY', 3),
  /** 上传完成后自动复制最后一张图的直链 */
  autoCopyUrl: envBool('AUTO_COPY_URL', false),

  // --- 图像处理 ---
  /** 对静态位图做无损/有损再压缩（动态图与 SVG 走独立分支） */
  optimize: envBool('OPTIMIZE', true),
  optimizeQuality: envInt('OPTIMIZE_QUALITY', 82),
  /** 超过该宽度的静态图会被等比缩小 */
  maxWidth: envInt('MAX_WIDTH', 4096),
  maxHeight: envInt('MAX_HEIGHT', 4096),
  /** 缩略图宽度 */
  thumbnailWidth: envInt('THUMBNAIL_WIDTH', 480),
  /** SVG 精简（去除注释 / XML 声明 / 冗余空白） */
  svgMinify: envBool('SVG_MINIFY', true),
  /** SVG 栅格化时的渲染密度，越高越清晰、越慢 */
  svgDensity: envInt('SVG_DENSITY', 200),

  // --- 存储驱动 ---
  /** local | webdav */
  storageDriver: env('STORAGE_DRIVER', 'local').toLowerCase(),
  localPublicPrefix: env('LOCAL_PUBLIC_PREFIX', '/i'),
  webdav: {
    url: stripEndSlash(env('WEBDAV_URL', '')),
    username: env('WEBDAV_USERNAME', ''),
    password: env('WEBDAV_PASSWORD', ''),
    directory: env('WEBDAV_DIRECTORY', 'lumina').replace(/^\/+|\/+$/g, ''),
    /** 已废弃（仅保留兼容）：直链统一由本站 /i/<key> 代理路由提供 */
    publicUrl: stripEndSlash(env('WEBDAV_PUBLIC_URL', '')),
    timeout: envInt('WEBDAV_TIMEOUT', 30000),
  },

  // --- 安全 / 限流 ---
  rateLimit: {
    windowMs: envInt('RATE_LIMIT_WINDOW_MS', 60_000),
    /** 单 IP 窗口内最大上传次数 */
    uploadMax: envInt('RATE_LIMIT_UPLOAD_MAX', 60),
    /** 单 IP 窗口内最大登录尝试次数 */
    loginMax: envInt('RATE_LIMIT_LOGIN_MAX', 10),
    /** 单 IP 窗口内最大通用 API 请求数 */
    apiMax: envInt('RATE_LIMIT_API_MAX', 600),
  },

  // --- CORS：允许的 Origin 列表，["*"] 表示放开 ---
  corsOrigins: envList('CORS_ORIGINS', ['*']),
};

module.exports = config;
module.exports.envSize = envSize;
module.exports.envBool = envBool;
module.exports.envInt = envInt;
