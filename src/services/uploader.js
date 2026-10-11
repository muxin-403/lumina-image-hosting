'use strict';

/**
 * 上传编排 + 资源序列化
 * ------------------------------------------------------------------
 * 把「图像处理」与「存储驱动」串起来，并负责：
 *   - 秒传（相同 sha256 直接复用已有记录，不重复占用空间）
 *   - 缩略图落本地
 *   - 生成多格式引用文本（直链 / HTML / Markdown / BBCode / 缩略图）
 */

const fsp = require('fs/promises');
const path = require('path');
const config = require('../config');
const { Images } = require('../db');
const { settings, storageManager } = require('./settings');
const { processImage } = require('./image');
const { shortId, dateShard, safeBaseName, ApiError, logger } = require('../utils');
const { computeDeleteKey } = require('../utils/deleteKey');

/** 存储路径：yyyy/mm/<id>.<ext> */
function buildKey(id, ext, date = new Date()) {
  return `${dateShard(date)}/${id}.${ext}`;
}

/** 缩略图路径：yyyy/mm/<id>.webp（恒存本地 storage/_thumbs） */
function buildThumbKey(id, date = new Date()) {
  return `${dateShard(date)}/${id}.webp`;
}

/** 站点基础地址：显式配置优先，否则按请求头推断 */
function baseUrlOf(req) {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

/**
 * 序列化一条图片记录 -> 客户端可用的 DTO
 * @param {object} row  images 表行
 * @param {string} base 站点基础地址
 */
function toDTO(row, base) {
  if (!row) return null;

  const storage = storageManager.get();

  // 直链：由存储驱动按当前模式计算（local / webdav / hybrid 统一入口）
  const url = storage.url(row.storage_key, base);

  const pageUrl = `${base}/img/${row.id}`;
  const thumbUrl = `${base}/t/${row.id}`;
  const name = row.original_name || `${row.id}.${row.ext}`;

  return {
    id: row.id,
    filename: name,
    ext: row.ext,
    mime: row.mime,
    size: row.size,
    size_human: humanize(row.size),
    width: row.width,
    height: row.height,
    pages: row.pages,
    animated: !!row.animated,
    vector: !!row.vector,
    storage_driver: row.storage_driver,
    uploader: row.uploader,
    created_at: row.created_at,
    created_at_text: new Date(row.created_at).toISOString(),

    url,                       // 图片直链
    page_url: pageUrl,         // 详情页
    thumb_url: thumbUrl,       // 缩略图直链

    // 开箱即用的多格式引用文本
    formats: {
      url,
      thumbnail: thumbUrl,
      html: `<img src="${url}" alt="${escapeAttr(name)}" />`,
      html_thumb: `<a href="${url}" target="_blank"><img src="${thumbUrl}" alt="${escapeAttr(name)}" /></a>`,
      markdown: `![${escapeMd(name)}](${url})`,
      markdown_thumb: `[![${escapeMd(name)}](${thumbUrl})](${url})`,
      bbcode: `[img]${url}[/img]`,
      bbcode_thumb: `[url=${url}][img]${thumbUrl}[/img][/url]`,
    },
  };
}

function humanize(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${i === 0 ? n : n.toFixed(2)} ${units[i]}`;
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
function escapeMd(s) {
  return String(s).replace(/[[\]]/g, '');
}

/**
 * 处理并保存一个上传文件
 * @param {object} opt { file(multer file), isAdmin, clientIp, ua, req }
 */
async function storeFile({ file, isAdmin, clientIp = '', ua = '', req }) {
  const base = baseUrlOf(req);
  const storage = storageManager.get();

  // 服务端分阶段耗时（探测/优化/缩略图由 processImage 内部计量），
  // 只并入上传日志，不落库、不改接口响应 —— 供性能基线测量归因使用
  const timings = {};

  const processStart = Date.now();
  const result = await processImage(file.buffer, {
    allowedFormats: settings.get('allowed_formats'),
    optimize: !!settings.get('optimize'),
    quality: Number(settings.get('optimize_quality')) || 82,
    maxWidth: config.maxWidth,
    maxHeight: config.maxHeight,
    thumbnailWidth: Number(settings.get('thumbnail_width')) || 480,
    svgMinify: config.svgMinify,
    // 动画 GIF → 动画 WebP 无法在浏览器完成（canvas 只能编码单帧），
    // 复用「客户端转 WebP」开关作为站点级转 WebP 策略，由服务端代做
    convertAnimatedGif: !!settings.get('client_convert_webp'),
  });
  timings.processMs = Date.now() - processStart;

  // ---- 秒传：同内容不重复存储（可用 DEDUPE=0 关闭） ----
  // 必须走运行时配置门面（DB > .env > 默认值）：直读 DB 层会让仅通过
  // .env 配置 DEDUPE=0 的部署静默失效（DB 无记录时 undefined !== false 恒真）
  const dedupe = settings.get('dedupe');
  if (dedupe !== false) {
    const dedupeStart = Date.now();
    const exist = Images.findBySha(result.sha256);
    timings.dedupeMs = Date.now() - dedupeStart;
    if (exist) {
      logger.info(`命中秒传 ${exist.id} <- ${file.originalname}`, { timings: { ...result.timings, ...timings } });
      // 秒传复用的是别人先创建的记录，因此不下发删除凭证：
      // 否则后上传者就能凭凭证删掉先上传者的图片
      return { dto: { ...toDTO(exist, base), delete_key: null }, duplicated: true, optimized: result };
    }
  }

  const now = new Date();

  // 写主存储 → 缩略图 → 落库。
  // 短 ID 主键碰撞（概率 ~54^-10）一旦发生会让已写入磁盘的文件成为无 DB 引用的孤儿：
  // 落库失败时回收本次已写文件并换新 ID 重试一次。
  const persistOnce = async () => {
    const attemptId = shortId(10);
    const attemptKey = buildKey(attemptId, result.ext, now);
    const attemptThumbKey = buildThumbKey(attemptId, now);

    const storeStart = Date.now();
    const putResult = await storage.put(attemptKey, result.buffer, result.mime);
    timings.storeMs = (timings.storeMs || 0) + (Date.now() - storeStart);

    let savedThumb = null;
    if (result.thumbBuffer) {
      try {
        const abs = path.join(config.thumbDir, attemptThumbKey);
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        await fsp.writeFile(abs, result.thumbBuffer);
        savedThumb = attemptThumbKey;
      } catch (err) {
        logger.warn('缩略图落盘失败', err.message);
      }
    }

    const createStart = Date.now();
    try {
      const row = Images.create({
        id: attemptId,
        storage_key: attemptKey,
        original_name: safeBaseName(file.originalname) || `${attemptId}.${result.ext}`,
        ext: result.ext,
        mime: result.mime,
        size: result.buffer.length,
        width: result.width || 0,
        height: result.height || 0,
        pages: result.pages || 1,
        animated: result.animated ? 1 : 0,
        vector: result.vector ? 1 : 0,
        sha256: result.sha256,
        storage_driver: storage.name,
        thumb_key: savedThumb,
        uploader: isAdmin ? 'admin' : 'guest',
        uploader_ip: clientIp,
        uploader_ua: String(ua).slice(0, 200),
        created_at: Date.now(),
      });
      timings.dbMs = (timings.dbMs || 0) + (Date.now() - createStart);
      return { row, putResult };
    } catch (err) {
      timings.dbMs = (timings.dbMs || 0) + (Date.now() - createStart);
      await storageManager.get().remove(attemptKey).catch(() => {});
      if (savedThumb) await fsp.unlink(path.join(config.thumbDir, savedThumb)).catch(() => {});
      throw err;
    }
  };

  let persist;
  try {
    persist = await persistOnce();
  } catch (err) {
    if (!/UNIQUE constraint/i.test(String(err.message))) throw err;
    logger.warn('短 ID 主键碰撞，已回收本次文件并换新 ID 重试', err.message);
    persist = await persistOnce();
  }
  const { row, putResult } = persist;

  logger.ok(`已上传 ${row.id}.${result.ext}`, {
    size: humanize(result.buffer.length),
    from: humanize(result.rawSize),
    driver: storage.name,
    by: isAdmin ? 'admin' : 'guest',
    storage: putResult.results,
    timings: { ...result.timings, ...timings },
  });

  const dto = toDTO(row, base);
  // 仅本次新建的记录签发删除凭证：前端凭它即可清理自己刚上传的这一张
  dto.delete_key = computeDeleteKey(row.id, row.sha256);
  // 服务端代做的格式转换（动画 GIF -> 动画 WebP）：前端据此显示转换徽标
  if (result.convertedFrom) dto.converted_from = result.convertedFrom;

  return { dto, duplicated: false, optimized: result };
}

/**
 * 删除图片（含物理文件 + 缩略图 + 数据库记录）。
 * ------------------------------------------------------------------
 * 物理文件是否可删由 storage_key 引用计数决定 —— 秒传复用的是记录而非文件，
 * 同 sha256 的记录各自持有独立物理文件，按 sha256 判断会把不该保的文件留下。
 * 缩略图恒为本记录专属（路径含记录 id），无论主文件是否共享都必须清理。
 * 物理清理失败不抛错（避免删除接口被存储异常卡死），但通过
 * storage_removed / warnings 如实回传，不再静默吞掉。
 */
async function deleteImage(id, { hard = false } = {}) {
  const row = Images.getAny(id);
  if (!row || row.deleted) throw new ApiError(404, `图片不存在：${id}`, 'IMAGE_NOT_FOUND');

  const shared = Images.storageKeyInUse(row.storage_key, id);
  const warnings = [];
  let storageRemoved = true;

  const removed = await storageManager.get().remove(row.storage_key);
  for (const r of removed) {
    if (!r.ok) {
      storageRemoved = false;
      warnings.push(`存储(${r.driver})删除失败：${r.error || '未知原因'}`);
    }
  }

  if (row.thumb_key) {
    try {
      await fsp.unlink(path.join(config.thumbDir, row.thumb_key));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        storageRemoved = false;
        warnings.push(`缩略图删除失败：${err.message}`);
      }
    }
  }

  if (hard) Images.hardDelete(id);
  else Images.softDelete(id);

  return { id, storage_key: row.storage_key, shared, hard, storage_removed: storageRemoved, warnings };
}

module.exports = { storeFile, deleteImage, toDTO, baseUrlOf, buildKey, buildThumbKey };
