'use strict';

/**
 * WebDAV 存储驱动
 * ------------------------------------------------------------------
 * 使用 Node 内置 fetch 直接实现，无需额外依赖，兼容：
 *   Nextcloud / ownCloud / 坚果云 / 群晖 WebDAV / Alist / 通用 WebDAV 服务
 *
 * 两套地址，注意区分：
 *   remoteUrl(key) —— 实际读写用的地址 = <WEBDAV_URL>/<directory>/<key>
 *   url(key)       —— 对外直链 = <直链前缀>/<key>
 *                     直链前缀 = WEBDAV_PUBLIC_URL（若配置）否则 <WEBDAV_URL>/<directory>
 *
 * 也就是说 WEBDAV_PUBLIC_URL 是「已经包含远端目录」的完整前缀，
 * 例如 https://cdn.example.com/lumina —— 这样不会出现目录被拼两次的问题。
 */

const config = require('../../config');
const { logger } = require('../../utils');

const DIR_KEY_RE = /^[A-Za-z0-9_\-./]+$/;

class WebDAVStorage {
  /**
   * @param {object} opt 运行时配置（来自 settings 表，可热更新）
   *   { url, username, password, directory, publicUrl, timeout }
   *
   * 注意：远端根地址存为 this.davUrl 而非 this.url —— 类上有一个
   * url(key) 方法用于生成直链，若用同名实例属性会把它整个覆盖掉。
   */
  constructor(opt = {}) {
    this.name = 'webdav';
    this.davUrl = String(opt.url || '').replace(/\/+$/, '');
    this.username = opt.username || '';
    this.password = opt.password || '';
    this.directory = String(opt.directory || 'lumina').replace(/^\/+|\/+$/g, '');
    // 直链前缀：显式配置优先；否则退化为 <WebDAV 地址>/<远端目录>
    const configuredPublic = String(opt.publicUrl || '').replace(/\/+$/, '');
    this.publicBase = configuredPublic || `${this.davUrl}/${this.directory}`;
    this.timeout = Number(opt.timeout) || 30000;
  }

  get configured() {
    return !!this.davUrl;
  }

  authHeader() {
    const raw = `${this.username}:${this.password}`;
    return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
  }

  headers(extra = {}) {
    return {
      Authorization: this.authHeader(),
      'User-Agent': 'Lumina-ImageHosting/1.0',
      ...extra,
    };
  }

  /** 拼接远端 URL，逐段 encode 但保留路径分隔符 */
  join(...segments) {
    const parts = segments
      .filter((s) => s !== undefined && s !== null && s !== '')
      .map((s) => String(s).replace(/^\/+|\/+$/g, ''));
    return parts.join('/');
  }

  remoteUrl(key) {
    if (!DIR_KEY_RE.test(key)) {
      const err = new Error(`非法的存储路径: ${key}`);
      err.status = 400;
      throw err;
    }
    const encoded = this.join(this.directory, key)
      .split('/')
      .map(encodeURIComponent)
      .join('/');
    return `${this.davUrl}/${encoded}`;
  }

  async request(method, url, { body, headers, okStatus = [] } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const res = await fetch(url, {
        method,
        headers: this.headers(headers),
        body,
        signal: controller.signal,
        redirect: 'follow',
      });
      if (!res.ok && !okStatus.includes(res.status)) {
        const text = await res.text().catch(() => '');
        const err = new Error(
          `WebDAV ${method} 失败：HTTP ${res.status} ${res.statusText} ${text.slice(0, 200)}`,
        );
        err.status = 502;
        throw err;
      }
      return res;
    } catch (err) {
      if (err.name === 'AbortError') {
        const e = new Error(`WebDAV 请求超时（${this.timeout}ms）：${method} ${url}`);
        e.status = 504;
        throw e;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 递归创建目录（MKCOL）。
   * - 目录已存在时服务端返回 405，属正常情况，需显式放行，否则会误判失败；
   * - 父目录未就绪时返回 409，需要重试一次；
   * - 传空字符串表示「确保配置的根目录存在」——很多 WebDAV 服务
   *   （自建 Alist / 群晖 / 通用 WebDAV）不会自动创建目录，必须先 MKCOL。
   */
  async ensureDir(relDir) {
    const segments = this.join(this.directory, relDir).split('/').filter(Boolean);
    if (segments.length === 0) return;

    let acc = '';
    for (const seg of segments) {
      acc = acc ? `${acc}/${seg}` : seg;
      const target = `${this.davUrl}/${acc.split('/').map(encodeURIComponent).join('/')}/`;
      try {
        await this.request('MKCOL', target, { okStatus: [405, 301, 302] });
      } catch (err) {
        // 409 表示父目录尚未就绪（有些服务端有延迟），重试一次
        if (/409/.test(err.message)) {
          await this.request('MKCOL', target, { okStatus: [405, 301, 302, 409] });
        } else if (!/405/.test(err.message)) {
          throw err;
        }
      }
    }
  }

  /** 上传（PUT）。overwrite 为 true 时覆盖同名文件。 */
  async put(key, buffer, mime) {
    const dir = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '';
    await this.ensureDir(dir);
    await this.request('PUT', this.remoteUrl(key), {
      body: buffer,
      headers: {
        'Content-Type': mime || 'application/octet-stream',
        'Content-Length': String(buffer.length),
        Overwrite: 'T',
      },
      okStatus: [201, 204, 200],
    });
    return { key, size: buffer.length };
  }

  async remove(key) {
    try {
      await this.request('DELETE', this.remoteUrl(key), { okStatus: [404] });
      return true;
    } catch (err) {
      logger.warn('WebDAV 删除失败', { key, err: err.message });
      return false;
    }
  }

  async exists(key) {
    try {
      const res = await this.request('HEAD', this.remoteUrl(key), { okStatus: [404] });
      return res.status !== 404;
    } catch (_) {
      return false;
    }
  }

  /**
   * 对外直链：<直链前缀>/<key>
   * 直链前缀（publicBase）本身已包含远端目录，这里只拼 key，
   * 否则会拼出 .../lumina/lumina/2026/09/x.png 这种重复目录。
   */
  url(key) {
    if (!DIR_KEY_RE.test(key)) {
      const err = new Error(`非法的存储路径: ${key}`);
      err.status = 400;
      throw err;
    }
    const encoded = key.split('/').map(encodeURIComponent).join('/');
    return `${this.publicBase}/${encoded}`;
  }

  /** 连通性自检（供管理台「测试连接」按钮调用） */
  async test() {
    if (!this.configured) return { ok: false, message: '未配置 WEBDAV_URL' };
    try {
      await this.ensureDir('');
      const probeKey = `.lumina-probe-${Date.now()}.txt`;
      await this.put(probeKey, Buffer.from('lumina-ok'), 'text/plain');
      await this.remove(probeKey);
      return { ok: true, message: '连接成功，读写权限正常' };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }
}

module.exports = { WebDAVStorage, config };
