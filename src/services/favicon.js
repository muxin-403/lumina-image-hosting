'use strict';

/**
 * 站点图标（favicon）服务
 * ------------------------------------------------------------------
 * - 管理台上传的图标以 data/favicon/favicon.<ext> 落盘（单文件，小体积）
 * - 元信息（扩展名 + 版本号）记录在 settings 表，随 SQLite 持久化
 * - 页面统一从 /favicon.ico|png|svg 取图：未设置时回落 public/favicon.svg
 * - 版本号用于生成 /favicon.ico?v=<ts> 形式的缓存穿透链接
 *
 * 安全要点：不信任扩展名与 Content-Type，一律按文件头（magic bytes）
 * 嗅探真实格式，白名单之外直接拒绝，避免把可执行内容伪装成图标。
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { Settings } = require('../db');
const { ApiError, logger, humanSize } = require('../utils');

/** 图标文件目录（随 DATA_DIR 持久化） */
const FAVICON_DIR = path.join(config.dataDir, 'favicon');

/** 支持的图标格式与响应 MIME */
const EXT_MIME = {
  ico: 'image/x-icon',
  png: 'image/png',
  svg: 'image/svg+xml',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** 图标体积上限：favicon 无需高清，1MB 足够 */
const MAX_SIZE = 1024 * 1024;

/** 默认图标（未设置自定义时的回退方案） */
const DEFAULT_FAVICON = path.join(config.publicDir, 'favicon.svg');

/**
 * 按文件头嗅探真实图标格式
 * @param {Buffer} buf
 * @returns {string|null} 白名单内的扩展名；无法识别返回 null
 */
function sniffExt(buf) {
  // PNG：89 50 4E 47
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'png';
  }
  // GIF：'GIF8'
  if (buf.length >= 6 && buf.toString('ascii', 0, 3) === 'GIF') return 'gif';
  // ICO：00 00 01 00
  if (buf.length >= 4 && buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) return 'ico';
  // JPEG：FF D8 FF
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  // WebP：'RIFF' + 4 字节长度 + 'WEBP'
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'webp';
  }
  // SVG：文本探测（兼容 BOM / XML 声明前缀），且必须真的包含 <svg 标签
  const head = buf.subarray(0, 2048).toString('utf8').replace(/^\uFEFF/, '').trim().toLowerCase();
  if ((head.startsWith('<?xml') || head.startsWith('<svg')) && head.includes('<svg')) {
    return 'svg';
  }
  return null;
}

/**
 * 当前生效的自定义图标；未设置或文件丢失返回 null
 */
function current() {
  const ext = Settings.get('favicon_ext');
  if (!ext || !EXT_MIME[ext]) return null;
  const abs = path.join(FAVICON_DIR, `favicon.${ext}`);
  if (!fs.existsSync(abs)) return null;
  return {
    ext,
    mime: EXT_MIME[ext],
    abs,
    version: Number(Settings.get('favicon_version')) || 0,
  };
}

/** 对外可用的图标地址（带版本号破缓存；未设置时回落默认） */
function publicUrl() {
  const cur = current();
  return cur ? `/favicon.ico?v=${cur.version}` : '/favicon.svg';
}

/** 清空目录内的旧图标文件（保证目录里只剩当前一种格式） */
function removeExisting() {
  if (!fs.existsSync(FAVICON_DIR)) return;
  for (const file of fs.readdirSync(FAVICON_DIR)) {
    if (/^favicon\./i.test(file)) {
      try {
        fs.unlinkSync(path.join(FAVICON_DIR, file));
      } catch (_) {
        /* 单个旧文件清理失败不阻塞新图标写入 */
      }
    }
  }
}

/**
 * 保存（上传 / 替换）站点图标
 * @param {Buffer} buffer 文件内容
 * @returns {{ext: string, mime: string, abs: string, version: number}}
 */
function save(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new ApiError(400, '图标文件内容为空', 'EMPTY_FILE');
  }
  if (buffer.length > MAX_SIZE) {
    throw new ApiError(413, `图标不能超过 ${humanSize(MAX_SIZE)}`, 'FILE_TOO_LARGE');
  }

  const ext = sniffExt(buffer);
  if (!ext) {
    throw new ApiError(
      400,
      '不支持的图标格式，请上传 .ico / .png / .svg / .jpg / .gif / .webp',
      'BAD_FORMAT',
    );
  }

  fs.mkdirSync(FAVICON_DIR, { recursive: true });
  removeExisting();
  fs.writeFileSync(path.join(FAVICON_DIR, `favicon.${ext}`), buffer);
  Settings.set('favicon_ext', ext);
  Settings.set('favicon_version', Date.now());
  logger.ok('站点图标已更新', `${ext} · ${humanSize(buffer.length)}`);
  return current();
}

/** 移除自定义图标，回落到默认方案 */
function reset() {
  removeExisting();
  Settings.del('favicon_ext');
  Settings.del('favicon_version');
  logger.info('站点图标已恢复默认');
}

module.exports = { current, publicUrl, save, reset, EXT_MIME, MAX_SIZE, DEFAULT_FAVICON };
