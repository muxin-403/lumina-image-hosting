/* ==========================================================================
   Lumina · 上传页逻辑
   拖拽 / 批量 / 剪贴板粘贴 → 客户端可选转 WebP → 并发上传（可配最大并发数） → 生成多格式引用
   ========================================================================== */

(() => {
  'use strict';

  const { request, toast, copyWithToast, formatSize, escapeHtml, downloadText, applyFavicon } = Lumina;

  /* ------------------------------- 元素 ------------------------------- */
  const $ = (id) => document.getElementById(id);
  const dz = $('dropzone');
  const fileInput = $('file-input');
  const progress = $('progress');
  const progressBar = $('progress-bar');
  const progressText = $('progress-text');
  const resultList = $('result-list');
  const resultsSection = $('results-section');
  const emptyTip = $('empty-tip');
  const resultCount = $('result-count');

  /** 内存中的上传结果（用于「复制全部 / 导出」） */
  const results = [];
  /**
   * 站点配置（来自 /api/config）。
   * 客户端上传策略（是否转 WebP / 是否压缩 / 质量 / 自动复制）
   * 由管理台统一配置，前端只读不展示开关。
   */
  let config = {
    allowed_formats: [],
    guest_upload_enabled: true,
    max_files: 20,
    client_convert_webp: true,
    client_compress: false,
    client_webp_quality: 82,
    client_max_concurrency: 3,
    auto_copy_url: false,
  };

  const FORMAT_TABS = [
    { key: 'url', label: '直链' },
    { key: 'markdown', label: 'Markdown' },
    { key: 'html', label: 'HTML' },
    { key: 'bbcode', label: 'BBCode' },
    { key: 'thumbnail', label: '缩略图' },
  ];

  /* ---------------------------- 初始化配置 ---------------------------- */

  async function loadConfig() {
    try {
      config = await request('/api/config');
      $('brand-name').textContent = config.site_name || 'Lumina 图床';
      document.title = `${config.site_name || 'Lumina 图床'} · 拖拽即上传`;
      applyFavicon(config.favicon_url);
      $('formats-hint').textContent = (config.allowed_formats || [])
        .map((f) => f.toUpperCase())
        .join(' · ');
      fileInput.setAttribute('accept', (config.allowed_formats || ['image/*']).map((e) => `.${e}`).join(','));

      const limiter = config.guest_upload_enabled
        ? `游客单文件 ≤ ${formatSize(config.guest_max_file_size)} · 单次 ≤ ${config.max_files} 个`
        : '本站已关闭游客上传，仅管理员可上传';
      $('limit-hint').textContent = limiter;

      // 展示管理台下发的客户端处理策略（前端无开关，仅提示）
      const policy = [];
      if (config.client_convert_webp) {
        policy.push(config.client_compress
          ? `客户端转 WebP（质量 ${config.client_webp_quality}）`
          : '客户端转 WebP（不压缩）');
      }
      const policyEl = $('client-policy-hint');
      if (policyEl) {
        policyEl.textContent = policy.length ? `${policy.join('，')} · 策略由管理台配置` : '';
        policyEl.hidden = policy.length === 0;
      }

      if (!config.guest_upload_enabled) {
        dz.style.opacity = '.7';
        toast('本站已关闭游客上传，请登录管理员后再上传', 'error', 5000);
      }
    } catch (err) {
      toast(`读取站点配置失败：${err.message}`, 'error');
    }
  }

  /* ------------------------------ 文件校验 ------------------------------ */

  function extOf(name) {
    const m = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
  }

  /** 依据后端配置的允许格式做前置校验，避免无谓的网络往返 */
  function checkFile(file) {
    const allowed = (config.allowed_formats || []).map((s) => s.toLowerCase());
    const ext = extOf(file.name);
    const alias = ext === 'jpeg' ? ['jpeg', 'jpg'] : [ext];
    if (allowed.length && !alias.some((e) => allowed.includes(e))) {
      return `不支持的格式 .${ext || '未知'}（允许：${allowed.join(', ')}）`;
    }
    if (!file.size) return '空文件';
    return null;
  }

  /* ---------------------- 客户端 WebP 转换（核心需求） ---------------------- */

  /**
   * 在浏览器内把 JPG/PNG/BMP 转成 WebP：
   *  - 服务端零算力消耗，上传体积更小、更快
   *  - GIF（动图）、SVG（矢量）、AVIF 直接跳过：canvas 会破坏动画/矢量特性，
   *    AVIF 本身通常已比 WebP 更小
   */
  async function convertToWebp(file, quality) {
    const convertible = ['image/jpeg', 'image/png', 'image/bmp', 'image/jpg'];
    if (!convertible.includes(file.type)) return { file, converted: false };

    if (typeof createImageBitmap !== 'function') return { file, converted: false };

    try {
      const bitmap = await createImageBitmap(file);
      // 超大图会让 canvas 在某些浏览器上失败，这里设一个安全上限
      if (bitmap.width > 16384 || bitmap.height > 16384) {
        bitmap.close && bitmap.close();
        return { file, converted: false };
      }

      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close && bitmap.close();

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
      // toBlob 在 Safari 老版本会静默回退成 PNG，此时 blob.type 不是 webp
      if (!blob || blob.type !== 'image/webp') return { file, converted: false };
      if (blob.size >= file.size) return { file, converted: false }; // 没有收益就不转

      const baseName = file.name.replace(/\.[^.]+$/, '') || 'image';
      const converted = new File([blob], `${baseName}.webp`, {
        type: 'image/webp',
        lastModified: Date.now(),
      });
      return { file: converted, converted: true, savedBytes: file.size - blob.size };
    } catch (_) {
      return { file, converted: false };
    }
  }

  /* ------------------------------ 上传逻辑 ------------------------------ */

  /** 用 XHR 以获取真实上传进度（fetch 目前无法报告上传进度） */
  function uploadXHR(file, onProgress) {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append('file', file, file.name);

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload', true);

      const token = Lumina.store.get(Lumina.TOKEN_KEY);
      if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      });

      xhr.addEventListener('load', () => {
        let payload = null;
        try {
          payload = JSON.parse(xhr.responseText);
        } catch (_) { /* 保持 null */ }

        if (xhr.status >= 200 && xhr.status < 300 && payload && payload.success) {
          resolve(payload.data);
        } else {
          const msg = (payload && payload.error && payload.error.message) || `上传失败（HTTP ${xhr.status}）`;
          const err = new Error(msg);
          err.status = xhr.status;
          reject(err);
        }
      });

      xhr.addEventListener('error', () => reject(new Error('网络错误，上传中断')));
      xhr.addEventListener('abort', () => reject(new Error('上传已取消')));
      xhr.send(form);
    });
  }

  function setProgress(ratio, text) {
    progress.hidden = false;
    progressBar.style.width = `${Math.round(ratio * 100)}%`;
    progressText.textContent = text || `${Math.round(ratio * 100)}%`;
  }

  /**
   * 并发处理整批文件（worker 池模型）：
   *  - 最大同时在途张数由管理台配置项 client_max_concurrency 控制（1–6，默认 3）
   *  - 每张图片按批次下标占用独立「槽位」，结果 / 进度 / 失败信息均与原文件一一对应，
   *    不依赖完成顺序；JS 单线程事件循环内领取下标，无竞态
   *  - 整体进度 =（已完成数 + 在途已传比例之和）/ 总数，实时反映并发状态
   */
  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    if (!config.guest_upload_enabled) {
      toast('本站已关闭游客上传', 'error');
      return;
    }

    const maxFiles = config.max_files || 20;
    const batch = files.slice(0, maxFiles);
    if (files.length > maxFiles) {
      toast(`单次最多 ${maxFiles} 个文件，本次仅上传前 ${maxFiles} 个`, 'info', 4000);
    }

    // 压缩策略由管理台配置：未开启压缩时按最高质量编码（仅转格式、不做有损压缩）
    const quality = config.client_convert_webp && config.client_compress
      ? Math.min(100, Math.max(40, Number(config.client_webp_quality) || 82)) / 100
      : 1;

    // 最大并发数：越界 / 非法配置一律回落到 1–6 区间内的安全值
    const maxConcurrent = Math.min(6, Math.max(1, Math.round(Number(config.client_max_concurrency) || 3)));

    // 槽位状态：与 batch 下标严格对应，并发下互不干扰
    const slotItems = new Array(batch.length).fill(null); // 成功结果（数组，防御多 item 响应）
    const slotProgress = new Array(batch.length).fill(0); // 上传进度 0–1
    const slotDone = new Array(batch.length).fill(false); // 是否已结束（无论成败）

    let nextIndex = 0; // 下一个待处理文件的下标（同步领取，无竞态）
    let okCount = 0;
    let failCount = 0;
    let savedBytes = 0;
    let lastUrl = null;

    /** 聚合整体进度：已完成槽位记 1，在途槽位累加各自比例 */
    const renderOverall = () => {
      let done = 0;
      let inflight = 0;
      for (let i = 0; i < batch.length; i += 1) {
        if (slotDone[i]) done += 1;
        else inflight += slotProgress[i];
      }
      setProgress((done + inflight) / batch.length, `已完成 ${done}/${batch.length}${failCount ? ` · 失败 ${failCount}` : ''}`);
    };

    /** 处理单个文件：校验 → 可选转 WebP → 上传，结果写入自身槽位 */
    const processOne = async (i) => {
      const raw = batch[i];

      const invalid = checkFile(raw);
      if (invalid) {
        failCount += 1;
        slotDone[i] = true;
        toast(`${raw.name}：${invalid}`, 'error', 4000);
        renderOverall();
        return;
      }

      let file = raw;
      let converted = false;
      if (config.client_convert_webp) {
        const r = await convertToWebp(raw, quality);
        file = r.file;
        converted = r.converted;
        if (r.converted) savedBytes += r.savedBytes;
      }

      try {
        const data = await uploadXHR(file, (p) => {
          slotProgress[i] = p; // 仅写本槽位，不影响其它在途请求
          renderOverall();
        });

        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          item._clientConverted = converted;
          item._originalName = raw.name;
          item._originalSize = raw.size;
        }
        slotItems[i] = items;
        okCount += 1;
        if (items[0] && items[0].url) lastUrl = items[0].url;
      } catch (err) {
        failCount += 1;
        toast(`${raw.name}：${err.message}`, 'error', 4500);
      } finally {
        slotDone[i] = true;
        slotProgress[i] = 1;
        renderOverall();
      }
    };

    // 启动固定数量的 worker：每个 worker 循环领取下一个下标，直到队列取空。
    // worker 数量 = min(最大并发数, 文件数)，保证单张文件时不会多开空任务。
    const workerCount = Math.min(maxConcurrent, batch.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (nextIndex < batch.length) {
        const i = nextIndex;
        nextIndex += 1;
        // 领取与自增在同一次同步执行中完成，事件循环保证不会重复分配
        await processOne(i); // eslint-disable-line no-await-in-loop
      }
    });

    // 等待全部 worker 退出；单张失败已在槽位内消化，不会中断整批
    await Promise.all(workers);

    setProgress(1, '完成');
    setTimeout(() => { progress.hidden = true; progressBar.style.width = '0'; }, 700);

    // 按批次顺序合并结果：从最后一个槽位向前 unshift，
    // 使结果列表保持「先选择的文件排在最前」，与串行版体验一致
    for (let i = batch.length - 1; i >= 0; i -= 1) {
      const items = slotItems[i];
      if (!items) continue; // 该槽位失败或被跳过
      for (let j = items.length - 1; j >= 0; j -= 1) results.unshift(items[j]);
    }
    renderResults();

    if (okCount) {
      const extra = savedBytes > 0 ? `，客户端转 WebP 省下 ${formatSize(savedBytes)}` : '';
      toast(`成功上传 ${okCount} 张${failCount ? `，失败 ${failCount} 张` : ''}${extra}`, 'success', 3400);
    }
    if (okCount && config.auto_copy_url && lastUrl) {
      copyWithToast(lastUrl, '直链已复制到剪贴板');
    }
  }

  /* ------------------------------ 结果渲染 ------------------------------ */

  function renderResults() {
    resultsSection.hidden = results.length === 0;
    emptyTip.hidden = results.length > 0;
    resultCount.textContent = String(results.length);

    resultList.innerHTML = results
      .map((item, index) => {
        const badge = [];
        if (item.vector) badge.push('<span class="badge info">矢量</span>');
        if (item.animated) badge.push('<span class="badge info">动态 ' + item.pages + ' 帧</span>');
        if (item._clientConverted) badge.push('<span class="badge ok">客户端转 WebP</span>');
        if (item.compression && item.compression.saved_bytes > 0) {
          badge.push(`<span class="badge ok">优化 −${item.compression.saved_percent}%</span>`);
        }
        if (item.duplicated) badge.push('<span class="badge warn">内容重复（秒传）</span>');

        const tabs = FORMAT_TABS.map(
          (t, ti) =>
            `<button type="button" data-tab="${t.key}" data-index="${index}" class="${ti === 0 ? 'active' : ''}">${t.label}</button>`,
        ).join('');

        const first = item.formats[FORMAT_TABS[0].key];
        const isLong = first.length > 90;

        return `
        <article class="card result" data-index="${index}">
          <a class="thumb" href="${escapeHtml(item.page_url)}" target="_blank" rel="noopener">
            <img src="${escapeHtml(item.thumb_url)}" alt="${escapeHtml(item.filename)}" loading="lazy" decoding="async" />
          </a>
          <div class="info">
            <div class="name">
              <span>${escapeHtml(item.filename)}</span>
            </div>
            <div class="meta">
              <span>${item.width || '?'} × ${item.height || '?'}</span>
              <span>${escapeHtml(item.size_human || formatSize(item.size))}</span>
              <span>${escapeHtml(item.ext.toUpperCase())}</span>
              <span>${escapeHtml(new Date(item.created_at).toLocaleString('zh-CN', { hour12: false }))}</span>
            </div>
            <div class="badges">${badge.join('')}</div>

            <div class="formats">
              <div class="tabs" role="tablist">${tabs}</div>
              <div class="copybox">
                ${
                  isLong
                    ? `<textarea readonly rows="2" data-field="${index}">${escapeHtml(first)}</textarea>`
                    : `<input readonly data-field="${index}" value="${escapeHtml(first)}" />`
                }
                <button class="btn primary sm" type="button" data-copy="${index}">复制</button>
                <a class="btn sm" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">打开</a>
                <a class="btn sm ghost" href="/d/${escapeHtml(item.id)}" title="下载原图">下载</a>
              </div>
            </div>
          </div>
        </article>`;
      })
      .join('');
  }

  /** 切换某个结果的引用格式 */
  function switchTab(index, key) {
    const item = results[index];
    if (!item) return;

    const art = resultList.querySelector(`.result[data-index="${index}"]`);
    if (!art) return;

    art.querySelectorAll('.tabs button').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === key);
    });

    const text = item.formats[key] || item.url;
    const box = art.querySelector('[data-field]');
    const next = document.createElement(text.length > 90 ? 'textarea' : 'input');
    next.setAttribute('readonly', '');
    next.dataset.field = String(index);
    next.value = text;
    if (next.tagName === 'TEXTAREA') next.rows = 2;
    box.replaceWith(next);
  }

  /* ------------------------------ 事件绑定 ------------------------------ */

  function bindDropzone() {
    dz.addEventListener('click', () => fileInput.click());
    dz.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput.click();
      }
    });

    fileInput.addEventListener('change', () => {
      handleFiles(fileInput.files);
      fileInput.value = ''; // 允许连续选择同一文件
    });

    let dragDepth = 0; // 处理子元素冒泡导致的 dragleave 抖动

    dz.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragDepth += 1;
      dz.classList.add('dragover');
    });
    dz.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    dz.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) dz.classList.remove('dragover');
    });
    dz.addEventListener('drop', (e) => {
      e.preventDefault();
      dragDepth = 0;
      dz.classList.remove('dragover');
      handleFiles(e.dataTransfer.files);
    });

    // 阻止拖到页面其它位置时浏览器直接打开图片
    ['dragover', 'drop'].forEach((type) => {
      window.addEventListener(type, (e) => {
        if (!dz.contains(e.target)) e.preventDefault();
      });
    });
  }

  /** 剪贴板粘贴上传：截图工具 / 复制图片后直接 Ctrl+V */
  function bindPaste() {
    document.addEventListener('paste', (e) => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      const files = [];

      for (const item of items) {
        if (item.kind === 'file' && /^image\//.test(item.type)) {
          const f = item.getAsFile();
          if (f) {
            // 剪贴板里的图片往往没有文件名，补一个语义化名字
            const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
            const named = f.name && f.name !== 'image.png'
              ? f
              : new File([f], `paste-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`, { type: f.type });
            files.push(named);
          }
        }
      }

      if (files.length) {
        e.preventDefault();
        toast(`从剪贴板获取到 ${files.length} 张图片`, 'info', 1800);
        handleFiles(files);
      }
    });
  }

  function bindResultActions() {
    resultList.addEventListener('click', (e) => {
      const tabBtn = e.target.closest('.tabs button');
      if (tabBtn) {
        switchTab(Number(tabBtn.dataset.index), tabBtn.dataset.tab);
        return;
      }
      const copyBtn = e.target.closest('[data-copy]');
      if (copyBtn) {
        const item = results[Number(copyBtn.dataset.copy)];
        const art = copyBtn.closest('.result');
        const field = art.querySelector('[data-field]');
        copyWithToast(field ? field.value : item.url);
      }
    });

    $('copy-all-url').addEventListener('click', () => {
      if (!results.length) return;
      copyWithToast(results.map((r) => r.url).join('\n'), `已复制 ${results.length} 条直链`);
    });

    $('copy-all-md').addEventListener('click', () => {
      if (!results.length) return;
      copyWithToast(results.map((r) => r.formats.markdown).join('\n'), `已复制 ${results.length} 条 Markdown`);
    });

    $('copy-all-bbcode').addEventListener('click', () => {
      if (!results.length) return;
      copyWithToast(results.map((r) => r.formats.bbcode).join('\n'), `已复制 ${results.length} 条 BBCode`);
    });

    $('download-urls').addEventListener('click', () => {
      if (!results.length) return;
      const lines = [
        `# Lumina 图床导出 · ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
        `# 共 ${results.length} 张`,
        '',
        ...results.map((r) => `${r.url}\t${r.filename}\t${r.width}x${r.height}\t${r.size_human}`),
      ];
      downloadText('lumina-urls.txt', lines.join('\n'));
      toast('已导出 URL 列表', 'success');
    });

    $('clear-results').addEventListener('click', () => {
      results.length = 0;
      renderResults();
    });
  }

  /* -------------------------------- 启动 -------------------------------- */

  document.addEventListener('DOMContentLoaded', () => {
    bindDropzone();
    bindPaste();
    bindResultActions();
    loadConfig();
  });
})();
