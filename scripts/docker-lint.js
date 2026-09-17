#!/usr/bin/env node
'use strict';

/**
 * Docker 构建前静态校验
 * ------------------------------------------------------------------
 * 多架构构建（尤其 arm64 走 QEMU 模拟）动辄十几分钟，最不能接受的失败方式是
 * 「构建到一半才发现 COPY 的文件不存在」。本脚本把这类问题全部提前到秒级检出，
 * 且完全不依赖 Docker 守护进程 —— CI 的 lint 作业里跑，本地也能直接跑。
 *
 * 校验三件事的一致性：
 *   Dockerfile  ↔  仓库真实文件        （COPY 源存在且未被 .dockerignore 误排除）
 *   Dockerfile  ↔  src/config/index.js （端口、数据目录等运行时契约）
 *   Dockerfile  ↔  docker-compose.yml  （挂载点、安全选项）
 *
 * 用法：node scripts/docker-lint.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let passed = 0;
const failures = [];

function ok(name, detail = '') {
  passed += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? `  \x1b[90m${detail}\x1b[0m` : ''}`);
}
function fail(name, detail = '') {
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `  \x1b[31m${detail}\x1b[0m` : ''}`);
}
function check(name, cond, detail = '') {
  if (cond) ok(name, detail);
  else fail(name, detail);
  return !!cond;
}

const abs = (p) => path.join(ROOT, p);
const read = (p) => fs.readFileSync(abs(p), 'utf8');
const exists = (p) => fs.existsSync(abs(p));

/** 把 glob 片段转成正则：* 不跨目录，** 跨目录 */
function globToRe(pat) {
  const body = pat
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*');
  return new RegExp('^' + body + '$');
}

/* ===================== 1. .dockerignore 语义 ===================== */

const ignoreText = read('.dockerignore');

const ignoreRules = ignoreText
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'))
  .map((l) => {
    const negate = l.startsWith('!');
    const pat = l.replace(/^!/, '').replace(/\/+$/, '');
    return { negate, hasSlash: pat.includes('/'), re: globToRe(pat) };
  });

/**
 * 判定某个相对路径是否被 .dockerignore 排除。
 * 采用与 Docker 一致的 gitignore 式语义：不含 `/` 的规则按路径段匹配（同名的文件
 * 或目录出现在任意层级都命中），含 `/` 的规则按完整相对路径匹配；后出现的规则覆盖
 * 先出现的，因此 `!` 例外可以把它前面的排除规则撤销。
 */
function isIgnored(p) {
  const segs = p.split('/');
  let ignored = false;
  for (const r of ignoreRules) {
    const hit = r.hasSlash ? r.re.test(p) : segs.some((s) => r.re.test(s));
    if (hit) ignored = !r.negate;
  }
  return ignored;
}

/** 解析 COPY 源，返回该模式实际命中的文件列表（支持 * 通配） */
function resolveSource(src) {
  const local = src.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!/[*?]/.test(local)) return exists(local) ? [local] : [];

  const idx = local.lastIndexOf('/');
  const dir = idx === -1 ? '' : local.slice(0, idx);
  const base = idx === -1 ? local : local.slice(idx + 1);
  if (dir && !exists(dir)) return [];

  const re = globToRe(base);
  return fs
    .readdirSync(abs(dir))
    .filter((n) => re.test(n))
    .map((n) => (dir ? `${dir}/${n}` : n));
}

/** 目录内是否存在至少一个未被忽略的文件（防止 COPY 了个空目录） */
function hasVisibleContent(dirRel) {
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (isIgnored(childRel)) continue;
        if (walk(path.join(dir, e.name), childRel)) return true;
      } else if (!isIgnored(childRel)) {
        return true;
      }
    }
    return false;
  };
  return walk(abs(dirRel), dirRel);
}

/* ===================== 2. 解析 Dockerfile ===================== */

const dockerfile = read('Dockerfile');
const compose = read('docker-compose.yml');
const configJs = read('src/config/index.js');

// 只取来自构建上下文的 COPY（--from=xxx 是阶段间复制，不依赖仓库文件）
const contextCopies = [];
for (const line of dockerfile.split(/\r?\n/)) {
  if (!/^\s*COPY\b/i.test(line)) continue;
  const rest = line.replace(/^\s*COPY\s+/i, '');
  if (rest.includes('--from=')) continue;
  const args = rest.split(/\s+/).filter(Boolean);
  for (const src of args.slice(0, -1)) contextCopies.push(src);
}

/* ===================== 检查项 ===================== */

console.log('\n【1】构建产物清单一致性');

check('Dockerfile 存在来自构建上下文的 COPY 指令', contextCopies.length > 0, `共 ${contextCopies.length} 条`);

for (const src of contextCopies) {
  const matched = resolveSource(src);
  if (!check(`COPY 源存在：${src}`, matched.length > 0, matched.length ? matched.join(', ') : '未匹配到任何文件')) {
    continue;
  }
  for (const m of matched) {
    const st = fs.statSync(abs(m));
    if (st.isDirectory()) {
      check(`COPY 目录未被 .dockerignore 清空：${src}`, hasVisibleContent(m));
    } else {
      check(`COPY 文件未被 .dockerignore 排除：${m}`, !isIgnored(m));
    }
  }
}

