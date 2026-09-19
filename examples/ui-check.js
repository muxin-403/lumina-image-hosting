'use strict';

/**
 * 前端运行时检查（jsdom）
 * ------------------------------------------------------------------
 * 用 jsdom 真实加载上传页与管理台，执行其中的脚本，捕获任何运行时异常，
 * 并驱动一次真实上传与一次真实登录，验证界面确实渲染出了内容。
 *
 * 覆盖 6 个部分：
 *   1. 上传页加载与初始化          2. 真实上传流程与多格式引用
 *   3. 客户端 WebP 转换（核心需求）  4. 管理台登录与控制台渲染
 *   5. 管理台配置表单与存储自检      6. 上传列表逐张进度与单张删除
 *
 * 第 3 部分为 jsdom 注入了 Canvas / createImageBitmap 的替身，用于端到端
 * 验证「浏览器内转 WebP」这条核心链路，包括 GIF/SVG/AVIF 的跳过规则与
 * Safari toBlob 静默回退的兜底判断。
 *
 * 这不是替代真实浏览器的手段，但能确定性地抓住「脚本一加载就报错」
 * 「DOM id 对不上」「接口字段名不匹配」这类最常见的前端问题，
 * 且不需要下载 Chromium（体积 500MB 级）。
 *
 * 依赖 jsdom（devDependency）：
 *   npm install            # 会一并安装 devDependencies
 *   node examples/ui-check.js
 *
 * 用法：
 *   BASE=http://localhost:3100 ADMIN_PASSWORD=admin123 node examples/ui-check.js
 */

const path = require('path');
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');

const BASE = process.env.BASE || 'http://localhost:3100';
const PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

let pass = 0;
let fail = 0;
const failures = [];

