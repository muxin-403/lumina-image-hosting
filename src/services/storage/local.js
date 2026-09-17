'use strict';

/**
 * 本地磁盘存储驱动
 * ------------------------------------------------------------------
 * - 文件落在 STORAGE_DIR 下，按 yyyy/mm 分片，避免单目录文件过多；
 * - 通过 Express static 以 /i/<key> 对外提供，并带长缓存头；
 * - 写入使用「临时文件 + rename」保证原子性，避免中断产生半截文件。
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const config = require('../../config');
const { logger } = require('../../utils');

/** 防目录穿越：仅允许 yyyy/mm/<id>.<ext> 形式 */
const KEY_RE = /^\d{4}\/\d{2}\/[A-Za-z0-9_-]+\.[A-Za-z0-9]+$/;

function assertSafeKey(key) {
  if (typeof key !== 'string' || !KEY_RE.test(key)) {
    const err = new Error(`非法的存储路径: ${key}`);
    err.status = 400;
    throw err;
  }
  return key;
}

class LocalStorage {
  constructor() {
    this.name = 'local';
    this.root = config.storageDir;
    this.prefix = config.localPublicPrefix;
    fs.mkdirSync(this.root, { recursive: true });
  }

  /** 物理绝对路径 */
  resolve(key) {
    return path.join(this.root, assertSafeKey(key));
  }

  async put(key, buffer) {
    const target = this.resolve(key);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, buffer);
    await fsp.rename(tmp, target); // 原子替换
    return { key, size: buffer.length };
  }

  async remove(key) {
    try {
      await fsp.unlink(this.resolve(key));
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      logger.warn('删除本地文件失败', { key, err: err.message });
      return false;
    }
  }

  async exists(key) {
    try {
      await fsp.access(this.resolve(key));
      return true;
    } catch (_) {
      return false;
    }
  }

  /** 以流方式读取（用于服务端转发，如 WebDAV 代理下载） */
  createReadStream(key) {
    return fs.createReadStream(this.resolve(key));
  }

  /**
   * 生成对外直链
   * @param {string} key 存储路径
   * @param {string} baseUrl 站点基础地址（由请求上下文推断）
   */
  url(key, baseUrl) {
    const encoded = assertSafeKey(key).split('/').map(encodeURIComponent).join('/');
    return `${baseUrl}${this.prefix}/${encoded}`;
  }

  /** 缩略图同样存本地，挂在 /i/_thumbs/... 下 */
  urlForThumb(thumbKey, baseUrl) {
    const encoded = thumbKey.split('/').map(encodeURIComponent).join('/');
    return `${baseUrl}${this.prefix}/${encoded}`;
  }
}

module.exports = { LocalStorage, assertSafeKey, KEY_RE };
