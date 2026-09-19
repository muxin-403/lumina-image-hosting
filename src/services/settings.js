'use strict';

/**
 * 运行时配置中心
 * ------------------------------------------------------------------
 * 可热更新的配置项统一从这里读取：
 *   数据库 settings 表（管理台写入） > .env > 代码默认值
 * 好处：改游客限额 / 切换存储驱动不需要重启进程。
 */

const crypto = require('crypto');
const config = require('../config');
const { Settings } = require('../db');
const { logger } = require('../utils');
const faviconService = require('./favicon');

/** 可按 key 前缀热更新的配置白名单及默认值（取自 .env） */
const DEFAULTS = {
  site_name: config.siteName,
  guest_upload_enabled: config.guestUploadEnabled,
  guest_max_file_size: config.guestMaxFileSize,
  max_file_size: config.maxFileSize,
  max_files: config.maxFiles,
  storage_driver: config.storageDriver,
  client_convert_webp: config.clientConvertWebp,
  client_compress: config.clientCompress,
  client_webp_quality: config.clientWebpQuality,
  client_max_concurrency: config.clientMaxConcurrency,
  auto_copy_url: config.autoCopyUrl,
  optimize: config.optimize,
  optimize_quality: config.optimizeQuality,
  thumbnail_width: config.thumbnailWidth,
  allowed_formats: config.allowedFormats,
  dedupe: config.dedupe,
  webdav_url: config.webdav.url,
  webdav_username: config.webdav.username,
  webdav_password: config.webdav.password,
  webdav_directory: config.webdav.directory,
  webdav_public_url: config.webdav.publicUrl,
};

/** 密码哈希：scrypt + 随机盐（Node 内置，无第三方依赖） */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, hash] = parts;
  try {
    const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
    // 定长比较，避免时序侧信道
    const a = Buffer.from(derived, 'hex');
    const b = Buffer.from(hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (_) {
    return false;
  }
}

const settings = {
  /** 读取单项（DB 优先，回落到 .env 默认值） */
  get(key) {
    const stored = Settings.get(key);
    if (stored !== undefined && stored !== null && stored !== '') return stored;
    return DEFAULTS[key];
  },

  /** 读取多项 */
  pick(keys) {
    const out = {};
    for (const k of keys) out[k] = this.get(k);
    return out;
  },

  /** 写入并热更新 */
  set(key, value) {
    if (!(key in DEFAULTS)) return false;
    Settings.set(key, value);
    logger.info(`配置已更新 ${key} = ${JSON.stringify(value)}`);
    if (key.startsWith('webdav_') || key === 'storage_driver') storageManager.invalidate();
    return true;
  },

  setMany(obj) {
    for (const [k, v] of Object.entries(obj || {})) this.set(k, v);
    return this.publicConfig();
  },

  reset(key) {
    Settings.del(key);
    storageManager.invalidate();
  },

  /** 管理员密码哈希存取 */
  getPasswordHash() {
    return Settings.get('admin_password_hash');
  },
  setPassword(plain) {
    const hash = hashPassword(plain);
    Settings.set('admin_password_hash', hash);
    return hash;
  },
  verifyPassword(plain) {
    return verifyPassword(plain, this.getPasswordHash());
  },

  /** 是否仍在使用默认/初始密码（用于前端提示） */
  usingDefaultPassword() {
    return !this.getPasswordHash();
  },

  /** 对外暴露的公开配置（不含任何敏感字段） */
  publicConfig() {
    const webdavConfigured = !!(this.get('webdav_url') && this.get('webdav_username'));
    return {
      site_name: this.get('site_name'),
      guest_upload_enabled: !!this.get('guest_upload_enabled'),
      guest_max_file_size: Number(this.get('guest_max_file_size')),
      max_file_size: Number(this.get('max_file_size')),
      max_files: Number(this.get('max_files')),
      allowed_formats: this.get('allowed_formats') || [],
      client_convert_webp: !!this.get('client_convert_webp'),
      client_compress: !!this.get('client_compress'),
      client_webp_quality: Number(this.get('client_webp_quality')),
      client_max_concurrency: Number(this.get('client_max_concurrency')),
      auto_copy_url: !!this.get('auto_copy_url'),
      thumbnail_width: Number(this.get('thumbnail_width')),
      storage_driver: this.get('storage_driver'),
      webdav_configured: webdavConfigured,
      /** 站点图标地址（自定义时带版本号破缓存；未设置时回落默认图标） */
      favicon_url: faviconService.publicUrl(),
    };
  },

  /** 管理台可见的完整配置（隐藏关键凭据） */
  adminConfig() {
    const favicon = faviconService.current();
    return {
      ...this.publicConfig(),
      favicon_set: !!favicon,
      favicon_ext: favicon ? favicon.ext : '',
      optimize: !!this.get('optimize'),
      optimize_quality: Number(this.get('optimize_quality')),
      webdav_url: this.get('webdav_url') || '',
      webdav_username: this.get('webdav_username') || '',
      webdav_password_set: !!this.get('webdav_password'),
      webdav_directory: this.get('webdav_directory') || '',
      webdav_public_url: this.get('webdav_public_url') || '',
      default_password: this.usingDefaultPassword(),
    };
  },
};

/** 懒加载 + 可失效的存储管理器（避免循环依赖，见 services/storage/index.js） */
const storageManager = {
  _mod: null,
  _instance: null,
  get() {
    if (!this._mod) this._mod = require('./storage');
    if (!this._instance) this._instance = this._mod.createStorage();
    return this._instance;
  },
  invalidate() {
    this._instance = null;
  },
};

module.exports = { settings, hashPassword, verifyPassword, storageManager, DEFAULTS };
