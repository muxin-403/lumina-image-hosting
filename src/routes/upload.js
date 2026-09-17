'use strict';

/**
 * 上传接口
 *   POST /api/upload        单张 / 多张（字段名 file 或 files，可重复）
 *   GET  /api/upload/limits 查询当前身份的限额（前端预校验用）
 *
 * 权限：游客可上传（受 GUEST_UPLOAD_ENABLED + guest_max_file_size 限制），
 *       管理员携带 Token 后不受游客限额约束。
 */

const express = require('express');
const { receiveFiles } = require('../middleware/upload');
const { requireUploadPermission } = require('../middleware/auth');
const { uploadLimiter } = require('../middleware/rateLimit');
const { asyncHandler } = require('../middleware/error');
const { storeFile } = require('../services/uploader');
const { settings } = require('../services/settings');
const { ApiError, ok, humanSize } = require('../utils');

const router = express.Router();

router.get('/limits', (req, res) =>
  ok(res, {
    identity: req.isAdmin ? 'admin' : 'guest',
    guest_upload_enabled: !!settings.get('guest_upload_enabled'),
    max_file_size: Number(req.isAdmin ? settings.get('max_file_size') : settings.get('guest_max_file_size')),
    max_file_size_human: humanSize(
      Number(req.isAdmin ? settings.get('max_file_size') : settings.get('guest_max_file_size')),
    ),
    max_files: Number(settings.get('max_files')),
    allowed_formats: settings.get('allowed_formats'),
  }),
);

router.post(
  '/',
  uploadLimiter(),
  requireUploadPermission,
  receiveFiles({ field: 'any' }),
  asyncHandler(async (req, res) => {
    const files = req.files || [];
    const results = [];
    const errors = [];

    for (const file of files) {
      try {
        const { dto, duplicated, optimized } = await storeFile({
          file,
          isAdmin: req.isAdmin,
          clientIp: req.clientIp,
          ua: req.get('user-agent') || '',
          req,
        });
        results.push({
          ...dto,
          duplicated,
          compression: {
            original_size: optimized.rawSize,
            final_size: optimized.finalSize,
            saved_bytes: Math.max(0, optimized.rawSize - optimized.finalSize),
            saved_percent:
              optimized.rawSize > 0
                ? Number((((optimized.rawSize - optimized.finalSize) / optimized.rawSize) * 100).toFixed(1))
                : 0,
            note: optimized.note,
          },
        });
      } catch (err) {
        errors.push({
          filename: file.originalname,
          code: err.code || 'PROCESS_FAILED',
          message: err.message,
        });
        if (!err.status) throw err; // 非业务异常直接向上抛（触发 500 与日志）
      }
    }

    if (results.length === 0) {
      throw new ApiError(
        errors.length ? 422 : 400,
        errors.length ? errors[0].message : '上传失败',
        errors.length ? errors[0].code : 'UPLOAD_FAILED',
        );
    }

    return res.json({
      success: true,
      data: results.length === 1 ? results[0] : results,
      uploaded: results.length,
      failed: errors.length,
      errors,
    });
  }),
);

module.exports = router;
