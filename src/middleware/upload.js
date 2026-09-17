'use strict';

/**
 * 文件接收中间件（Multer）
 * ------------------------------------------------------------------
 * 关键点：单文件大小上限是「按身份动态计算」的
 *   - 管理员：max_file_size
 *   - 游客：guest_max_file_size（可在管理台实时调整）
 * 因此每个请求现场构造 multer 实例，避免进程启动时把限额写死。
 *
 * 使用内存存储（memoryStorage）：图片普遍在几 MB 级别，
 * 交给 sharp 处理后再落盘，可以避免产生垃圾临时文件。
 */

const multer = require('multer');
const { settings } = require('../services/settings');
const { ApiError, humanSize } = require('../utils');

const memory = multer.memoryStorage();

/** 把 multer 的 LIMIT_* 错误翻译成人话 */
function mapMulterError(err, ctx) {
  const who = ctx.isAdmin ? '管理员' : '游客';
  switch (err.code) {
    case 'LIMIT_FILE_SIZE':
      return new ApiError(
        413,
        `文件超过${who}单文件上限 ${humanSize(ctx.maxSize)}` +
          (ctx.isAdmin ? '' : '（游客限额可在后台调整，或登录管理员账号）'),
        'FILE_TOO_LARGE',
      );
    case 'LIMIT_FILE_COUNT':
      return new ApiError(413, `单次最多上传 ${ctx.maxFiles} 个文件`, 'TOO_MANY_FILES');
    case 'LIMIT_UNEXPECTED_FILE':
      return new ApiError(400, `非预期的文件字段：${err.field}（请使用 file / files）`, 'UNEXPECTED_FIELD');
    default:
      return new ApiError(400, `文件接收失败：${err.message}`, 'UPLOAD_ERROR');
  }
}

/**
 * Express 中间件：解析 multipart/form-data，结果挂在 req.files
 * @param {object} opt { field: 'any' | 字段名 }
 */
function receiveFiles(opt = {}) {
  const field = opt.field || 'any';
  return function uploader(req, res, next) {
    const maxSize = Number(
      req.isAdmin ? settings.get('max_file_size') : settings.get('guest_max_file_size'),
    );
    const maxFiles = Math.max(1, Number(settings.get('max_files')) || 20);

    const instance = multer({
      storage: memory,
      limits: {
        fileSize: Number.isFinite(maxSize) && maxSize > 0 ? maxSize : 20 * 1024 * 1024,
        files: maxFiles,
        fields: 30,
        parts: maxFiles + 30,
      },
    });

    const handler = field === 'any' ? instance.any() : instance.array(field, maxFiles);

    handler(req, res, (err) => {
      if (err) return next(mapMulterError(err, { maxSize, maxFiles, isAdmin: !!req.isAdmin }));
      if (!req.files || req.files.length === 0) {
        return next(new ApiError(400, '未接收到任何文件（字段名请使用 file 或 files）', 'NO_FILE'));
      }
      next();
    });
  };
}

module.exports = { receiveFiles, mapMulterError };
