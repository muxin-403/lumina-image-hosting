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
const { Images, Settings } = require('../db');
const { settings, storageManager } = require('./settings');
const { processImage } = require('./image');
const { shortId, dateShard, safeBaseName, ApiError, logger } = require('../utils');

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

  const result = await processImage(file.buffer, {
    allowedFormats: settings.get('allowed_formats'),
    optimize: !!settings.get('optimize'),
    quality: Number(settings.get('optimize_quality')) || 82,
    maxWidth: config.maxWidth,
    maxHeight: config.maxHeight,
    thumbnailWidth: Number(settings.get('thumbnail_width')) || 480,
    svgMinify: config.svgMinify,
  });

  // ---- 秒传：同内容不重复存储（可用 DEDUPE=0 关闭） ----
  const dedupe = Settings.get('dedupe');
  if (dedupe !== false) {
    const exist = Images.findBySha(result.sha256);
    if (exist) {
      logger.info(`命中秒传 ${exist.id} <- ${file.originalname}`);
      return { dto: toDTO(exist, base), duplicated: true, optimized: result };
    }
  }

  const id = shortId(10);
  const now = new Date();
  const key = buildKey(id, result.ext, now);
  const thumbKey = buildThumbKey(id, now);

  // 1) 写主存储（hybrid 模式下会同时写本地 + WebDAV）
  const putResult = await storage.put(key, result.buffer, result.mime);

  // 2) 写缩略图（恒本地，失败不阻断）
  let savedThumb = null;
  if (result.thumbBuffer) {
    try {
      const abs = path.join(config.thumbDir, thumbKey);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, result.thumbBuffer);
      savedThumb = thumbKey;
    } catch (err) {
      logger.warn('缩略图落盘失败', err.message);
    }
  }

  // 3) 落库
  const row = Images.create({
    id,
    storage_key: key,
    original_name: safeBaseName(file.originalname) || `${id}.${result.ext}`,
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

  logger.ok(`已上传 ${id}.${result.ext}`, {
    size: humanize(result.buffer.length),
    from: humanize(result.rawSize),
    driver: storage.name,
    by: isAdmin ? 'admin' : 'guest',
    storage: putResult.results,
  });

  return { dto: toDTO(row, base), duplicated: false, optimized: result };
}

/**
 * 删除图片（含物理文件 + 缩略图 + 数据库记录）
 * 若存在同哈希的其它记录，说明文件是被秒传共享的，此时不删除物理文件。
 */
async function deleteImage(id, { hard = false } = {}) {
  const row = Images.getAny(id);
  if (!row || row.deleted) throw new ApiError(404, `图片不存在：${id}`, 'IMAGE_NOT_FOUND');

  const sameContent = row.sha256
    ? Images.idsBySha(row.sha256).filter((x) => x !== id)
    : [];
  const shared = sameContent.length > 0;

  if (!shared) {
    await storageManager.get().remove(row.storage_key);
    if (row.thumb_key) {
      await fsp.unlink(path.join(config.thumbDir, row.thumb_key)).catch(() => {});
    }
  }

  if (hard) Images.hardDelete(id);
  else Images.softDelete(id);

  return { id, storage_key: row.storage_key, shared, hard };
}

module.exports = { storeFile, deleteImage, toDTO, baseUrlOf, buildKey, buildThumbKey };
