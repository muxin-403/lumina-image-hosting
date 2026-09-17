'use strict';

/**
 * 图像处理服务（Sharp）
 * ------------------------------------------------------------------
 * 三类图片走三条不同的处理链路，避免「一刀切」破坏内容：
 *
 *   1. 静态位图（JPG/PNG/静态 GIF/WebP/AVIF）
 *      → 自动纠正 EXIF 方向 → 超尺寸等比缩小 → 按原格式再压缩
 *      → 若压缩结果反而更大，则保留原始字节（不做负优化）
 *
 *   2. 动态图（GIF / 动画 WebP / 动画 AVIF，pages > 1）
 *      → 原样保留，绝不丢帧；只做元数据探测
 *      → 缩略图取第 1 帧，避免后台列表加载几十 MB 的动图
 *
 *   3. 矢量图（SVG）
 *      → 保持矢量，绝不栅格化（否则放大会糊）
 *      → 仅做安全精简（去注释 / XML 声明 / 冗余空白 / 危险脚本）
 *      → 缩略图按指定 density 现场栅格化，只用于列表展示
 */

const crypto = require('crypto');
const sharp = require('sharp');
const { ApiError, logger } = require('../utils');

/* ---------------------------- 格式映射表 ---------------------------- */

const FORMAT_EXT = {
  jpeg: 'jpg',
  jpg: 'jpg',
  png: 'png',
  gif: 'gif',
  webp: 'webp',
  avif: 'avif',
  svg: 'svg',
  heif: 'avif',
};

const EXT_MIME = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/pjpeg': 'jpg',
  'image/png': 'png',
  'image/apng': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/heic': 'avif',
  'image/heif': 'avif',
  'image/svg+xml': 'svg',
  'image/svg': 'svg',
};

/* --------------------------- 魔术字节嗅探 --------------------------- */

/**
 * 当 sharp 无法解析时（罕见：某些 AVIF 变体、被截断的文件），
 * 退化为读取文件头判断，避免误判为「非法格式」。
 */
function sniffMagic(buffer) {
  if (buffer.length < 12) return null;
  const hex = buffer.subarray(0, 12).toString('hex').toLowerCase();
  if (hex.startsWith('ffd8ff')) return 'jpg';
  if (hex.startsWith('89504e47')) return 'png';
  if (hex.startsWith('47494638')) return 'gif'; // GIF8
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'webp';
  }
  if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('ascii');
    if (brand.startsWith('avif') || brand.startsWith('avis')) return 'avif';
    if (brand.startsWith('heic') || brand.startsWith('mif1')) return 'avif'; // HEIC 交给 sharp 处理
  }
  const head = buffer.subarray(0, 512).toString('utf8').toLowerCase();
  if (head.includes('<svg')) return 'svg';
  return null;
}

/* ------------------------------ SVG 处理 ------------------------------ */