const ok = (m, d = '') => { pass += 1; console.log(`  \x1b[32m✓\x1b[0m ${m}${d ? `  \x1b[90m${d}\x1b[0m` : ''}`); };
const bad = (m, d = '') => { fail += 1; failures.push(`${m}${d ? ` — ${d}` : ''}`); console.log(`  \x1b[31m✗\x1b[0m ${m}${d ? `  \x1b[31m${d}\x1b[0m` : ''}`); };
const assert = (c, m, d = '') => { (c ? ok : bad)(m, d); return c; };
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把 Node 的 fetch 注入 jsdom，并把相对路径补全为绝对地址 */
function makeFetch(window) {
  return async (input, init) => {
    const url = typeof input === 'string' && input.startsWith('/') ? BASE + input : input;
    return fetch(url, init);
  };
}

async function loadPage(pathname) {
  const html = await (await fetch(BASE + pathname)).text();
  const errors = [];
  const warnings = [];

  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => {
    // canvas / scrollTo 之类 jsdom 未实现的 API 只记为 warning，不算失败
    if (/Not implemented/.test(e.message)) warnings.push(e.message.split('\n')[0]);
    else errors.push(`${e.type || 'error'}: ${e.message}`);
  });
  virtualConsole.on('error', (...args) => errors.push(`console.error: ${args.join(' ')}`));

  const dom = new JSDOM(html, {
    url: BASE + pathname,
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    virtualConsole,
  });

  // 注入 fetch（jsdom 本身不提供）
  dom.window.fetch = makeFetch(dom.window);
  dom.window.Response = Response;
  dom.window.Headers = Headers;

  // 等待外部脚本加载完成
  await new Promise((resolve) => {
    if (dom.window.document.readyState === 'complete') return resolve();
    dom.window.addEventListener('load', resolve);
    setTimeout(resolve, 5000);
  });
  // 等待 DOMContentLoaded 后的异步逻辑（拉配置 / 登录态）
  await sleep(1200);

  return { dom, window: dom.window, document: dom.window.document, errors, warnings };
}

/* ========================================================================= */

async function main() {
  console.log(`\n\x1b[1mLumina 图床 · 前端运行时检查（jsdom）\x1b[0m\n目标: ${BASE}`);

  /* ------------------------- 1. 上传页 ------------------------- */
  section('1. 上传页加载与初始化');

  const home = await loadPage('/');
  const { window: W, document: D } = home;

  assert(home.errors.length === 0, '脚本加载无运行时异常',
    home.errors.slice(0, 2).join(' | '));

  // 注意：common.js 用 `const Lumina = ...` 声明，属于词法绑定，
  // 不会成为 window 的属性（但脚本间可正常访问）。因此用 eval 检查。
  assert(W.eval('typeof Lumina') === 'object' && W.eval('typeof Lumina.request') === 'function',
    'common.js 正确暴露 Lumina 对象（含 request 等方法）',
    W.eval('typeof Lumina'));

  assert(D.querySelector('#dropzone') !== null, '拖拽上传区已渲染');
  assert(D.querySelector('#file-input').multiple === true, '文件选择器支持多选');

  const accept = D.querySelector('#file-input').getAttribute('accept') || '';
  assert(accept.includes('.png') && accept.includes('.svg') && accept.includes('.avif'),
    '文件选择器按服务端配置限制了可上传格式', accept);

  const limitHint = D.querySelector('#limit-hint').textContent;
  assert(/游客|管理员|≤/.test(limitHint), '配额提示已由 /api/config 填充', limitHint);

  const formatsHint = D.querySelector('#formats-hint').textContent;
  assert(/PNG/.test(formatsHint) && /SVG/.test(formatsHint),
    '格式提示已由服务端配置渲染', formatsHint);

  assert(D.title.includes('Lumina') || D.title.includes('图床'), '页面标题已按站点名设置', D.title);

  // 统一总进度条已被「逐张进度」取代
  assert(D.querySelector('#progress') === null, '统一总进度条已移除（改为逐张独立进度）');
  assert(D.querySelector('#queue-status') !== null, '上传列表提供在途任务计数位');

  // 剪贴板粘贴监听
  const before = D.querySelectorAll('.result').length;
  assert(before === 0, '初始状态无上传结果卡片');

  /* --------------------- 2. 真实上传流程 --------------------- */
  section('2. 真实上传流程（驱动 file input change 事件）');

  const pngPath = path.join(__dirname, '..', 'tmp-assets', 'sample.png');
  if (!fs.existsSync(pngPath)) {
    console.error(`\n\x1b[31m缺少测试素材，请先执行：node examples/make-test-assets.js\x1b[0m\n`);
    process.exit(1);
  }
  const buf = fs.readFileSync(pngPath);
  const file = new W.File([new Uint8Array(buf)], 'ui-check.png', { type: 'image/png' });

  const input = D.querySelector('#file-input');
  Object.defineProperty(input, 'files', { value: [file], writable: false, configurable: true });
  input.dispatchEvent(new W.Event('change', { bubbles: true }));

  // 上传一开始就会插入任务卡片，这里等这张卡片升级为「完成」态
  for (let i = 0; i < 40; i += 1) {
    if (D.querySelectorAll('.result[data-state="done"]').length > 0) break;
    await sleep(250);
  }

  const cards = D.querySelectorAll('.result');
  assert(cards.length === 1, '上传任务卡片已渲染', `${cards.length} 张`);

  if (cards.length) {
    const card = cards[0];
    assert(card.querySelector('.thumb img') !== null, '结果卡片包含缩略图');
    assert(card.querySelector('.badges') !== null, '结果卡片显示状态徽标');
    assert(card.querySelectorAll('.tabs button').length === 5,
      '提供 5 个引用格式切换标签（直链/Markdown/HTML/BBCode/缩略图）',
      [...card.querySelectorAll('.tabs button')].map((b) => b.textContent).join(' / '));

    const field = card.querySelector('[data-field]');
    const url = field.value || field.textContent;
    assert(/\/i\/\d{4}\/\d{2}\/.+\.png$/.test(url), '直链格式正确', url);
    assert(D.querySelector('#results-section').hidden === false, '结果区已从隐藏切换为显示');
    assert(D.querySelector('#empty-tip').hidden === true, '空状态提示已隐藏');

    // 切换到 Markdown 标签，验证前端拼接
    card.querySelector('.tabs button[data-tab="markdown"]').dispatchEvent(
      new W.MouseEvent('click', { bubbles: true }),
    );
    await sleep(120);
    const mdField = card.querySelector('[data-field]');
    const md = mdField.value || mdField.textContent;
    assert(/^!\[.*\]\(http.*\)$/.test(md), '切换 Markdown 标签后内容正确刷新', md);

    // 直链应可真实访问
    const probed = await fetch(url, { method: 'HEAD' });
    assert(probed.status === 200, '上传得到的直链可被真实访问', `HTTP ${probed.status}`);
  }

  W.close();

  /* ------------- 3. 客户端 WebP 转换（核心需求，端到端验证） ------------- */
  section('3. 客户端 WebP 转换（核心需求）');

  const assetPath = (n) => path.join(__dirname, '..', 'tmp-assets', n);
  const assetBytes = (n) => new Uint8Array(fs.readFileSync(assetPath(n)));

  for (const need of ['sample.jpg', 'sample.webp', 'anim.gif', 'vector.svg', 'sample.avif']) {
    if (!fs.existsSync(assetPath(need))) {
      console.error(`\n\x1b[31m缺少测试素材 ${need}，请先执行：node examples/make-test-assets.js\x1b[0m\n`);
      process.exit(1);
    }
  }

  // jsdom 不实现 Canvas 与 createImageBitmap。这里注入等价能力的替身，
  // 并让 toBlob 吐出「真实可解码的 WebP 字节」，使服务端 Sharp 能正常接收，
  // 从而端到端跑通「浏览器内转换 → 上传 → 落盘」整条链路。
  const realWebp = fs.readFileSync(assetPath('sample.webp'));

  function mockCanvas(win, mime) {
    win.createImageBitmap = async () => ({ width: 800, height: 600, close() {} });
    win.HTMLCanvasElement.prototype.getContext = () => ({ drawImage() {} });
    win.HTMLCanvasElement.prototype.toBlob = (cb) =>
      cb(new win.Blob([new Uint8Array(realWebp)], { type: mime }));
  }

  /**
   * 驱动 file input 触发一次上传，返回本次新增的那张完成卡片及其直链。
   * 用 uid 差集定位新卡片：任务卡片是追加到列表末尾的，不能再默认取第一个。
   */
  async function pickAndUpload(win, doc, file) {
    const before = new Set([...doc.querySelectorAll('.result')].map((el) => el.dataset.uid));
    const freshCard = () =>
      [...doc.querySelectorAll('.result[data-state="done"]')].find((el) => !before.has(el.dataset.uid)) || null;

    const input = doc.querySelector('#file-input');
    Object.defineProperty(input, 'files', { value: [file], writable: false, configurable: true });
    input.dispatchEvent(new win.Event('change', { bubbles: true }));

    for (let i = 0; i < 48; i += 1) {
      if (freshCard()) break;
      await sleep(250);
    }
    const card = freshCard();
    if (!card) return { card: null, url: '' };
    const field = card.querySelector('[data-field]');
    return { card, url: field ? field.value || field.textContent : '' };
  }

  // —— 3.1 可转换格式：应在浏览器内转成 WebP 后才上传 ——
  const pu = await loadPage('/');
  const PW = pu.window;
  const PD = pu.document;

  assert(pu.errors.length === 0, '上传页在注入 Canvas 替身后无运行时异常',
    pu.errors.slice(0, 2).join(' | '));
  // 转换开关已移至管理台：上传页不应再有本地开关，只读策略提示由 /api/config 下发
  assert(PD.querySelector('#opt-webp') === null, '上传页不再展示「客户端转 WebP」开关（已移至管理台）');
  assert(PD.querySelector('#client-policy-hint') !== null, '上传页展示由管理台配置下发的策略提示');

  mockCanvas(PW, 'image/webp');
  const rJpg = await pickAndUpload(PW, PD,
    new PW.File([assetBytes('sample.jpg')], 'photo.jpg', { type: 'image/jpeg' }));

  assert(/\/i\/\d{4}\/\d{2}\/[A-Za-z0-9_-]+\.webp$/.test(rJpg.url),
    'JPEG 在客户端转为 WebP 后才上传（直链后缀为 .webp）', rJpg.url);
  assert(rJpg.card && /已转 WebP/.test(rJpg.card.textContent),
    '结果卡片标注「已转 WebP 省空间」徽标');

  const head = await fetch(rJpg.url, { method: 'HEAD' });
  assert((head.headers.get('content-type') || '').includes('image/webp'),
    '服务端落盘的确实是 WebP（Content-Type 校验）', head.headers.get('content-type'));

  // —— 3.2 不可转换格式：GIF 动图 / SVG 矢量 / AVIF 必须原样上传 ——
  const skipCases = [
    ['anim.gif', 'image/gif', 'gif', 'GIF 动图跳过客户端转换（canvas 会丢动画帧）'],
    ['vector.svg', 'image/svg+xml', 'svg', 'SVG 矢量图跳过客户端转换（canvas 会栅格化）'],
    ['sample.avif', 'image/avif', 'avif', 'AVIF 跳过客户端转换（本身通常已小于 WebP）'],
  ];
  for (const [name, mime, ext, label] of skipCases) {
    const r = await pickAndUpload(PW, PD, new PW.File([assetBytes(name)], name, { type: mime }));
    assert(new RegExp(`\\.${ext}$`).test(r.url), label, r.url);
  }
  PW.close();

  // —— 3.3 浏览器撒谎时（Safari 老版本 toBlob 静默回退成 PNG）不得误报成功 ——
  const pv = await loadPage('/');
  mockCanvas(pv.window, 'image/png'); // 冒充：请求 WebP，却回吐 PNG
  const rFallback = await pickAndUpload(pv.window, pv.document,
    new pv.window.File([assetBytes('sample.jpg')], 'fallback.jpg', { type: 'image/jpeg' }));

  assert(/\.jpg$/.test(rFallback.url),
    'toBlob 回退成 PNG 时判定为未转换，按原格式上传', rFallback.url);
  assert(!/客户端转 WebP/.test(rFallback.card ? rFallback.card.textContent : ''),
    '回退场景下不显示「客户端转 WebP」徽标（不虚报收益）');
  pv.window.close();

  // —— 3.4 浏览器完全不支持 createImageBitmap 时：静默按原格式上传，不报错 ——
  const pw = await loadPage('/');
  delete pw.window.createImageBitmap; // 模拟不支持的旧浏览器
  const rUnsupported = await pickAndUpload(pw.window, pw.document,
    new pw.window.File([assetBytes('sample.jpg')], 'no-bitmap.jpg', { type: 'image/jpeg' }));

  assert(/\.jpg$/.test(rUnsupported.url),
    '浏览器不支持 createImageBitmap 时按原格式上传（无开关、无报错）', rUnsupported.url);
  assert(!/已转 WebP/.test(rUnsupported.card ? rUnsupported.card.textContent : ''),
    '不支持场景下不显示「已转 WebP」徽标');
  pw.window.close();

  /* ------------------------- 4. 管理台 ------------------------- */
  section('4. 管理台登录与控制台渲染');

  const admin = await loadPage('/admin');
  const AW = admin.window;
  const AD = admin.document;

  assert(admin.errors.length === 0, '管理台脚本加载无运行时异常',
    admin.errors.slice(0, 2).join(' | '));

  assert(AD.querySelector('#login-view').hidden === false, '未登录时显示登录表单');
  assert(AD.querySelector('#dash-view').hidden === true, '未登录时控制台保持隐藏');

  // 填入密码并提交
  AD.querySelector('#password').value = PASSWORD;
  AD.querySelector('#login-form').dispatchEvent(
    new AW.Event('submit', { bubbles: true, cancelable: true }),
  );

  for (let i = 0; i < 40; i += 1) {
    if (AD.querySelector('#dash-view').hidden === false) break;
    await sleep(250);
  }

  assert(AD.querySelector('#dash-view').hidden === false, '登录成功后切换到控制台');
  assert(AD.querySelector('#login-view').hidden === true, '登录表单已隐藏');
  assert(AD.querySelector('#logout-btn').hidden === false, '显示退出登录按钮');

  // 统计卡片
  const statCards = AD.querySelectorAll('#stats .stat');
  assert(statCards.length === 4, '渲染 4 张统计卡片', `${statCards.length} 张`);
  const statText = AD.querySelector('#stats').textContent;
  assert(/图片总数/.test(statText) && /占用空间/.test(statText) && /今日上传/.test(statText),
    '统计卡片包含总数 / 占用空间 / 今日上传');
  assert(/\d/.test(AD.querySelector('#stats .value').textContent),
    '统计数值已从接口填充', AD.querySelector('#stats .value').textContent);

  // 列表表格
  const rows = AD.querySelectorAll('#image-tbody tr');
  const realRows = [...rows].filter((r) => r.querySelector('input.row-select'));
  assert(realRows.length > 0, '图片列表渲染出数据行', `${realRows.length} 行`);
  assert(AD.querySelector('#page-info').textContent.includes('共'),
    '分页信息已渲染', AD.querySelector('#page-info').textContent.trim());
  assert(AD.querySelector('#filter-ext').querySelectorAll('option').length > 1,
    '格式筛选下拉框已按统计结果动态填充');

  if (realRows.length) {
    const first = realRows[0];
    assert(first.querySelector('img') !== null, '列表行显示缩略图');
    assert(first.querySelector('button[data-act="delete"]') !== null, '列表行提供删除按钮');
    assert(first.querySelector('button[data-act="copy"]') !== null, '列表行提供复制链接按钮');
  }

  // 勾选后批量操作栏出现
  const cb = AD.querySelector('.row-select');
  cb.checked = true;
  cb.dispatchEvent(new AW.Event('change', { bubbles: true }));
  await sleep(100);
  assert(AD.querySelector('#batch-bar').hidden === false, '勾选后出现批量操作栏');
  assert(/已选 1 张/.test(AD.querySelector('#selected-count').textContent),
    '批量操作栏显示已选数量');

  // 标签页切换
  section('5. 管理台配置表单');

  AD.querySelector('.tabs-nav button[data-tab="settings"]').dispatchEvent(
    new AW.Event('click', { bubbles: true }),
  );
  await sleep(900);

  assert(AD.querySelector('#tab-settings').hidden === false, '切换到「站点设置」标签页');
  assert(AD.querySelector('#tab-images').hidden === true, '「图片管理」标签页已隐藏');

  const siteName = AD.querySelector('#s-site-name').value;
  assert(siteName.length > 0, '站点名称字段已由 /api/settings 回填', siteName);

  const guestSize = Number(AD.querySelector('#s-guest-size').value);
  assert(guestSize === 5, '游客上限按 MB 回填（5MB → 5）', `${guestSize} MB`);

  const formatsVal = AD.querySelector('#s-formats').value;
  assert(/png/.test(formatsVal) && /avif/.test(formatsVal),
    '允许格式以逗号串回填', formatsVal);

  assert(AD.querySelector('#s-guest-enabled').checked === true, '游客上传开关回填为开启');
  assert(AD.querySelector('#s-optimize').checked === true, '服务端优化开关回填为开启');
  assert(AD.querySelector('#s-driver').value === 'local', '存储驱动下拉框回填为 local');
  assert(AD.querySelector('#s-dav-pass').value === '',
    'WebDAV 密码不回显明文（安全）');

  // 真实提交一次配置修改（把游客上限改成 6MB 再改回 5MB）
  AD.querySelector('#s-guest-size').value = '6';
  AD.querySelector('#settings-form').dispatchEvent(
    new AW.Event('submit', { bubbles: true, cancelable: true }),
  );
  await sleep(900);

  const afterSave = await fetch(`${BASE}/api/settings`, {
    headers: {
      Authorization: `Bearer ${AW.localStorage.getItem('lumina_token')}`,
    },
  });
  const saved = await afterSave.json();
  assert(saved.success && saved.data.guest_max_file_size === 6 * 1024 * 1024,
    '通过界面提交配置后服务端确实生效（5MB → 6MB）',
    `${saved.data?.guest_max_file_size} 字节`);

  // 还原
  await fetch(`${BASE}/api/settings`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${AW.localStorage.getItem('lumina_token')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ guest_max_file_size: 5 * 1024 * 1024 }),
  });
  ok('配置已还原为 5MB');

  // 存储自检
  AD.querySelector('.tabs-nav button[data-tab="storage"]').dispatchEvent(
    new AW.Event('click', { bubbles: true }),
  );
  await sleep(900);
  assert(AD.querySelector('#tab-storage').hidden === false, '切换到「存储与安全」标签页');
  assert(/本地磁盘可写/.test(AD.querySelector('#storage-health').textContent),
    '存储健康检查结果已渲染',
    AD.querySelector('#storage-health').textContent.trim().slice(0, 40));
  assert(AD.querySelector('#token-display').value.startsWith('ey'),
    '管理 Token 已展示在界面中（供脚本化调用）');

  // 留住 Token：第 6 部分要用它把环境调到确定状态，再验证删除链路
  const adminToken = AW.localStorage.getItem('lumina_token');
  assert(!!adminToken, '已取得管理员 Token（供后续用例构造确定性环境）');

  AW.close();

  /* ------------ 6. 上传列表：逐张进度与单张删除（本次新增能力） ------------ */
  section('6. 上传列表：逐张进度与单张删除');

  const sharp = require('sharp');

  // 把浏览器端并发上限临时固定为 2：5 张图里必然有图片停留在「排队中」，
  // 「上传进行中删除某一张」这条分支才能被确定性地触发。
  const patchSettings = (body) =>
    fetch(`${BASE}/api/settings`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const fixedConcurrency = await patchSettings({ client_max_concurrency: 2 });
  assert(fixedConcurrency.ok, '（前置）浏览器端并发上限已临时固定为 2', `HTTP ${fixedConcurrency.status}`);

  /** 现场生成内容唯一的 PNG：避开秒传（秒传复用的记录不签发删除凭证） */
  const uniquePng = (background) =>
    sharp({ create: { width: 1600, height: 1200, channels: 3, background } })
      .png({ compressionLevel: 6 })
      .toBuffer();

  const pk = await loadPage('/');
  const KW = pk.window;
  const KD = pk.document;
  // 本页不注入 Canvas 替身：跳过客户端转码，图片原样上传，便于核对直链与删除结果
  assert(pk.errors.length === 0, '上传页无运行时异常（逐张进度用例）', pk.errors.slice(0, 2).join(' | '));

  const colors = [
    { r: 12, g: 34, b: 56 },
    { r: 210, g: 40, b: 90 },
    { r: 30, g: 180, b: 70 },
    { r: 240, g: 200, b: 20 },
    { r: 90, g: 60, b: 220 },
  ];
  const batchFiles = [];
  for (let i = 0; i < colors.length; i += 1) {
    const buf = await uniquePng(colors[i]); // eslint-disable-line no-await-in-loop
    batchFiles.push(new KW.File([new Uint8Array(buf)], `batch-${i + 1}.png`, { type: 'image/png' }));
  }

  const kInput = KD.querySelector('#file-input');
  Object.defineProperty(kInput, 'files', { value: batchFiles, writable: false, configurable: true });
  kInput.dispatchEvent(new KW.Event('change', { bubbles: true }));

  // —— 6.1 一次多选：逐张建卡、逐张进度、逐张可删 ——
  const pendingCards = [...KD.querySelectorAll('.result')];
  assert(pendingCards.length === 5, '多张同时上传时逐张建立任务卡片', `${pendingCards.length} 张`);
  assert(KD.querySelectorAll('.result .task-progress').length === 5,
    '每张图片都有自己独立的进度条元素（取代统一总进度）');
  assert(KD.querySelectorAll('.result [data-remove]').length === 5,
    '每张图片都有自己独立的删除按钮');

  const pendingStates = pendingCards.map((el) => el.dataset.state);
  const queuedCards = pendingCards.filter((el) => el.dataset.state === 'queued');
  assert(pendingStates.every((s) => ['queued', 'converting', 'uploading'].includes(s)),
    '卡片初始处于排队 / 转码 / 上传中', pendingStates.join(','));
  assert(queuedCards.length >= 1, '超出并发上限的图片停留在排队状态', pendingStates.join(','));

  const queueHint = KD.querySelector('#queue-status');
  assert(queueHint.hidden === false && /张上传中/.test(queueHint.textContent),
    '列表头部显示在途任务计数', queueHint.textContent);

  // —— 6.2 上传进行中单独删除一条：取消该任务并清理它自己的资源与状态 ——
  const victimPending = queuedCards[queuedCards.length - 1];
  const victimPendingUid = victimPending.dataset.uid;
  const victimPendingName = victimPending.querySelector('.name span').textContent;

  victimPending.querySelector('[data-remove]').dispatchEvent(new KW.MouseEvent('click', { bubbles: true }));

  for (let i = 0; i < 40; i += 1) {
    if (!KD.querySelector(`.result[data-uid="${victimPendingUid}"]`)) break;
    await sleep(250);
  }
  assert(KD.querySelector(`.result[data-uid="${victimPendingUid}"]`) === null,
    '上传进行中删除：该条任务已从列表移除', victimPendingName);
  assert(KD.querySelectorAll('.result').length === 4,
    '其余任务不受影响（并发槽位互不干扰）', `${KD.querySelectorAll('.result').length} 张`);
  assert([...KD.querySelectorAll('.result')].every((c) => c.querySelector('[data-remove]')),
    '剩余任务各自保留删除按钮');

  // —— 6.3 其余任务正常跑完，各自升级为带引用格式的结果卡片 ——
  for (let i = 0; i < 80; i += 1) {
    if (KD.querySelectorAll('.result[data-state="done"]').length === 4) break;
    await sleep(250);
  }
  const doneCards = [...KD.querySelectorAll('.result[data-state="done"]')];
  assert(doneCards.length === 4, '其余 4 张全部上传完成', `${doneCards.length} 张`);
  assert(
    doneCards.every((c) => c.querySelectorAll('.tabs button').length === 5 && c.querySelector('[data-field]')),
    '每张完成卡片各自提供 5 种引用格式与复制框',
  );
  assert(KD.querySelector('#queue-status').hidden === true, '全部结束后在途计数自动隐藏');

  // —— 6.4 上传完成后单独删除一条：连同服务端资源一起清理 ——
  const victim = doneCards[0];
  const victimId = victim.querySelector('a[href^="/d/"]').getAttribute('href').replace('/d/', '');
  const victimUrl = victim.querySelector('[data-field]').value;
  assert(/^[A-Za-z0-9_-]{4,64}$/.test(victimId), '完成卡片可定位到服务端图片 ID', victimId);

  const aliveBefore = await fetch(`${BASE}/api/images/${victimId}`);
  assert(aliveBefore.status === 200, '删除前该记录确实存在', `HTTP ${aliveBefore.status}`);

  victim.querySelector('[data-remove]').dispatchEvent(new KW.MouseEvent('click', { bubbles: true }));

  for (let i = 0; i < 40; i += 1) {
    if (KD.querySelectorAll('.result').length === 3) break;
    await sleep(250);
  }
  assert(KD.querySelectorAll('.result').length === 3,
    '完成后删除：该条任务已从列表移除', `${KD.querySelectorAll('.result').length} 张`);

  // 本页是游客身份（本地无 Token），删除靠的正是上传响应下发的 delete_key
  const goneAfter = await fetch(`${BASE}/api/images/${victimId}`);
  assert(goneAfter.status === 404, '服务端记录已同步清理（公开元数据接口 404）', `HTTP ${goneAfter.status}`);

  const deadLink = await fetch(victimUrl, { method: 'HEAD' });
  assert(deadLink.status === 404, '删除后原直链不再可访问', `HTTP ${deadLink.status}`);

  const restoredConcurrency = await patchSettings({ client_max_concurrency: 3 });
  assert(restoredConcurrency.ok, '并发上限已还原为 3');

  KW.close();

  /* ------------------------- 汇总 ------------------------- */
  console.log(`\n\x1b[1m检查结果\x1b[0m  通过 \x1b[32m${pass}\x1b[0m 项，失败 \x1b[31m${fail}\x1b[0m 项\n`);
  if (fail) {
    console.log('失败明细：');
    failures.forEach((f) => console.log(`  - ${f}`));
    console.log('');
    process.exit(1);
  }
  console.log('\x1b[32m全部通过 ✔\x1b[0m\n');
}

main().catch((err) => {
  console.error('\n\x1b[31m检查异常终止：\x1b[0m', err);
  process.exit(1);
});