console.log('\n【2】Dockerfile 与运行时配置一致');

// 入口文件必须真实存在，且落在某个被 COPY 的目录里，否则镜像里没有可执行的入口
const cmdMatch = dockerfile.match(/^\s*CMD\s*\[(.*)\]\s*$/im);
const entry = cmdMatch
  ? cmdMatch[1]
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .pop()
  : '';

check('CMD 指向的文件真实存在', !!entry && exists(entry), entry);
check(
  'CMD 指向的文件会进入镜像',
  !!entry &&
    contextCopies.some((c) => {
      const base = c.replace(/^\.\//, '').replace(/\/+$/, '');
      return entry === base || entry.startsWith(base + '/');
    }),
  entry,
);

// 端口：Dockerfile 与 config 默认值必须一致，否则 compose 映射与文档里的访问地址都会对不上
const dfPort = (dockerfile.match(/^\s*PORT=(\d+)/m) || [])[1];
const cfgPort = (configJs.match(/envInt\('PORT',\s*(\d+)\)/) || [])[1];
check('EXPOSE 端口与 config 默认端口一致', dockerfile.includes(`EXPOSE ${cfgPort}`), `应为 ${cfgPort}`);
check('ENV PORT 与 config 默认端口一致', dfPort === cfgPort, `Dockerfile=${dfPort} config=${cfgPort}`);

// 数据目录：Dockerfile 的 ENV 必须与 compose 挂载目标一致，
// 否则数据写进容器可写层，重启即丢
const dfData = (dockerfile.match(/^\s*DATA_DIR=(\S+)/m) || [])[1];
const dfStorage = (dockerfile.match(/^\s*STORAGE_DIR=(\S+)/m) || [])[1];
check('compose 的 data 挂载点与 DATA_DIR 一致', compose.includes(`:${dfData}`), dfData);
check('compose 的 storage 挂载点与 STORAGE_DIR 一致', compose.includes(`:${dfStorage}`), dfStorage);

// HEALTHCHECK 探测的路由必须真实存在，否则容器永远 unhealthy
const healthRoute = (dockerfile.match(/curl\s+\S+\s+https?:\/\/[^\s/]+\/([^\s|]+)/) || [])[1] || '';
const routeSource = fs
  .readdirSync(abs('src/routes'))
  .map((f) => read(path.join('src/routes', f)))
  .join('\n');
const healthPath = healthRoute.replace(/^api/, '');
check(`HEALTHCHECK 探测的路由真实存在：/${healthRoute}`, !!healthRoute && routeSource.includes(`'${healthPath}'`), healthPath);
check('HEALTHCHECK 已安装探测所需的 curl', /apt-get install[^\n]*\bcurl\b/.test(dockerfile));

console.log('\n【3】容器安全与信号处理');

check('以非 root 用户运行（存在 USER 指令）', /^\s*USER\s+\S+/m.test(dockerfile), (dockerfile.match(/^\s*USER\s+(\S+)/m) || [])[1]);
check('安装 tini 负责信号转发与僵尸进程回收', /apt-get install[^\n]*\btini\b/.test(dockerfile));
check('ENTRYPOINT 使用 tini', /ENTRYPOINT\s*\[.*tini/.test(dockerfile));
check('compose 未开启 privileged 模式', !/privileged:\s*true/.test(compose));
check('compose 开启 no-new-privileges', /no-new-privileges:true/.test(compose));

console.log('\n【4】Compose 编排与交付文件');

check('compose 声明了 build context', /context:\s*\./.test(compose));
const composeDf = (compose.match(/dockerfile:\s*(\S+)/) || [])[1];
check('compose 指定的 dockerfile 存在', !!composeDf && exists(composeDf), composeDf);
// compose 用 env_file: .env 而 .env 不入库，必须有 .env.example 兜底，否则新克隆无法启动
check('compose 依赖的 .env 有 .env.example 模板', !/env_file/.test(compose) || exists('.env.example'));
check('package-lock.json 存在（Dockerfile 走可复现的 npm ci）', exists('package-lock.json'));
check('README.md 存在（镜像内与 /api-docs 的数据源）', exists('README.md'));
check('docs/API.md 存在（/api-docs 页面数据源）', exists('docs/API.md'));
check('CI 工作流存在', exists('.github/workflows/ci.yml'));
check('CI 容器级验证脚本存在', exists('scripts/ci-container-check.sh'));

console.log('');
if (failures.length) {
  console.log(`\x1b[31m检查结果  通过 ${passed} 项，失败 ${failures.length} 项\x1b[0m\n`);
  for (const f of failures) console.log(`  · ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`\x1b[32m检查结果  通过 ${passed} 项，失败 0 项\x1b[0m`);
console.log('全部通过 ✔\n');