/** 从 width/height 或 viewBox 中解析尺寸（矢量图特有的尺寸来源） */
function parseSvgSize(svgText) {
  // 优先 viewBox（更可靠，宽高可能是百分比）
  const vb = svgText.match(/viewBox\s*=\s*["']\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)/i);
  if (vb) {
    return { width: Math.round(parseFloat(vb[3])), height: Math.round(parseFloat(vb[4])) };
  }
  const w = svgText.match(/\bwidth\s*=\s*["']([\d.]+)(?:px)?["']/i);
  const h = svgText.match(/\bheight\s*=\s*["']([\d.]+)(?:px)?["']/i);
  return {
    width: w ? Math.round(parseFloat(w[1])) : 0,
    height: h ? Math.round(parseFloat(h[1])) : 0,
  };
}

/**
 * SVG 安全精简：矢量图「优化」的正确姿势是不改变绘制结果。
 * - 去掉 XML 声明、DOCTYPE、注释、编辑器元数据
 * - 去掉 <script> / on* 事件属性 / javascript: 协议（自托管场景下的 XSS 防护）
 * - 折叠多余空白
 */
function minifySvg(svgText) {
  let out = String(svgText);
  out = out.replace(/<\?xml[\s\S]*?\?>/gi, '');
  out = out.replace(/<!DOCTYPE[\s\S]*?>/gi, '');
  out = out.replace(/<!--[\s\S]*?-->/g, '');
  out = out.replace(/<metadata[\s\S]*?<\/metadata>/gi, '');
  out = out.replace(/<script[\s\S]*?<\/script>/gi, '');
  out = out.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '');
  out = out.replace(/(href|xlink:href)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '');
  out = out.replace(/>\s{2,}</g, '><');
  out = out.replace(/\s{2,}/g, ' ');
  return out.trim();
}

/* --------------------------- 主处理流程 --------------------------- */

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * 探测图片真实信息
 * @returns {Promise<{format:string,ext:string,mime:string,width:number,height:number,pages:number}>}
 */
async function probe(buffer) {
  let meta = null;
  try {
    meta = await sharp(buffer, { animated: true, limitInputPixels: 268402689 }).metadata();
  } catch (err) {
    logger.warn('sharp 解析失败，尝试魔术字节兜底', err.message);
  }

  let format = meta && meta.format ? String(meta.format).toLowerCase() : null;
  if (!format) format = sniffMagic(buffer);

  if (!format) {
    throw new ApiError(415, '无法识别的图片格式，仅支持 JPG / PNG / GIF / WebP / SVG / AVIF', 'UNSUPPORTED_FORMAT');
  }

  const ext = FORMAT_EXT[format] || format;
  const pages = meta && meta.pages ? meta.pages : 1;

  let width = meta && meta.width ? meta.width : 0;
  let height = meta && meta.height ? meta.height : 0;

  // 动态图（GIF / 动画 WebP / 动画 AVIF）的 metadata.height 是「所有帧纵向拼接」后的总高度，
  // libvips 会额外给出 pageHeight 表示单帧高度。这里必须换算，否则后台会显示成 120×360 这种错误尺寸。
  if (pages > 1) {
    if (meta.pageHeight) height = meta.pageHeight;
    else if (height && height % pages === 0) height = height / pages;
  }

  if (ext === 'svg') {
    const size = parseSvgSize(buffer.toString('utf8'));
    width = size.width || width || 0;
    height = size.height || height || 0;
  }

  return { format, ext, mime: EXT_MIME[ext] || 'application/octet-stream', width, height, pages };
}

/** 静态位图优化：返回 { buffer, meta } */
async function optimizeRaster(buffer, ext, opts) {
  const { optimize, quality, maxWidth, maxHeight } = opts;
  if (!optimize) return { buffer, resized: false };

  try {
    let pipeline = sharp(buffer, { failOn: 'none' }).rotate(); // rotate() 无参数 = 按 EXIF 自动纠正方向

    const meta = await sharp(buffer, { failOn: 'none' }).metadata();
    const needResize =
      (meta.width && maxWidth && meta.width > maxWidth) ||
      (meta.height && maxHeight && meta.height > maxHeight);

    if (needResize) {
      pipeline = pipeline.resize({
        width: maxWidth,
        height: maxHeight,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    let out;
    if (ext === 'jpg') {
      out = await pipeline.jpeg({ quality, mozjpeg: true, progressive: true }).toBuffer();
    } else if (ext === 'png') {
      // PNG 走无损路径，压缩级别拉满；调色板量化会丢色，这里不开
      out = await pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
    } else if (ext === 'webp') {
      out = await pipeline.webp({ quality, effort: 4 }).toBuffer();
    } else if (ext === 'avif') {
      out = await pipeline.avif({ quality, effort: 4 }).toBuffer();
    } else if (ext === 'gif') {
      out = await pipeline.gif().toBuffer();
    } else {
      return { buffer, resized: false };
    }

    // 负优化保护：只有在确实变小、或确实做了缩放时才替换
    if (out.length < buffer.length || needResize) {
      return { buffer: out, resized: needResize };
    }
    return { buffer, resized: false };
  } catch (err) {
    logger.warn('图像优化失败，保留原始文件', err.message);
    return { buffer, resized: false };
  }
}

/** 生成缩略图（WebP，恒本地存储） */
async function makeThumbnail(buffer, { ext, width }) {
  const target = Math.max(64, Number(width) || 480);
  try {
    if (ext === 'svg') {
      // 矢量图：提高渲染密度后再缩小，边缘更干净
      return await sharp(buffer, { density: 200 })
        .resize({ width: target, withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer();
    }
    if (ext === 'gif') {
      // 动图：只取第一帧作为封面
      return await sharp(buffer, { animated: true, pages: 1 })
        .resize({ width: target, withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer();
    }
    return await sharp(buffer, { failOn: 'none' })
      .rotate()
      .resize({ width: target, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
  } catch (err) {
    logger.warn('缩略图生成失败（不影响原图上传）', err.message);
    return null;
  }
}

/**
 * 完整的图片处理流水线
 * @param {Buffer} raw 原始字节
 * @param {object} opt { allowedFormats, optimize, quality, maxWidth, maxHeight, thumbnailWidth }
 * @returns {Promise<object>} 处理结果
 */
async function processImage(raw, opt) {
  if (!Buffer.isBuffer(raw) || raw.length === 0) {
    throw new ApiError(400, '空文件', 'EMPTY_FILE');
  }

  const info = await probe(raw);

  const allowed = (opt.allowedFormats || []).map((s) => String(s).toLowerCase());
  const extAlias = info.ext === 'jpg' ? ['jpg', 'jpeg'] : [info.ext];
  if (allowed.length && !extAlias.some((e) => allowed.includes(e))) {
    throw new ApiError(
      415,
      `不支持的格式：.${info.ext}，当前允许：${allowed.join(', ')}`,
      'FORMAT_NOT_ALLOWED',
    );
  }

  const animated = info.pages > 1;
  const vector = info.ext === 'svg';

  let finalBuffer = raw;
  let optimized = false;
  let resized = false;
  let note = '';

  if (vector) {
    if (opt.svgMinify !== false) {
      const minified = Buffer.from(minifySvg(raw.toString('utf8')), 'utf8');
      if (minified.length < raw.length) {
        finalBuffer = minified;
        optimized = true;
        note = 'SVG 已精简';
      }
    }
  } else if (animated) {
    // 动态图：保留所有帧，不做有损再编码（避免闪烁/掉帧）
    note = `动态图（${info.pages} 帧），已保留原始数据`;
  } else {
    const r = await optimizeRaster(raw, info.ext, opt);
    finalBuffer = r.buffer;
    optimized = r.buffer.length !== raw.length;
    resized = r.resized;
    note = optimized ? `已优化${resized ? '并缩放' : ''}` : '原始文件已是最优';
  }

  // 处理后的实际尺寸（缩放会改变宽高）
  let { width, height } = info;
  if (resized) {
    try {
      const m = await sharp(finalBuffer, { failOn: 'none' }).metadata();
      width = m.width || width;
      height = m.height || height;
    } catch (_) {
      /* 保持原值 */
    }
  }

  const thumbBuffer = await makeThumbnail(finalBuffer, {
    ext: info.ext,
    width: opt.thumbnailWidth,
  });

  return {
    buffer: finalBuffer,
    originalBuffer: raw,
    ext: info.ext,
    mime: info.mime,
    width,
    height,
    pages: info.pages,
    animated,
    vector,
    optimized,
    resized,
    note,
    sha256: sha256(finalBuffer),
    thumbBuffer,
    rawSize: raw.length,
    finalSize: finalBuffer.length,
  };
}

module.exports = {
  processImage,
  probe,
  makeThumbnail,
  minifySvg,
  parseSvgSize,
  sniffMagic,
  EXT_MIME,
  MIME_EXT,
  FORMAT_EXT,
};
