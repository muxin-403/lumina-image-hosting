'use strict';

/**
 * API 总装配（挂载到 /api 与 /api/v1 两套前缀，便于版本化演进）
 */

const express = require('express');
const config = require('../config');
const { Images } = require('../db');
const { settings } = require('../services/settings');
const { storageManager } = require('../services/settings');
const { ok } = require('../utils');
const { asyncHandler } = require('../middleware/error');

const authRouter = require('./auth');
const uploadRouter = require('./upload');
const imagesRouter = require('./images');
const settingsRouter = require('./settings');

const router = express.Router();

/** 健康检查 / 版本信息 */
router.get(
  '/health',
  asyncHandler(async (req, res) => {
    const storage = storageManager.get();
    return ok(res, {
      status: 'ok',
      service: 'lumina-image-hosting',
      version: require('../../package.json').version,
      node: process.version,
      uptime_seconds: Math.round(process.uptime()),
      storage_driver: storage.name,
      images: Images.stats().total,
      time: new Date().toISOString(),
    });
  }),
);

/** 公开配置（前端启动时拉取） */
router.get('/config', (req, res) => ok(res, settings.publicConfig()));

router.use('/auth', authRouter);
router.use('/upload', uploadRouter);
router.use('/images', imagesRouter);
router.use('/', settingsRouter);

module.exports = router;
