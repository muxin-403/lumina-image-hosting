'use strict';

/**
 * bugfix-test 的崩溃探针（独立子进程运行，父进程只看退出码）
 * ------------------------------------------------------------------
 * 「流错误无人监听 → uncaughtException → process.exit(1)」这类会杀死
 * 整个进程的缺陷无法在测试进程内安全断言，因此由本脚本自举一个
 * 完全隔离的服务实例，发起敌意请求后检查进程是否仍然存活。
 *
 * 用法：node examples/bugfix-crash-probe.js <mode>
 *   mode = eisdir   本地直链：existsSync 通过后读流报错（文件被同名目录顶替）
 *   mode = proxy    WebDAV 代理转发：上游发出响应头后中途断开连接
 *
 * 退出码：0 = 敌意请求后 /api/health 仍 200（进程存活，已修复）
 *         非 0 = 进程崩溃或探针自身异常（缺陷仍在）
 */

const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

const mode = process.argv[2] || 'eisdir';
const stamp = `${Date.now()}-${process.pid}`;

/* ------------------------- proxy 模式：最小 WebDAV ------------------------- */

let davServer = null;
let davPort = 0;

/**
 * MKCOL/PUT/DELETE 正常应答；GET 先发完整响应头与少量字节，
 * 然后直接销毁 socket —— 模拟「上游传输中途断连」。
 */
function startMockDav() {
  return new Promise((resolve) => {
    davServer = http.createServer((req, res) => {
      if (req.method === 'MKCOL') {
        req.resume();
        res.writeHead(201);
        return res.end();
      }
      if (req.method === 'PUT') {
        req.resume();
        res.writeHead(201);
        return res.end();
      }
      if (req.method === 'DELETE') {
        req.resume();
        res.writeHead(204);
        return res.end();
      }
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': '100000' });
        res.write(Buffer.alloc(64, 1));
        return setTimeout(() => {
          if (res.socket) res.socket.destroy();
        }, 50);
      }
      req.resume();
      res.writeHead(404);
      res.end();
    });
    davServer.listen(0, '127.0.0.1', () => {
      davPort = davServer.address().port;
      resolve();
    });
  });
}

/* --------------------------------- 主流程 --------------------------------- */

async function main() {
  if (mode === 'proxy') await startMockDav();

  // 隔离环境：必须在 require 任何 src/ 模块之前设置好全部环境变量
  const dataDir = path.join(os.tmpdir(), `lumina-probe-${stamp}-data`);
  const storageDir = path.join(os.tmpdir(), `lumina-probe-${stamp}-storage`);
  process.env.DATA_DIR = dataDir;
  process.env.STORAGE_DIR = storageDir;
  process.env.DB_PATH = path.join(dataDir, 'lumina.db');
  process.env.ADMIN_PASSWORD = 'probe-pwd';
  process.env.SESSION_SECRET = 'c'.repeat(64);
  process.env.PORT = '0';
  if (mode === 'proxy') {
    process.env.STORAGE_DRIVER = 'webdav';
    process.env.WEBDAV_URL = `http://127.0.0.1:${davPort}`;
    process.env.WEBDAV_USERNAME = 'probe';
    process.env.WEBDAV_PASSWORD = 'probe';
    process.env.WEBDAV_DIRECTORY = 'lumina';
  }

  // eslint-disable-next-line global-require
  const { bootstrap } = require('../src/server');
  // eslint-disable-next-line global-require
  const sharp = require('sharp');

  const server = await bootstrap();
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  // 兜底：任何环节卡死都按失败退出
  const killer = setTimeout(() => process.exit(2), 20000);

  const health = async () => {
    const r = await fetch(`${base}/api/health`);
    return r.status;
  };

  // 上传一张噪声 PNG
  const noise = Buffer.alloc(96 * 96 * 3);
  for (let i = 0; i < noise.length; i += 1) noise[i] = (i * 31 + 7) % 253;
  const png = await sharp(noise, { raw: { width: 96, height: 96, channels: 3 } }).png().toBuffer();
  const form = new FormData();
  form.append('file', new Blob([png]), 'probe.png');
  const up = await fetch(`${base}/api/upload`, { method: 'POST', body: form });
  const upBody = await up.json();
  if (!upBody.success) throw new Error(`上传失败：${JSON.stringify(upBody).slice(0, 200)}`);
  const id = upBody.data.id;

  // 敌意请求（进程崩溃的话，后面两句不会执行，父进程看到非 0 退出码）
  try {
    if (mode === 'eisdir') {
      // eslint-disable-next-line global-require
      const config = require('../src/config');
      // eslint-disable-next-line global-require
      const { Images } = require('../src/db');
      const row = Images.getAny(id);
      const abs = path.join(config.storageDir, row.storage_key);
      fs.rmSync(abs, { force: true });
      fs.mkdirSync(abs); // 用同名目录顶替文件：existsSync 通过、读流必报 EISDIR
      await fetch(`${base}/i/${row.storage_key}`, { signal: AbortSignal.timeout(5000) });
    } else {
      await fetch(`${base}/i/${upBody.data.url.split('/i/')[1]}`, {
        signal: AbortSignal.timeout(8000),
      });
    }
  } catch (_) {
    /* 请求本身报错是预期的（上游断连/读流失败），关键看进程是否存活 */
  }

  const status = await health();
  clearTimeout(killer);
  server.close();
  if (davServer) davServer.close();
  process.exit(status === 200 ? 0 : 1);
}

main().catch((err) => {
  console.error('[probe] 异常：', err.message);
  if (davServer) davServer.close();
  process.exit(1);
});
