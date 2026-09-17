'use strict';

/**
 * 配置与存储接口
 *   GET   /api/config           公开配置（前端渲染用，无敏感信息）
 *   GET   /api/settings         完整配置（管理员）
 *   PATCH /api/settings         更新配置（管理员，即时生效，无需重启）
 *   DELETE /api/settings/:key   恢复某项为 .env / 默认值（管理员）
 *   GET   /api/storage/health   存储驱动健康检查（管理员）
 */

const express = require('express');
const { settings, storageManager, DEFAULTS } = require('../services/settings');
const { requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/error');
const { ApiError, ok, humanSize } = require('../utils');

const router = express.Router();

/** 可被 PATCH 的字段及类型校验规则 */
const SCHEMA = {
  site_name: { type: 'string', max: 60 },
  guest_upload_enabled: { type: 'boolean' },
  guest_max_file_size: { type: 'size', min: 1024, max: 1024 * 1024 * 1024 },
  max_file_size: { type: 'size', min: 1024, max: 5 * 1024 * 1024 * 1024 },
  max_files: { type: 'int', min: 1, max: 100 },
  storage_driver: { type: 'enum', values: ['local', 'webdav', 'hybrid'] },
  optimize: { type: 'boolean' },
  dedupe: { type: 'boolean' },
  optimize_quality: { type: 'int', min: 30, max: 100 },
  thumbnail_width: { type: 'int', min: 64, max: 2000 },
  allowed_formats: { type: 'stringArray', max: 20 },
  webdav_url: { type: 'string', max: 500 },
  webdav_username: { type: 'string', max: 200 },
  webdav_password: { type: 'string', max: 200 },
  webdav_directory: { type: 'string', max: 100 },
  webdav_public_url: { type: 'string', max: 500 },
};

function coerce(key, value) {
  const rule = SCHEMA[key];
  if (!rule) throw new ApiError(400, `不支持的配置项：${key}`, 'UNKNOWN_SETTING');

  switch (rule.type) {
    case 'boolean':
      if (typeof value === 'boolean') return value;
      return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
    case 'int':
    case 'size': {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new ApiError(400, `${key} 必须是数字`, 'BAD_VALUE');
      if (rule.min !== undefined && n < rule.min) throw new ApiError(400, `${key} 不能小于 ${rule.min}`, 'BAD_VALUE');
      if (rule.max !== undefined && n > rule.max) throw new ApiError(400, `${key} 不能大于 ${rule.max}`, 'BAD_VALUE');
      return Math.round(n);
    }
    case 'enum':
      if (!rule.values.includes(String(value))) {
        throw new ApiError(400, `${key} 只能是 ${rule.values.join(' / ')}`, 'BAD_VALUE');
      }
      return String(value);
    case 'stringArray': {
      const arr = Array.isArray(value)
        ? value
        : String(value).split(',').map((s) => s.trim()).filter(Boolean);
      return arr.slice(0, rule.max).map((s) => String(s).toLowerCase());
    }
    default: {
      const s = String(value);
      if (rule.max && s.length > rule.max) throw new ApiError(400, `${key} 过长`, 'BAD_VALUE');
      return s;
    }
  }
}

/* ----------------------------- 公开配置 ----------------------------- */

router.get('/config', (req, res) => ok(res, settings.publicConfig()));

/* ----------------------------- 管理配置 ----------------------------- */

router.get(
  '/settings',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const cfg = settings.adminConfig();
    return ok(res, {
      ...cfg,
      spec: {
        max_file_size_human: humanSize(cfg.max_file_size),
        guest_max_file_size_human: humanSize(cfg.guest_max_file_size),
        editable_keys: Object.keys(SCHEMA),
      },
    });
  }),
);

router.patch(
  '/settings',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const patch = {};
    for (const [key, value] of Object.entries(body)) {
      // 空字符串表示「不修改该字段」，避免前端把未填写的 WebDAV 密码清空
      if (value === '' || value === undefined || value === null) continue;
      patch[key] = coerce(key, value);
    }
    if (Object.keys(patch).length === 0) {
      throw new ApiError(400, '没有可更新的字段', 'NOTHING_TO_UPDATE');
    }

    settings.setMany(patch);
    storageManager.invalidate(); // 强制下次请求按新配置重建存储实例

    const warnings = [];
    if (patch.storage_driver && patch.storage_driver !== 'local') {
      const health = await storageManager.get().health();
      for (const h of health) if (!h.ok) warnings.push(`${h.driver}: ${h.message}`);
    }

    return ok(res, { updated: Object.keys(patch), config: settings.adminConfig(), warnings });
  }),
);

router.delete(
  '/settings/:key',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { key } = req.params;
    if (!(key in DEFAULTS)) throw new ApiError(400, `不支持的配置项：${key}`, 'UNKNOWN_SETTING');
    settings.reset(key);
    return ok(res, { key, value: settings.get(key), message: '已恢复为环境变量 / 默认值' });
  }),
);

/* ----------------------------- 存储自检 ----------------------------- */

router.get(
  '/storage/health',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const storage = storageManager.get();
    const detail = await storage.health();
    return ok(res, {
      mode: storage.name,
      drivers: detail,
      ok: detail.every((d) => d.ok),
      local_root: require('../config').storageDir,
    });
  }),
);

module.exports = router;
