'use strict';

/**
 * 数据层：SQLite（better-sqlite3，同步 API、零配置、单文件）
 * ------------------------------------------------------------------
 * 表结构：
 *   images   —— 图片元数据（含存储位置、尺寸、上传者等）
 *   settings —— 键值型运行时配置（管理台可改，覆盖 .env）
 *   tokens   —— 管理员会话 Token 的吊销名单（登出 / 改密后失效）
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const config = require('../config');
const { logger } = require('../utils');

// 确保数据库目录存在
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);

// 生产级调优：WAL 提升并发读性能，NORMAL 同步兼顾安全与速度
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

/* ------------------------------- 建表 ------------------------------- */

db.exec(`
CREATE TABLE IF NOT EXISTS images (
  id             TEXT PRIMARY KEY,              -- 短 ID
  storage_key    TEXT NOT NULL,                 -- 存储路径 2026/09/xxxxxxxx.png
  original_name  TEXT NOT NULL DEFAULT '',      -- 原始文件名
  ext            TEXT NOT NULL,                 -- 归一化扩展名 jpg/png/...
  mime           TEXT NOT NULL,                 -- MIME 类型
  size           INTEGER NOT NULL DEFAULT 0,    -- 字节
  width          INTEGER NOT NULL DEFAULT 0,    -- 宽（SVG 为 viewBox 推算值，未知则 0）
  height         INTEGER NOT NULL DEFAULT 0,    -- 高
  pages          INTEGER NOT NULL DEFAULT 1,    -- 帧数 > 1 表示动态图
  animated       INTEGER NOT NULL DEFAULT 0,    -- 是否动态图
  vector         INTEGER NOT NULL DEFAULT 0,    -- 是否矢量图（SVG）
  sha256         TEXT NOT NULL DEFAULT '',      -- 内容哈希，用于秒传/去重
  storage_driver TEXT NOT NULL DEFAULT 'local', -- local | webdav
  thumb_key      TEXT,                          -- 缩略图路径（本地驱动才有）
  uploader       TEXT NOT NULL DEFAULT 'guest', -- admin | guest
  uploader_ip    TEXT NOT NULL DEFAULT '',
  uploader_ua    TEXT NOT NULL DEFAULT '',
  deleted        INTEGER NOT NULL DEFAULT 0,    -- 软删除标记（保留审计）
  created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_images_created ON images (deleted, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_images_sha     ON images (sha256);
CREATE INDEX IF NOT EXISTS idx_images_ip      ON images (uploader_ip, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_images_key     ON images (storage_key);

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  jti        TEXT PRIMARY KEY,   -- Token 唯一标识（落库以支持主动吊销）
  label      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tokens_exp ON tokens (expires_at);
`);

/* ------------------------------ 语句准备 ------------------------------ */

