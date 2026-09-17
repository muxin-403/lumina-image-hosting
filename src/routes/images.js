'use strict';

/**
 * 图片管理接口
 *   GET    /api/images              列表（管理员，支持分页/搜索/筛选/排序）
 *   GET    /api/images/:id          单张元数据（公开，用于程序化查询直链）
 *   DELETE /api/images/:id          删除（管理员）
 *   POST   /api/images/batch-delete 批量删除（管理员）
 *   GET    /api/stats               站点统计（管理员）
 */

const express = require('express');
const { Images } = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/error');
const { toDTO, deleteImage, baseUrlOf } = require('../services/uploader');
const { ApiError, ok } = require('../utils');

const router = express.Router();

const ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

function assertId(id) {
  if (!ID_RE.test(id)) throw new ApiError(400, `非法的图片 ID：${id}`, 'BAD_ID');
}

/* ------------------------------- 统计 ------------------------------- */

router.get(
  '/stats',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const s = Images.stats();
    return ok(res, {
      ...s,
      total_human: human(s.totalBytes),
      today_bytes_human: human(s.todayBytes),
    });
  }),
);

/* ------------------------------- 列表 ------------------------------- */

router.get(
  '/',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { page, limit, q, uploader, ext, order } = req.query;
    const result = Images.list({ page, limit, keyword: q, uploader, ext, order });
    const base = baseUrlOf(req);
    return ok(
      res,
      result.items.map((row) => toDTO(row, base)),
      {
        pagination: {
          page: result.page,
          limit: result.limit,
          total: result.total,
          pages: result.pages,
          has_next: result.page < result.pages,
          has_prev: result.page > 1,
        },
      },
    );
  }),
);

/* ----------------------------- 批量删除 ----------------------------- */

router.post(
  '/batch-delete',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const ids = (req.body && req.body.ids) || [];
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new ApiError(400, '请提供 ids 数组', 'MISSING_IDS');
    }
    if (ids.length > 200) throw new ApiError(400, '单次最多删除 200 张', 'TOO_MANY_IDS');

    const deleted = [];
    const failed = [];
    for (const id of ids) {
      try {
        assertId(String(id));
        deleted.push(await deleteImage(String(id)));
      } catch (err) {
        failed.push({ id, message: err.message });
      }
    }
    return ok(res, { deleted: deleted.map((d) => d.id), failed, requested: ids.length });
  }),
);

/* ----------------------------- 单张查询 ----------------------------- */

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    assertId(id);
    const row = Images.get(id);
    if (!row) throw new ApiError(404, `图片不存在：${id}`, 'IMAGE_NOT_FOUND');
    return ok(res, toDTO(row, baseUrlOf(req)));
  }),
);

/* ------------------------------ 删除 ------------------------------- */

router.delete(
  '/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    assertId(id);
    const result = await deleteImage(id, { hard: req.query.hard === '1' });
    return ok(res, { ...result, message: '删除成功' });
  }),
);

/* ------------------------------ 工具 ------------------------------- */

function human(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${i === 0 ? n : n.toFixed(2)} ${units[i]}`;
}

module.exports = router;
