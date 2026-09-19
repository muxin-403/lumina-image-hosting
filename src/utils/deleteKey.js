'use strict';

/**
 * 上传删除凭证（delete_key）
 * ------------------------------------------------------------------
 * 游客上传后没有管理员 Token，但上传页仍要允许其「删除自己刚上传的这一张」。
 * 用无状态签名凭证解决归属问题，而不是新增可匿名调用的删除接口：
 *
 *   delete_key = base64url( HMAC-SHA256(sessionSecret, `lumina:delete:v1:<id>:<sha256>`) )
 *
 * 设计要点：
 *   - 密钥来自 config.sessionSecret（环境变量 SESSION_SECRET，或 data/.secret 持久化），
 *     外部无法伪造；服务端不落库，凭证随上传响应一次性下发。
 *   - 签名绑定 id 与内容哈希，凭证只对「这一条记录 + 这一份内容」有效，
 *     拿不到别人的凭证就删不了别人的图。
 *   - 比对使用 timingSafeEqual，避免通过响应耗时逐字节猜测凭证。
 *   - 秒传命中时不下发凭证（那条记录是别人先建的），见 services/uploader.js。
 */

const crypto = require('crypto');
const config = require('../config');
const { base64UrlEncode } = require('./index');

/** 领域分隔前缀，避免与其它签名用途（如登录 Token）串用同一密钥 */
const DOMAIN = 'lumina:delete:v1:';

/**
 * 计算一条记录的删除凭证
 * @param {string} id     图片短 ID
 * @param {string} sha256 内容哈希（空串表示未知，仍然可签发）
 * @returns {string|null}  URL 安全的凭证串
 */
function computeDeleteKey(id, sha256) {
  if (!id || typeof id !== 'string') return null;
  const payload = `${DOMAIN}${id}:${sha256 || ''}`;
  return base64UrlEncode(crypto.createHmac('sha256', config.sessionSecret).update(payload).digest());
}

/**
 * 校验删除凭证是否匹配该记录
 * @param {string} id
 * @param {string} sha256
 * @param {string} key  请求方提供的凭证
 */
function verifyDeleteKey(id, sha256, key) {
  if (typeof key !== 'string' || !key) return false;
  const expected = computeDeleteKey(id, sha256);
  if (!expected) return false;

  const given = Buffer.from(key);
  const want = Buffer.from(expected);
  // 长度不等时 timingSafeEqual 会抛错，先短路；长度本身不是秘密
  if (given.length !== want.length) return false;
  return crypto.timingSafeEqual(given, want);
}

module.exports = { computeDeleteKey, verifyDeleteKey };
