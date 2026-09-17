'use strict';

/**
 * 服务入口
 * ------------------------------------------------------------------
 * 启动流程：
 *   1. 初始化管理员密码（首次运行：读 ADMIN_PASSWORD，缺省则用内置默认值）
 *   2. 预热存储驱动
 *   3. 监听端口
 * 同时处理 SIGINT / SIGTERM，配合 Docker stop 优雅退出。
 */

const config = require('./config');
const { createApp } = require('./app');
const { settings, storageManager } = require('./services/settings');
const { Tokens } = require('./db');
const { logger, humanSize } = require('./utils');

const DEFAULT_ADMIN_PASSWORD = 'admin123';

/** 首次启动初始化管理员密码；已存在则保留数据库里的哈希 */
function initAdminPassword() {
  if (settings.getPasswordHash()) {
    return { created: false, from: 'database' };
  }
  const pwd = config.adminPassword || DEFAULT_ADMIN_PASSWORD;
  settings.setPassword(pwd);
  return {
    created: true,
    from: config.adminPassword ? 'ADMIN_PASSWORD(.env)' : '内置默认值',
    password: pwd,
  };
}

async function bootstrap() {
  const app = createApp();

  const admin = initAdminPassword();
  const storage = storageManager.get();

  const server = app.listen(config.port, config.host, () => {
    const shown = config.publicBaseUrl || `http://localhost:${config.port}`;
    console.log('');
    logger.ok(`Lumina 图床已启动  ${shown}`);
    logger.info(`运行环境      ${config.env} · Node ${process.version}`);
    logger.info(`存储驱动      ${storage.name}`, {
      root: storage.primary.name === 'local' ? storage.primary.root : storage.primary.davUrl,
    });
    logger.info('上传限额', {
      管理员: humanSize(Number(settings.get('max_file_size'))),
      游客: settings.get('guest_upload_enabled')
        ? humanSize(Number(settings.get('guest_max_file_size')))
        : '已关闭',
      单次: `${settings.get('max_files')} 个文件`,
    });
    logger.info(`允许格式      ${(settings.get('allowed_formats') || []).join(', ')}`);
    logger.info(`管理后台      ${shown}/admin`);
    if (admin.created) {
      logger.warn(`管理员初始密码：${admin.password}（来源：${admin.from}）`);
      logger.warn('请登录后台后立即修改密码！');
    }
    console.log('');
  });

  // 定期清理过期的 Token 记录（每小时）
  const purge = setInterval(() => Tokens.purge(), 3600_000);
  if (purge.unref) purge.unref();

  const shutdown = (signal) => {
    logger.warn(`收到 ${signal}，正在优雅退出...`);
    server.close(() => {
      logger.ok('HTTP 服务已关闭');
      process.exit(0);
    });
    // 兜底：10 秒内没关完就强退
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => logger.error('未捕获的 Promise 异常', reason));
  process.on('uncaughtException', (err) => {
    logger.error('未捕获的异常，进程即将退出', err.stack || err.message);
    process.exit(1);
  });

  return server;
}

if (require.main === module) {
  bootstrap().catch((err) => {
    logger.error('启动失败', err.stack || err.message);
    process.exit(1);
  });
}

module.exports = { bootstrap, initAdminPassword };