const stmts = {
  insertImage: db.prepare(`
    INSERT INTO images (id, storage_key, original_name, ext, mime, size, width, height,
                        pages, animated, vector, sha256, storage_driver, thumb_key,
                        uploader, uploader_ip, uploader_ua, deleted, created_at)
    VALUES (@id, @storage_key, @original_name, @ext, @mime, @size, @width, @height,
            @pages, @animated, @vector, @sha256, @storage_driver, @thumb_key,
            @uploader, @uploader_ip, @uploader_ua, 0, @created_at)
  `),
  getImage: db.prepare('SELECT * FROM images WHERE id = ? AND deleted = 0'),
  getImageAny: db.prepare('SELECT * FROM images WHERE id = ?'),
  getImageByKey: db.prepare(
    'SELECT * FROM images WHERE storage_key = ? AND deleted = 0 ORDER BY created_at DESC LIMIT 1',
  ),
  findBySha: db.prepare(
    'SELECT * FROM images WHERE sha256 = ? AND deleted = 0 ORDER BY created_at DESC LIMIT 1',
  ),
  softDelete: db.prepare('UPDATE images SET deleted = 1 WHERE id = ? AND deleted = 0'),
  hardDelete: db.prepare('DELETE FROM images WHERE id = ?'),
  updateThumb: db.prepare('UPDATE images SET thumb_key = ? WHERE id = ?'),

  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  allSettings: db.prepare('SELECT key, value FROM settings'),
  upsertSetting: db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `),
  delSetting: db.prepare('DELETE FROM settings WHERE key = ?'),

  insertToken: db.prepare(
    'INSERT INTO tokens (jti, label, created_at, expires_at) VALUES (?, ?, ?, ?)',
  ),
  getToken: db.prepare('SELECT * FROM tokens WHERE jti = ?'),
  delToken: db.prepare('DELETE FROM tokens WHERE jti = ?'),
  purgeTokens: db.prepare('DELETE FROM tokens WHERE expires_at < ?'),

  countImages: db.prepare('SELECT COUNT(*) AS c FROM images WHERE deleted = 0'),
};

/* ------------------------------ 查询封装 ------------------------------ */

const Images = {
  create(row) {
    stmts.insertImage.run(row);
    return this.get(row.id);
  },
  get(id) {
    return stmts.getImage.get(id);
  },
  getAny(id) {
    return stmts.getImageAny.get(id);
  },
  getByKey(key) {
    return stmts.getImageByKey.get(key);
  },
  findBySha(sha) {
    return sha ? stmts.findBySha.get(sha) : undefined;
  },
  setThumb(id, key) {
    stmts.updateThumb.run(key, id);
  },
  softDelete(id) {
    return stmts.softDelete.run(id).changes > 0;
  },
  hardDelete(id) {
    return stmts.hardDelete.run(id).changes > 0;
  },

  /**
   * 列表查询（管理台）
   * @param {object} opt { page, limit, keyword, uploader, ext, order }
   */
  list(opt = {}) {
    const page = Math.max(1, parseInt(opt.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(opt.limit, 10) || 24));
    const where = ['deleted = 0'];
    const params = {};

    if (opt.keyword) {
      where.push('(original_name LIKE @kw OR id LIKE @kw OR storage_key LIKE @kw)');
      params.kw = `%${opt.keyword}%`;
    }
    if (opt.uploader && ['admin', 'guest'].includes(opt.uploader)) {
      where.push('uploader = @uploader');
      params.uploader = opt.uploader;
    }
    if (opt.ext) {
      where.push('ext = @ext');
      params.ext = String(opt.ext).toLowerCase();
    }

    const orderMap = {
      newest: 'created_at DESC',
      oldest: 'created_at ASC',
      largest: 'size DESC',
      smallest: 'size ASC',
    };
    const order = orderMap[opt.order] || orderMap.newest;

    const sqlWhere = `WHERE ${where.join(' AND ')}`;
    const total = db.prepare(`SELECT COUNT(*) AS c FROM images ${sqlWhere}`).get(params).c;
    const items = db
      .prepare(
        `SELECT * FROM images ${sqlWhere} ORDER BY ${order} LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit, offset: (page - 1) * limit });

    return { items, total, page, limit, pages: Math.max(1, Math.ceil(total / limit)) };
  },

  /** 统计概览：总数 / 总容量 / 今日上传 / 各格式分布 / 各存储驱动分布 */
  stats() {
    const total = db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(size),0) AS bytes FROM images WHERE deleted = 0`,
      )
      .get();

    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const today = db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(size),0) AS bytes
         FROM images WHERE deleted = 0 AND created_at >= ?`,
      )
      .get(dayStart.getTime());

    const byExt = db
      .prepare(
        `SELECT ext, COUNT(*) AS count, COALESCE(SUM(size),0) AS bytes
         FROM images WHERE deleted = 0 GROUP BY ext ORDER BY count DESC`,
      )
      .all();

    const byDriver = db
      .prepare(
        `SELECT storage_driver AS driver, COUNT(*) AS count
         FROM images WHERE deleted = 0 GROUP BY storage_driver`,
      )
      .all();

    const dynamic = db
      .prepare('SELECT COUNT(*) AS c FROM images WHERE deleted = 0 AND animated = 1')
      .get().c;
    const vector = db
      .prepare('SELECT COUNT(*) AS c FROM images WHERE deleted = 0 AND vector = 1')
      .get().c;

    return {
      total: total.count,
      totalBytes: total.bytes,
      todayCount: today.count,
      todayBytes: today.bytes,
      animatedCount: dynamic,
      vectorCount: vector,
      byExt,
      byDriver,
    };
  },

  /** 删除该 ID 对应的所有同哈希记录（秒传场景可能一条内容对多条记录） */
  idsBySha(sha) {
    return db.prepare('SELECT id FROM images WHERE sha256 = ? AND deleted = 0').all(sha).map((r) => r.id);
  },
};

const Settings = {
  get(key) {
    const row = stmts.getSetting.get(key);
    return row ? JSON.parse(row.value) : undefined;
  },
  all() {
    const out = {};
    for (const row of stmts.allSettings.all()) {
      try {
        out[row.key] = JSON.parse(row.value);
      } catch (_) {
        out[row.key] = row.value;
      }
    }
    return out;
  },
  set(key, value) {
    stmts.upsertSetting.run(key, JSON.stringify(value), Date.now());
    return value;
  },
  del(key) {
    stmts.delSetting.run(key);
  },
};

const Tokens = {
  add(jti, label, expiresAt) {
    stmts.insertToken.run(jti, label, Date.now(), expiresAt);
  },
  has(jti) {
    const row = stmts.getToken.get(jti);
    return !!row;
  },
  revoke(jti) {
    stmts.delToken.run(jti);
  },
  /** 一键吊销全部会话（改密后调用） */
  revokeAll() {
    db.prepare('DELETE FROM tokens').run();
  },
  purge() {
    stmts.purgeTokens.run(Date.now());
  },
};

logger.ok('SQLite 已就绪', config.dbPath);

module.exports = { db, Images, Settings, Tokens, count: () => stmts.countImages.get().c };
