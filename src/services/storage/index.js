'use strict';

/**
 * 存储层工厂 / 门面（Facade）
 * ------------------------------------------------------------------
 * 支持三种模式（管理台可实时切换，无需重启）：
 *   local  —— 仅本地磁盘
 *   webdav —— 仅 WebDAV（Nextcloud / 坚果云 / 群晖 / Alist 等）
 *   hybrid —— 双写：本地 + WebDAV，对外直链走本地，WebDAV 作为异地备份
 *
 * 统一的存储契约：
 *   put(key, buffer, mime) -> Promise<{key, size}>
 *   remove(key)            -> Promise<boolean>
 *   exists(key)            -> Promise<boolean>
 *   url(key, baseUrl)      -> string  对外可公开访问的直链
 *
 * 缩略图恒存本地（storage/_thumbs），由 /t/:id 路由直接吐流，
 * 因此即使主存储切到 WebDAV，后台列表依然能秒开。
 */

const { LocalStorage } = require('./local');
const { WebDAVStorage } = require('./webdav');
const { settings } = require('../settings');
const { logger, ApiError } = require('../../utils');

class StorageFacade {
  constructor(drivers, mode) {
    this.mode = mode;
    this.drivers = drivers; // 至少一个；第 0 个为主存储
    this.name = mode;
  }

  get primary() {
    return this.drivers[0];
  }

  /** 写入：主存储失败即整体失败；副本失败仅告警（不阻断上传） */
  async put(key, buffer, mime) {
    const results = [];
    for (let i = 0; i < this.drivers.length; i += 1) {
      const drv = this.drivers[i];
      try {
        await drv.put(key, buffer, mime);
        results.push({ driver: drv.name, ok: true });
      } catch (err) {
        if (i === 0) {
          throw new ApiError(502, `主存储(${drv.name})写入失败：${err.message}`, 'STORAGE_WRITE_FAILED');
        }
        logger.warn(`副本存储(${drv.name})写入失败，已忽略`, { key, err: err.message });
        results.push({ driver: drv.name, ok: false, error: err.message });
      }
    }
    return { key, size: buffer.length, results };
  }

  /** 删除：任一驱动失败都不抛错，避免删除接口被存储异常卡死 */
  async remove(key) {
    const out = [];
    for (const drv of this.drivers) {
      try {
        out.push({ driver: drv.name, ok: await drv.remove(key) });
      } catch (err) {
        out.push({ driver: drv.name, ok: false, error: err.message });
      }
    }
    return out;
  }

  async exists(key) {
    return this.primary.exists(key);
  }

  /** 对外直链（基于主存储） */
  url(key, baseUrl) {
    return this.primary.url(key, baseUrl);
  }

  /** 健康检查：返回每个驱动的可用状态 */
  async health() {
    const out = [];
    for (const drv of this.drivers) {
      if (drv.name === 'local') {
        out.push({ driver: 'local', ok: true, message: '本地磁盘可写', detail: drv.root });
      } else {
        const r = await drv.test();
        out.push({ driver: 'webdav', ok: r.ok, message: r.message, detail: drv.davUrl });
      }
    }
    return out;
  }
}

/**
 * 依据当前运行时配置构造存储实例
 * @returns {StorageFacade}
 */
function createStorage() {
  const mode = String(settings.get('storage_driver') || 'local').toLowerCase();

  const localDrv = () => new LocalStorage();
  const webdavDrv = () =>
    new WebDAVStorage({
      url: settings.get('webdav_url'),
      username: settings.get('webdav_username'),
      password: settings.get('webdav_password'),
      directory: settings.get('webdav_directory'),
      publicUrl: settings.get('webdav_public_url'),
      timeout: settings.get('webdav_timeout') || 30000,
    });

  if (mode === 'webdav') {
    return new StorageFacade([webdavDrv()], 'webdav');
  }
  if (mode === 'hybrid') {
    return new StorageFacade([localDrv(), webdavDrv()], 'hybrid');
  }
  return new StorageFacade([localDrv()], 'local');
}

module.exports = { createStorage, StorageFacade };
