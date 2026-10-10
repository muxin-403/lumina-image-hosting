/* ==========================================================================
   Lumina · 上传页逻辑
   拖拽 / 批量 / 剪贴板粘贴 → 客户端可选转 WebP → 页面级全局并发上传 → 生成多格式引用
   --------------------------------------------------------------------------
   上传列表即结果列表：文件一提交就先占一条卡片（本地预览 + 独立进度条 + 删除按钮），
   上传完成后同一张卡片就地升级为结果卡片，全程不再有「统一总进度条」。
   任意状态下都能单独删除一条任务：
     - 未完成 → 中断在途请求 / 让排队的 worker 跳过，并释放本地预览
     - 已完成 → 携带上传时下发的 delete_key 清理服务端原图、缩略图与记录
   所有选图批次共享同一个并发调度器：页面内同时在途的任务总数受统一上限约束，
   连续多批选图不会叠加负载（client_max_concurrency 的语义是页面全局上限）。
   ========================================================================== */

(() => {
  'use strict';

  const { request, toast, copyWithToast, formatSize, escapeHtml, downloadText, applyFavicon } = Lumina;

  /* ------------------------------- 元素 ------------------------------- */
  const $ = (id) => document.getElementById(id);
  const dz = $('dropzone');
  const fileInput = $('file-input');
  const resultList = $('result-list');
  const resultsSection = $('results-section');
  const emptyTip = $('empty-tip');
  const resultCount = $('result-count');
  const queueStatus = $('queue-status');

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

  /** 任务状态 -> 卡片上的中文说明 */
  const STATE_TEXT = {
    queued: '排队中',
    converting: '正在转换格式',
    uploading: '上传中',
    processing: '服务端处理中',
    failed: '上传失败',
    retry_wait: '等待自动重试',
    canceled: '已取消',
  };

  /** 这些状态还没拿到可计算的进度字节数，进度条走不确定态动画 */
  const INDETERMINATE = ['queued', 'converting', 'processing', 'retry_wait'];

  /* ----------------------- 失败自动重试（重试队列） ----------------------- */

  /**
   * 自动重试策略：指数退避（3s → 6s → 12s），最多自动重试 3 次。
   * 只有「值得再试」的失败才进入重试队列：
   *   - 网络错误 / 请求被中断（无 HTTP 状态）—— 通常是瞬时网络抖动
   *   - HTTP 5xx —— 服务端临时故障
   *   - HTTP 408 / 429 —— 请求超时 / 触发限流，等待后重试有意义
   * 校验类失败（格式不支持、空文件）与 4xx 业务错误（未授权 / 文件过大等）
   * 重试也不会成功，直接停在失败态，交给用户决定（可手动重试）。
   */
  const AUTO_RETRY_BASE_MS = 3000;
  const MAX_AUTO_RETRIES = 3;

  function isRetryableError(err) {
    const s = err && err.status;
    if (s === undefined || s === 0) return true; // 网络错误 / 无状态码
    if (s >= 500) return true;
    return s === 408 || s === 425 || s === 429;
  }

  /** 第 N 次自动重试前的等待时长（指数退避） */
  const retryDelayMs = (autoRetries) => AUTO_RETRY_BASE_MS * 2 ** (autoRetries - 1);

  /** 卡片里没有本地预览时用的占位图标 */
  const PLACEHOLDER_THUMB = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.3" aria-hidden="true" style="width:34px;height:34px;color:var(--text-muted)">
    <rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8.5" cy="9" r="1.8" />
    <path d="M21 16l-5.5-5.5L5 21" stroke-linecap="round" stroke-linejoin="round" /></svg>`;

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
        ? `单张 ≤ ${formatSize(config.guest_max_file_size)}，一次最多 ${config.max_files} 张`
        : '当前仅管理员可上传，请先在管理台登录';
      $('limit-hint').textContent = limiter;

      // 展示管理台下发的客户端处理策略（前端无开关，仅提示）
      const policyEl = $('client-policy-hint');
      if (policyEl) {
        policyEl.textContent = config.client_convert_webp
          ? '上传时自动转为 WebP 以减小体积（管理员可在后台关闭）'
          : '';
        policyEl.hidden = !config.client_convert_webp;
      }

      if (!config.guest_upload_enabled) {
        dz.style.opacity = '.7';
        toast('当前仅管理员可上传，请先在管理台登录', 'error', 5000);
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

  /** 转换安全上限：任一边超过此值（浏览器 canvas 硬限制）时放弃转换 */
  const CONVERT_MAX_DIM = 16384;
  /**
   * 总像素预算 ≈ 4096×4096（16.7MP）：对齐 iOS Safari 的 canvas 面积上限。
   * 超预算的大图按原文件上传 —— 默认不做「预缩小主图」这种不可逆的分辨率损失，
   * 内存紧张的低端设备也不会为了转码一次性吃掉几百 MB 的位图 + 画布内存。
   */
  const CONVERT_MAX_PIXELS = 4096 * 4096;

  /**
   * 判断 GIF 是否为动画：完整遍历 GIF 块结构，统计图像描述符（0x2C）数量，
   * 超过 1 帧即为动画。动画 GIF 不参与转换 —— canvas 解码只会留下第一帧。
   * 结构无法解析或体积异常大时保守按动画处理（放弃转换，绝不含糊地丢帧）。
   */
  async function isAnimatedGif(file) {
    // 超大 GIF（> 32MB）不值得为转码整读进内存，保守视为动画直接跳过
    if (file.size > 32 * 1024 * 1024) return true;
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      if (buf.length < 14 || String.fromCharCode(buf[0], buf[1], buf[2]) !== 'GIF') return false;
      let p = 13; // 跳过 6 字节签名 + 7 字节逻辑屏幕描述符（宽/高/标志/背景色/宽高比）
      if (buf[10] & 0x80) p += 3 * (2 ** ((buf[10] & 0x07) + 1)); // 跳过全局色表
      let frames = 0;
      while (p < buf.length) {
        const b = buf[p++];
        if (b === 0x3B) break;            // 文件结束符
        if (b === 0x21) {
          p += 1;                          // 扩展块：跳过 label，后面跟子块序列
        } else if (b === 0x2C) {
          frames += 1;                     // 图像描述符：每出现一次就是一帧
          const lct = buf[p + 8];          // 描述符第 9 字节是标志位
          p += 9;                          // left/top/width/height + 标志位
          if (lct & 0x80) p += 3 * (2 ** ((lct & 0x07) + 1)); // 跳过局部色表
          p += 1;                          // LZW 最小编码长度字节
        } else {
          return true;                     // 非法块结构：保守按动画处理
        }
        // 扩展块与图像数据后面都是「子块序列」：长度字节 + 数据，0 长度即结束
        while (p < buf.length) {
          const len = buf[p++];
          if (!len) break;
          p += len;
        }
      }
      return frames > 1;
    } catch (_) {
      return true; // 读取失败时宁可放弃转换，也不冒丢动画的风险
    }
  }

  /** 把画布内容编码为 WebP Blob（toBlob 回调风格转 Promise，失败时返回 null） */
  function encodeWebp(canvas, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality));
  }

  /**
   * 在浏览器内把 JPG/PNG/BMP/静态 GIF 转成 WebP：
   *  - 服务端零算力消耗，上传体积更小、更快
   *  - 动画 GIF、SVG（矢量）、AVIF 直接跳过：canvas 会破坏动画/矢量特性，
   *    AVIF 本身通常已比 WebP 更小
   *  - 位图与画布的底层内存在所有路径上（含异常）都立即归还，不等 GC
   *
   * quality / lossyFallback 的语义（与 Chromium 的 toBlob 行为对齐）：
   *  - Chromium 把 quality = 1 的 image/webp 编码成「无损 WebP」。PNG / BMP
   *    走无损即可稳定获得体积收益；但 JPEG（有损压缩源）与 GIF（调色板源）
   *    无损压不过原文件 —— 这正是此前「除 PNG 外全都不转换」的根因：
   *    默认配置（client_compress 关闭）下 quality 恒为 1，JPEG/GIF 编码出的
   *    无损 WebP 比原文件更大，被「无收益不上传」守卫拦下，只有 PNG 能转。
   *  - 因此对 JPEG / 静态 GIF 直接按 lossyFallback（管理台配置的质量，上限
   *    0.99）做有损编码；PNG / BMP 维持无损路径，行为与之前完全一致。
   */
  async function convertToWebp(file, quality, lossyFallback = 0) {
    const convertible = ['image/jpeg', 'image/jpg', 'image/png', 'image/bmp', 'image/gif'];
    if (!convertible.includes(file.type)) return { file, converted: false };
    if (typeof createImageBitmap !== 'function') return { file, converted: false };
    if (file.type === 'image/gif' && await isAnimatedGif(file)) return { file, converted: false };

    let bitmap = null;
    try {
      bitmap = await createImageBitmap(file);
      const pixels = bitmap.width * bitmap.height;
      // 双重安全上限：单边超限或总像素超预算都直接放弃转换，按原文件上传
      if (bitmap.width > CONVERT_MAX_DIM || bitmap.height > CONVERT_MAX_DIM
        || pixels > CONVERT_MAX_PIXELS) {
        return { file, converted: false, pixels };
      }

      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);

      // 无损友好的源（PNG / BMP）保持原有无损路径；JPEG / 静态 GIF 用有损质量。
      // 0.99 上限规避 Chromium 的 quality=1 → 无损编码特例，同时视觉上不可辨。
      const losslessFriendly = file.type === 'image/png' || file.type === 'image/bmp';
      const lossyQuality = Math.min(Number(lossyFallback) || 0, 0.99);
      const effectiveQuality = (losslessFriendly || !(lossyQuality > 0 && lossyQuality < 1))
        ? quality
        : lossyQuality;

      const blob = await encodeWebp(canvas, effectiveQuality);

      // 编码结果已拿到，立刻归还画布的 backing store（置 0 是各浏览器通用的释放手法）
      canvas.width = 0;
      canvas.height = 0;

      // toBlob 在 Safari 老版本会静默回退成 PNG，此时 blob.type 不是 webp
      if (!blob || blob.type !== 'image/webp') return { file, converted: false, pixels };
      if (blob.size >= file.size) return { file, converted: false, pixels }; // 没有收益就不转

      const baseName = file.name.replace(/\.[^.]+$/, '') || 'image';
      const converted = new File([blob], `${baseName}.webp`, {
        type: 'image/webp',
        lastModified: Date.now(),
      });
      return { file: converted, converted: true, savedBytes: file.size - blob.size, pixels };
    } catch (_) {
      return { file, converted: false };
    } finally {
      // 所有返回路径统一在此归还位图内存（close 幂等，重复调用无副作用）
      if (bitmap && bitmap.close) {
        try {
          bitmap.close();
        } catch (_) { /* 已释放 */ }
      }
    }
  }

  /* ---------------------- 分阶段耗时埋点（性能基线测量） ---------------------- */

  /**
   * 把每张图「排队等待 / 客户端转码 / 网络上传 / 服务端处理」各阶段耗时与字节量
   * 记录到内存，用于端到端性能基线测量（先测量、再决定服务端要不要动）。
   * 隐私边界：不上报、不持久化、不记录文件名与图片内容，只保留聚合数值；
   * 打开 ?perf=1（或 localStorage['lumina-perf']='1'）后，每张图落定时在控制台
   * 输出一行明细；控制台执行 __luminaPerf.summary() 可得各阶段 p50/p95。
   */
  const PERF_FLAG = 'lumina-perf';
  const PERF_MAX_RECORDS = 1000;
  const perfRecords = [];

  const perfNow = () => (typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now());

  const round1 = (n) => Math.round(n * 10) / 10;

  function perfDebugEnabled() {
    try {
      if (window.localStorage.getItem(PERF_FLAG) === '1') return true;
      return new URLSearchParams(window.location.search).has('perf');
    } catch (_) {
      return false;
    }
  }

  /** 已升序排序的数组取分位数 */
  function percentile(sorted, p) {
    if (!sorted.length) return 0;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
  }

  /** 各阶段 p50/p95 汇总（__luminaPerf.summary() 的实现） */
  function perfSummary() {
    const ms = (key) => perfRecords
      .filter((r) => r[key] !== null && r[key] !== undefined)
      .map((r) => r[key])
      .sort((a, b) => a - b);
    const stat = (arr) => (arr.length
      ? `p50 ${round1(percentile(arr, 50))}ms / p95 ${round1(percentile(arr, 95))}ms（n=${arr.length}）`
      : '无样本');
    return {
      samples: perfRecords.length,
      wait: stat(ms('waitMs')),       // 建卡 → 开始处理（全局队列中的排队时长）
      convert: stat(ms('convertMs')), // 浏览器内解码 + WebP 编码
      upload: stat(ms('uploadMs')),   // 请求体发送（真实 XHR 进度区间）
      server: stat(ms('serverMs')),   // 请求体发完 → 收到响应（服务端处理 + 回程）
      total: stat(ms('totalMs')),
      srcBytes: perfRecords.reduce((s, r) => s + (r.srcBytes || 0), 0),
      uploadBytes: perfRecords.reduce((s, r) => s + (r.uploadBytes || 0), 0),
      savedBytes: perfRecords.reduce((s, r) => s + (r.savedBytes || 0), 0),
    };
  }

  /** 任务落定时记录其阶段耗时（被删除的任务没有完整生命周期，不纳入统计） */
  function recordPerf(task) {
    if (task.removed || (task.state !== 'done' && task.state !== 'failed')) return;

    const t = task.timings || {};
    const firstStageStart = t.convertStart !== undefined ? t.convertStart : t.uploadStart;
    const rec = {
      state: task.state,
      waitMs: firstStageStart !== undefined && t.queuedAt !== undefined
        ? round1(firstStageStart - t.queuedAt) : null,
      convertMs: t.convertStart !== undefined && t.convertEnd !== undefined
        ? round1(t.convertEnd - t.convertStart) : null,
      uploadMs: t.uploadStart !== undefined && t.uploadEnd !== undefined
        ? round1(t.uploadEnd - t.uploadStart) : null,
      serverMs: t.uploadEnd !== undefined && t.end !== undefined
        ? round1(t.end - t.uploadEnd) : null,
      totalMs: t.queuedAt !== undefined && t.end !== undefined
        ? round1(t.end - t.queuedAt) : null,
      srcBytes: task.size || 0,
      uploadBytes: task.uploadBytes || 0,
      savedBytes: task.savedBytes || 0,
      converted: !!task.converted,
      pixels: task.pixels || 0,
    };

    perfRecords.push(rec);
    if (perfRecords.length > PERF_MAX_RECORDS) perfRecords.shift();

    if (perfDebugEnabled()) {
      // eslint-disable-next-line no-console
      console.info(
        `[lumina-perf] ${rec.state} total=${rec.totalMs}ms wait=${rec.waitMs} `
        + `convert=${rec.convertMs} upload=${rec.uploadMs} server=${rec.serverMs} `
        + `bytes=${rec.srcBytes}->${rec.uploadBytes}`,
        rec,
      );
    }
  }

  /* ---------------------------- 任务列表状态 ---------------------------- */

  /**
   * 上传任务列表：顺序即展示顺序，与用户选择文件的顺序一致。
   * 每项既是「进行中的上传任务」，也是「已完成的结果」，由 state 区分：
   *   queued → converting → uploading → processing → done | failed
   *   （converting 仅在开启客户端转码时经过；processing 在请求体发完、
   *     服务端还没响应时出现 —— 上传进度 100% 不代表服务端处理完成）
   * 任意时刻都可能有任务被用户删除（removed = true），处理流程据此提前收尾。
   */
  const tasks = [];
  let uidSeq = 0;

  /** 已完成的图片数据（供「复制全部直链 / 导出」使用） */
  const doneItems = () => tasks.filter((t) => t.state === 'done' && t.item).map((t) => t.item);

  /** 是否仍在途（未出结果） */
  const isInflight = (t) => ['queued', 'converting', 'uploading', 'processing'].includes(t.state);

  /** 新建一条上传任务（带本地预览与一个「结算完成」的可等待承诺） */
  function createTask(raw) {
    uidSeq += 1;
    let settle;
    const settled = new Promise((resolve) => { settle = resolve; });

    const task = {
      uid: `task-${uidSeq}`,
      raw,
      name: raw.name || `未命名图片-${uidSeq}`,
      size: raw.size || 0,
      state: 'queued',
      progress: 0,
      converted: false,
      savedBytes: 0,
      item: null,       // 服务端返回的图片数据（成功后才有）
      error: '',
      xhr: null,        // 在途请求句柄，删除任务时用于中断
      removed: false,   // 已被用户从列表删除
      previewUrl: '',
      settled,
      _settle: settle,

      // 重试相关：attempt 是总尝试次数（含首次），autoRetries 是本轮自动重试计数
      attempt: 0,
      autoRetries: 0,
      retryTimer: null, // 自动重试的 setTimeout 句柄（删除任务 / 手动重试时清除）
      retryAt: 0,       // 下次自动重试的时间戳（倒计时展示用）
      quality: 1,       // 客户端转码质量（handleFiles 时按配置写入，重试沿用）
      lossyFallback: 0, // 无损压不过原文件时的有损兜底质量（JPEG / 静态 GIF 用）

      // 阶段耗时埋点：只记时间戳与字节数，不记文件名（详见 recordPerf）
      timings: { queuedAt: perfNow() },
      uploadBytes: 0,   // 实际发出的字节数（转码后可能与源文件不同）
      pixels: 0,        // 转码时解码出的像素数（未解码为 0）
    };

    // 本地预览：上传还没开始就能看到这张图；删除任务 / 切到服务端缩略图时释放
    try {
      task.previewUrl = URL.createObjectURL(raw);
    } catch (_) {
      task.previewUrl = ''; // 环境不支持（jsdom / 老浏览器）时降级为占位图标
    }
    return task;
  }

  /** 释放本地预览占用的内存 */
  function releasePreview(task) {
    if (!task.previewUrl) return;
    try {
      URL.revokeObjectURL(task.previewUrl);
    } catch (_) { /* 环境不支持时忽略 */ }
    task.previewUrl = '';
  }

  /* ------------------------------ 卡片渲染 ------------------------------ */

  /** 生成一张任务卡片的 HTML（进行中 / 失败 / 完成共用同一套两栏布局） */
  function cardHtml(task) {
    const done = task.state === 'done';

    /* --- 状态徽标（并入 meta 行，减少一个独立层级） --- */
    const badge = [];
    if (done) {
      const item = task.item;
      if (item.vector) badge.push('<span class="badge info">矢量图（SVG）</span>');
      if (item.animated) badge.push(`<span class="badge info">动图（${item.pages} 帧）</span>`);
      if (item._clientConverted) {
        // 显示真实节省量而非笼统的「省空间」：转换收益一目了然
        const saved = Number(item._clientSavedBytes) || 0;
        badge.push(`<span class="badge ok">已转 WebP${saved > 0 ? ` · 省 ${formatSize(saved)}` : ' 省空间'}</span>`);
      }
      if (item.converted_from === 'gif') {
        // 浏览器端转不动动画（canvas 只能编码单帧），动画 GIF 由服务端转码
        badge.push('<span class="badge ok">动画 GIF 已转 WebP</span>');
      }
      if (item.compression && item.compression.saved_bytes > 0) {
        badge.push(`<span class="badge ok">已压缩 −${item.compression.saved_percent}%</span>`);
      }
      if (item.duplicated) badge.push('<span class="badge warn">与已有图片相同，已复用原文件</span>');
    } else if (task.state === 'failed') {
      // 醒目的失败标识：红色徽标 + 尝试次数，一眼看出这张卡需要处理
      badge.push('<span class="badge danger"><i class="dot" aria-hidden="true"></i>上传失败</span>');
      if (task.attempt > 1) {
        badge.push(`<span class="badge warn">已自动重试 ${task.attempt - 1} 次</span>`);
      }
    } else if (task.state === 'retry_wait') {
      badge.push('<span class="badge danger"><i class="dot" aria-hidden="true"></i>上传失败</span>');
      badge.push(`<span class="badge info">${STATE_TEXT.retry_wait}（${task.autoRetries}/${MAX_AUTO_RETRIES}）</span>`);
    } else {
      badge.push(`<span class="badge info">${STATE_TEXT[task.state] || '处理中'}</span>`);
    }

    const cls = ['card', 'result'];
    if (!done) cls.push(task.state === 'failed' ? 'is-failed' : 'is-pending');

    return `
      <article class="${cls.join(' ')}" data-uid="${task.uid}" data-state="${task.state}">
        ${thumbHtml(task)}
        <div class="info">
          <div class="name">
            <span>${escapeHtml(done ? task.item.filename : task.name)}</span>
            ${retryButtonHtml(task)}
            ${removeButtonHtml(task)}
          </div>
          <div class="meta">
            ${done ? doneMetaInner(task.item) : pendingMetaInner(task)}
            <span class="badges">${badge.join('')}</span>
          </div>
          ${done ? formatsHtml(task) : taskLineHtml(task)}
        </div>
      </article>`;
  }

  /** 缩略图：进行中用本地预览，完成后换成服务端缩略图 */
  function thumbHtml(task) {
    if (task.state === 'done') {
      const item = task.item;
      return `<a class="thumb" href="${escapeHtml(item.page_url)}" target="_blank" rel="noopener">
          <img src="${escapeHtml(item.thumb_url)}" alt="${escapeHtml(item.filename)}" loading="lazy" decoding="async" />
        </a>`;
    }
    if (task.previewUrl) {
      return `<div class="thumb"><img src="${escapeHtml(task.previewUrl)}" alt="${escapeHtml(task.name)}" /></div>`;
    }
    return `<div class="thumb">${PLACEHOLDER_THUMB}</div>`;
  }

  /** 单张删除按钮：进行中为「取消」，已完成为「删除」，两者都会清理该任务的资源与状态 */
  function removeButtonHtml(task) {
    const done = task.state === 'done';
    const label = done ? '删除' : '取消';
    const title = done
      ? '从列表移除，并删除服务器上的原图与缩略图'
      : '取消这张图片的上传任务';
    return `<button class="btn sm ghost task-remove" type="button" data-remove="${task.uid}"
        title="${escapeHtml(title)}"
        aria-label="${escapeHtml(`${title}：${task.name}`)}">${label}</button>`;
  }

  /**
   * 单张重试按钮：仅失败态与等待自动重试态出现。
   * 等待重试时点它可跳过倒计时立即重传；重试次数用尽后这是唯一的重试入口。
   */
  function retryButtonHtml(task) {
    if (task.state !== 'failed' && task.state !== 'retry_wait') return '';
    const waiting = task.state === 'retry_wait';
    const label = waiting ? '立即重试' : '重试';
    const title = waiting
      ? '跳过等待，立即重新上传这张图片'
      : '重新上传这张图片';
    return `<button class="btn sm primary task-retry" type="button" data-retry="${task.uid}"
        title="${escapeHtml(title)}"
        aria-label="${escapeHtml(`${title}：${task.name}`)}">${label}</button>`;
  }

  /** 完成后的 meta 信息（尺寸 / 体积 / 格式 / 时间，弱化为次要信息行） */
  function doneMetaInner(item) {
    return `
      <span>${item.width || '?'} × ${item.height || '?'}</span>
      <span>${escapeHtml(item.size_human || formatSize(item.size))}</span>
      <span>${escapeHtml(String(item.ext).toUpperCase())}</span>
      <span>${escapeHtml(new Date(item.created_at).toLocaleString('zh-CN', { hour12: false }))}</span>`;
  }

  function pendingMetaInner(task) {
    const ext = extOf(task.name);
    const converted = task.converted ? '<span class="badge ok">已转 WebP</span>' : '';
    return `
      <span>${escapeHtml(formatSize(task.size))}</span>
      ${ext ? `<span>${escapeHtml(ext.toUpperCase())}</span>` : ''}
      ${converted}`;
  }

  /**
   * 进行中的单张进度条；失败态不再显示进度条（它已无信息量），
   * 直接突出「失败原因」，让用户第一时间看到该做什么。
   */
  function taskLineHtml(task) {
    if (task.state === 'retry_wait') {
      // 等待自动重试：失败原因 + 每秒刷新的倒计时（由 retryTicker 维护）
      return `
        <div class="task-note error">失败原因：${escapeHtml(task.error || '上传失败，请重试')}</div>
        <div class="task-note retry">将在 <span class="countdown" data-countdown="${task.uid}">…</span> 后自动重试
         （第 ${task.autoRetries}/${MAX_AUTO_RETRIES} 次，可点「立即重试」跳过等待）</div>`;
    }

    if (task.state === 'failed') {
      const exhausted = task.autoRetries >= MAX_AUTO_RETRIES;
      const hint = exhausted ? '自动重试已用尽，可点「重试」再试一次' : '可点「重试」重新上传';
      return `
        <div class="task-note error">失败原因：${escapeHtml(task.error || '上传失败，请重试')}</div>
        <div class="task-note retry">${hint}</div>`;
    }

    const indeterminate = INDETERMINATE.includes(task.state);
    const pct = Math.round((task.progress || 0) * 100);

    return `
      <div class="task-line">
        <div class="task-progress${indeterminate ? ' is-indeterminate' : ''}" role="progressbar"
             aria-valuemin="0" aria-valuemax="100"${indeterminate ? '' : ` aria-valuenow="${pct}"`}
             aria-label="${escapeHtml(`${task.name} 上传进度`)}"><i style="width:${pct}%"></i></div>
        <span class="task-pct">${indeterminate ? '···' : `${pct}%`}</span>
      </div>`;
  }

  /** 完成后的多格式引用区 */
  function formatsHtml(task) {
    const item = task.item;
    const tabs = FORMAT_TABS.map(
      (t, ti) =>
        `<button type="button" data-tab="${t.key}" data-uid="${task.uid}" class="${ti === 0 ? 'active' : ''}">${t.label}</button>`,
    ).join('');

    const first = item.formats[FORMAT_TABS[0].key];
    const isLong = first.length > 90;

    return `
      <div class="formats">
        <div class="tabs" role="tablist">${tabs}</div>
        <div class="copybox">
          ${
            isLong
              ? `<textarea readonly rows="2" data-field="${task.uid}">${escapeHtml(first)}</textarea>`
              : `<input readonly data-field="${task.uid}" value="${escapeHtml(first)}" />`
          }
          <button class="btn primary sm" type="button" data-copy="${task.uid}">复制</button>
          <a class="btn sm ghost" href="${escapeHtml(item.url)}" target="_blank" rel="noopener">打开</a>
          <a class="btn sm ghost" href="/d/${escapeHtml(item.id)}" title="下载原图">下载</a>
        </div>
      </div>`;
  }

  function createCardEl(task) {
    const wrap = document.createElement('div');
    wrap.innerHTML = cardHtml(task);
    return wrap.firstElementChild;
  }

  const cardOf = (uid) => resultList.querySelector(`.result[data-uid="${uid}"]`);

  /** 列表头部（数量 / 在途张数）、空状态与批量按钮可用性的同步 */
  function syncListChrome() {
    const has = tasks.length > 0;
    resultsSection.hidden = !has;
    emptyTip.hidden = has;
    resultCount.textContent = String(tasks.length);

    const inflight = tasks.filter(isInflight).length;
    const retryWaiting = tasks.filter((t) => t.state === 'retry_wait' && !t.removed).length;
    queueStatus.hidden = inflight === 0 && retryWaiting === 0;
    const parts = [];
    if (inflight) parts.push(`${inflight} 张上传中`);
    if (retryWaiting) parts.push(`${retryWaiting} 张等待自动重试`);
    parts.push(`已完成 ${tasks.filter((t) => t.state === 'done').length} 张`);
    queueStatus.textContent = parts.join(' · ');

    // 批量重试按钮：有任何失败（含等待重试）的图片时才出现，并实时显示数量
    const failedCount = tasks.filter(
      (t) => (t.state === 'failed' || t.state === 'retry_wait') && !t.removed,
    ).length;
    const retryAllBtn = $('retry-all');
    if (retryAllBtn) {
      retryAllBtn.hidden = failedCount === 0;
      retryAllBtn.textContent = failedCount ? `批量重试（${failedCount}）` : '批量重试';
    }

    // 没有任何完成项时弱化批量操作按钮，点击会给出解释而不是无响应
    const hasDone = tasks.some((t) => t.state === 'done' && t.item);
    ['copy-all-url', 'copy-all-md', 'copy-all-bbcode', 'download-urls'].forEach((id) => {
      const el = $(id);
      if (el) el.setAttribute('aria-disabled', hasDone ? 'false' : 'true');
    });
  }

  /** 批量插入新任务卡片（一次重排，避免逐张插入的抖动） */
  function appendTaskCards(list) {
    const frag = document.createDocumentFragment();
    for (const task of list) frag.appendChild(createCardEl(task));
    resultList.appendChild(frag);
    syncListChrome();
  }

  /** 单张卡片就地重绘（状态变化时调用；不影响其它卡片上正在进行的复制 / 切标签操作） */
  function renderTask(task) {
    const card = cardOf(task.uid);
    if (!card) return; // 已被删除，无需渲染
    card.replaceWith(createCardEl(task));
    if (task.state === 'done') releasePreview(task); // 已切到服务端缩略图，本地预览不再需要
    syncListChrome();
  }

  /** 只更新进度条本身：进度事件很密集，避免整卡重绘打断用户操作 */
  function updateTaskProgress(task) {
    const card = cardOf(task.uid);
    if (!card) return;

    const pct = Math.round((task.progress || 0) * 100);
    if (card.dataset.pct === String(pct)) return; // 整数百分比没变就不碰 DOM
    card.dataset.pct = String(pct);

    const bar = card.querySelector('.task-progress');
    if (bar) {
      bar.classList.remove('is-indeterminate');
      bar.setAttribute('aria-valuenow', String(pct));
      const fill = bar.querySelector('i');
      if (fill) fill.style.width = `${pct}%`;
    }
    const pctEl = card.querySelector('.task-pct');
    if (pctEl) pctEl.textContent = `${pct}%`;
  }

  /* ------------------------------ 上传逻辑 ------------------------------ */

  /**
   * 页面级全局并发调度器。
   * 每个选图批次各自开 worker 池时，「单批上限 3」在连续选图后会叠加成
   * 3×N 条同时在途（多份位图 + 多条并发请求同时压给浏览器与服务端）。
   * 这里把所有批次的任务汇入同一个 FIFO 队列：页面内同时处于
   * 「解码 / 转码 / 上传 / 等待响应」的任务总数受同一上限约束。
   * 上限沿用 client_max_concurrency（1–6），语义从「单批上限」升级为「页面全局上限」。
   */
  const scheduler = {
    active: 0,
    waiting: [], // 已排队任务的唤醒回调，先来先服务

    limit() {
      // 越界 / 非法配置一律回落到 1–6 区间内的安全值（每次泵队列时重读，配置热改即时生效）
      return Math.min(6, Math.max(1, Math.round(Number(config.client_max_concurrency) || 3)));
    },

    acquire() {
      return new Promise((resolve) => {
        scheduler.waiting.push(resolve);
        scheduler.pump();
      });
    },

    release() {
      scheduler.active -= 1;
      scheduler.pump();
    },

    pump() {
      const limit = scheduler.limit();
      while (scheduler.active < limit && scheduler.waiting.length) {
        scheduler.active += 1;
        scheduler.waiting.shift()();
      }
    },
  };

  /** 用 XHR 以获取真实上传进度（fetch 目前无法报告上传进度） */
  function uploadXHR(file, { onProgress, onUploaded, onStart } = {}) {
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

      // 请求体全部发完 ≠ 服务端处理完成：用它把任务切到「服务端处理中」阶段
      xhr.upload.addEventListener('load', () => {
        if (onUploaded) onUploaded();
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

      // 交出请求句柄：任务被删除时用它中断在途上传
      if (onStart) onStart(xhr);
      xhr.send(form);
    });
  }

  /**
   * 处理单个任务：排队等全局槽位 → 校验 → 可选转 WebP → 上传 → 等响应。
   * 每个阶段都重新确认任务是否已被删除（removed），避免给已删除的任务写状态。
   * 全程记录各阶段时间戳，落定时交给 recordPerf 汇总（不上报、不含文件名）。
   */
  async function processOne(task, quality) {
    // 先排队等全局并发槽位；排队时长（建卡 → 开始处理）计入埋点
    await scheduler.acquire();
    try {
      task.timings.start = perfNow();
      task.attempt += 1; // 第几次尝试（含首次上传与所有重试）
      if (task.removed) return;

      const invalid = checkFile(task.raw);
      if (invalid) {
        task.state = 'failed';
        task.error = invalid;
        toast(`${task.name}：${invalid}`, 'error', 4000);
        return;
      }

      // 浏览器内转码：耗时且拿不到字节级进度，先让进度条进入不确定态
      let file = task.raw;
      if (config.client_convert_webp) {
        task.state = 'converting';
        renderTask(task);

        task.timings.convertStart = perfNow();
        const r = await convertToWebp(task.raw, quality, task.lossyFallback);
        task.timings.convertEnd = perfNow();
        if (task.removed) return;

        file = r.file;
        task.converted = r.converted;
        task.savedBytes = r.savedBytes || 0;
        task.pixels = r.pixels || 0;
      }

      if (task.removed) return;

      task.state = 'uploading';
      task.timings.uploadStart = perfNow();
      renderTask(task);

      const data = await uploadXHR(file, {
        onProgress: (p) => {
          if (task.removed) return;
          task.progress = p;
          updateTaskProgress(task);
        },
        onUploaded: () => {
          // 请求体发完：切换到「服务端处理中」，进度回到不确定态（不伪造百分比）
          if (task.removed || task.state !== 'uploading') return;
          task.timings.uploadEnd = perfNow();
          task.state = 'processing';
          renderTask(task);
        },
        onStart: (xhr) => { task.xhr = xhr; },
      });

      // 个别浏览器 / 测试环境不触发 upload 的 load 事件，这里兜底补上时间戳
      if (task.timings.uploadEnd === undefined) task.timings.uploadEnd = perfNow();
      if (task.removed) return; // 响应与删除同时到达：由 removeTask 负责善后

      task.uploadBytes = file.size;
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        item._clientConverted = task.converted;
        item._clientSavedBytes = task.savedBytes || 0;
        item._originalName = task.name;
        item._originalSize = task.size;
      }
      task.item = items[0];
      task.progress = 1;
      task.state = 'done';
    } catch (err) {
      if (task.removed) return; // 用户主动取消，不算失败
      task.state = 'failed';
      task.error = err.message;

      // 可重试的失败（网络抖动 / 5xx / 超时 / 限流）自动进入重试队列，
      // 按指数退避排队再试；重试次数用尽或错误本身重试无意义时停在失败态
      if (isRetryableError(err) && task.autoRetries < MAX_AUTO_RETRIES) {
        scheduleAutoRetry(task);
        toast(
          `${task.name}：${err.message}（${Math.round(retryDelayMs(task.autoRetries) / 1000)} 秒后自动重试 `
          + `${task.autoRetries}/${MAX_AUTO_RETRIES}）`,
          'error', 4500,
        );
      } else {
        toast(`${task.name}：${err.message}`, 'error', 4500);
      }
    } finally {
      task.timings.end = perfNow();
      scheduler.release();   // 槽位必须与结算一一对应，先归还再渲染
      task.xhr = null;
      task._settle(); // 通知 removeTask：该任务的最终状态已确定
      recordPerf(task);      // 落定即记录阶段耗时（被删除的任务会被跳过）
      if (!task.removed) renderTask(task); // 已删除的任务交给 removeTask 收尾，不再重绘
    }
  }

  /* --------------------------- 重试队列与手动重试 --------------------------- */

  /**
   * 把失败任务放入重试队列：先在卡片上进入「等待自动重试」态并显示倒计时，
   * 到点后重新提交给全局调度器（与正常上传共用并发上限，不会挤占在途请求）。
   * 重试走完整的 processOne 流程 —— 再次失败仍按策略继续排队，直到次数用尽。
   */
  function scheduleAutoRetry(task) {
    task.autoRetries += 1;
    task.state = 'retry_wait';
    const delay = retryDelayMs(task.autoRetries);
    task.retryAt = Date.now() + delay;
    task.retryTimer = setTimeout(() => {
      task.retryTimer = null;
      if (task.removed) return;
      submitRetry(task);
    }, delay);
    ensureRetryTicker();
  }

  /**
   * 取消尚未触发的自动重试定时器（删除任务 / 手动重试前调用）。
   * 返回任务是否确实处于「失败 / 等待重试」这两种可重试状态。
   */
  function clearRetryTimer(task) {
    if (task.retryTimer) {
      clearTimeout(task.retryTimer);
      task.retryTimer = null;
    }
    return task.state === 'failed' || task.state === 'retry_wait';
  }

  /**
   * 重新提交一张失败图片：清掉旧状态后回到完整上传流程
   * （排队 → 可选转码 → 上传 → 服务端处理），卡片上的进度条随之恢复。
   * 手动重试会开启新一轮自动重试周期（autoRetries 清零），次数重新计算。
   */
  function submitRetry(task) {
    if (task.removed || !clearRetryTimer(task)) return;

    task.autoRetries = 0;
    task.error = '';
    task.progress = 0;
    task.uploadBytes = 0;
    task.timings = { queuedAt: perfNow() };
    task.state = 'queued';
    renderTask(task);
    processOne(task, task.quality);
  }

  /** 批量重试所有上传失败的图片（含正在等待自动重试的），一次性重新提交 */
  function retryAllFailed() {
    const failed = tasks.filter(
      (t) => (t.state === 'failed' || t.state === 'retry_wait') && !t.removed,
    );
    if (!failed.length) {
      toast('当前没有上传失败的图片', 'info', 2800);
      return;
    }
    for (const task of failed) submitRetry(task);
    toast(`已重新提交 ${failed.length} 张失败图片，正在按队列重试`, 'info', 3200);
  }

  /**
   * 倒计时心跳：每秒把「等待自动重试」卡片上的剩余秒数刷新一次。
   * 常驻但极轻：没有等待任务时本轮直接返回，不碰任何 DOM。
   */
  function ensureRetryTicker() {
    if (ensureRetryTicker.timer) return;
    ensureRetryTicker.timer = setInterval(() => {
      const waiting = tasks.filter((t) => t.state === 'retry_wait' && !t.removed);
      for (const task of waiting) {
        const el = resultList.querySelector(`[data-countdown="${task.uid}"]`);
        if (!el) continue;
        const left = Math.max(0, Math.ceil((task.retryAt - Date.now()) / 1000));
        el.textContent = left > 0 ? `${left} 秒` : '即将重试…';
      }
    }, 1000);
  }

  /**
   * 删除单条上传任务（进行中 / 已完成都可用），并清理其对应的资源与状态：
   *   未完成 → 中断在途请求 + 让排队的 worker 跳过 + 释放本地预览
   *   已完成 → 用上传时下发的 delete_key（或管理员 Token）删除服务端原图、缩略图与记录
   */
  async function removeTask(uid, btn) {
    const index = tasks.findIndex((t) => t.uid === uid);
    if (index < 0) return;
    const task = tasks[index];

    if (btn) {
      btn.disabled = true;
      btn.textContent = '处理中…';
    }

    const wasDone = task.state === 'done';

    // ---- 1. 中断在途请求 / 清除待触发的自动重试，并阻止排队的 worker 继续处理它 ----
    task.removed = true;
    clearRetryTimer(task);
    if (task.xhr) {
      try {
        task.xhr.abort();
      } catch (_) { /* 请求可能刚好已结束 */ }
      task.xhr = null;
    }

    // ---- 2. 等这条任务的最终状态落定 ----
    // 上传完成与点击删除可能同时发生，必须等 processOne 把 item 写下来再决定是否删服务端资源
    await Promise.race([
      task.settled,
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);

    // ---- 3. 清理服务端资源（仅对确实已落库的图片） ----
    let cleanup = { attempted: false, deleted: false, reason: 'not-uploaded' };
    if (task.item && task.item.id) {
      cleanup = await deleteUploadedImage(task.item);
    }

    // ---- 4. 释放本地资源 ----
    releasePreview(task);

    // ---- 5. 从列表移除 ----
    const card = cardOf(task.uid);
    if (card) card.remove();
    tasks.splice(tasks.indexOf(task), 1);
    syncListChrome();

    // ---- 6. 反馈 ----
    if (!wasDone) {
      toast(`${task.name}：已取消该上传任务`, 'info', 2400);
    } else if (cleanup.deleted) {
      toast(`${task.name}：已删除（含服务器上的原图与缩略图）`, 'success', 3000);
    } else if (cleanup.reason === 'duplicated') {
      toast(`${task.name}：已移除；图片来自内容复用，服务器原件保留`, 'info', 3600);
    } else if (!cleanup.attempted) {
      toast(`${task.name}：已移除；没有删除权限，服务器图片保留`, 'info', 3600);
    } else {
      toast(`${task.name}：已移除，但服务器删除失败：${cleanup.message}`, 'error', 4500);
    }
  }

  /**
   * 删除服务端上这张图片的资源与记录。
   *   - 管理员（本地有 Token）→ 直接调删除接口，可删任意图片
   *   - 游客 → 携带上传响应下发的 delete_key，只能删自己刚上传的这一张
   *   - 秒传复用来的记录不带凭证，不擅自删除别人的文件
   */
  async function deleteUploadedImage(item) {
    const token = Lumina.store.get(Lumina.TOKEN_KEY);

    if (!token && !item.delete_key) {
      return {
        attempted: false,
        deleted: false,
        reason: item.duplicated ? 'duplicated' : 'no-credential',
      };
    }

    const qs = !token && item.delete_key ? `?key=${encodeURIComponent(item.delete_key)}` : '';
    try {
      await request(`/api/images/${encodeURIComponent(item.id)}${qs}`, { method: 'DELETE' });
      return { attempted: true, deleted: true, reason: '' };
    } catch (err) {
      // 404 说明服务端已经没有了，对用户而言等同于清理成功
      if (err.status === 404) return { attempted: true, deleted: true, reason: 'already-gone' };
      return { attempted: true, deleted: false, reason: 'error', message: err.message };
    }
  }

  /**
   * 处理整批文件：
   *  - 先为每个文件建立任务卡片并立即渲染（用户马上能看到逐张进度，而非一条总进度）
   *  - 再把每张任务提交到页面级全局调度器：所有批次共享同一个 FIFO 队列，
   *    页面内同时「解码 / 转码 / 上传」的任务总数由 client_max_concurrency 统一约束
   *    （1–6，默认 3）—— 连续多批选图不会再叠加在途数
   *  - 每张图片占独立「槽位」，进度 / 结果 / 失败信息与原文件一一对应，
   *    不依赖完成顺序；单线程事件循环内领取槽位，无竞态
   *  - 任意一张都可在进行中或完成后被单独删除，删除后其槽位不再产生结果
   */
  async function handleFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    if (!config.guest_upload_enabled) {
      toast('当前仅管理员可上传', 'error');
      return;
    }

    const maxFiles = config.max_files || 20;
    const batch = files.slice(0, maxFiles);
    if (files.length > maxFiles) {
      toast(`单次最多 ${maxFiles} 个文件，本次仅上传前 ${maxFiles} 个`, 'info', 4000);
    }

    // 压缩策略由管理台配置：未开启压缩时 PNG / BMP 按无损编码（仅转格式、
    // 不做有损压缩）；JPEG / 静态 GIF 的无损编码压不过原文件，必须按配置
    // 质量做有损编码，否则默认配置下除 PNG 外永远转换不了（见 convertToWebp）。
    const configuredQuality = Math.min(100, Math.max(40, Number(config.client_webp_quality) || 82)) / 100;
    const quality = config.client_convert_webp && config.client_compress
      ? configuredQuality
      : 1;
    const lossyFallback = config.client_convert_webp && config.client_compress
      ? 0 // 压缩开启时 quality 本身已是有损质量，无需兜底
      : configuredQuality;

    // 1) 建任务 + 立即上屏：每张图片各有一条自己的进度条
    const batchTasks = batch.map((raw) => createTask(raw));
    for (const t of batchTasks) {
      t.quality = quality;             // 重试时沿用本批次的转码策略
      t.lossyFallback = lossyFallback; // 有损兜底质量同样随批次固定
    }
    tasks.push(...batchTasks);
    appendTaskCards(batchTasks);

    // 2) 提交到全局调度器：单张失败 / 被删除都在任务内部消化，不会中断整批
    for (const t of batchTasks) {
      processOne(t, quality);
    }

    // 3) 批次结算：每张任务的 settled 在其最终状态落定时 resolve（与批次无关）
    await Promise.all(batchTasks.map((t) => t.settled));

    // 4) 批次小结（被用户删除的任务不计入成功与失败）
    const doneTasks = batchTasks.filter((t) => t.state === 'done' && t.item);
    const failCount = batchTasks.filter((t) => t.state === 'failed').length;
    const removedCount = batchTasks.filter((t) => t.removed).length;
    const savedBytes = batchTasks.reduce((sum, t) => sum + (t.savedBytes || 0), 0);

    if (doneTasks.length) {
      const extra = savedBytes > 0 ? `，客户端转 WebP 省下 ${formatSize(savedBytes)}` : '';
      const skip = removedCount ? `，手动移除 ${removedCount} 张` : '';
      toast(
        `成功上传 ${doneTasks.length} 张${failCount ? `，失败 ${failCount} 张` : ''}${skip}${extra}`,
        'success',
        3400,
      );
    }
    if (doneTasks.length && config.auto_copy_url) {
      copyWithToast(doneTasks[doneTasks.length - 1].item.url, '链接已复制到剪贴板');
    }
  }

  /* ------------------------------ 交互辅助 ------------------------------ */

  /** 切换某条结果的引用格式 */
  function switchTab(uid, key) {
    const task = tasks.find((t) => t.uid === uid);
    if (!task || task.state !== 'done' || !task.item) return;

    const art = cardOf(uid);
    if (!art) return;

    art.querySelectorAll('.tabs button').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === key);
    });

    const text = task.item.formats[key] || task.item.url;
    const box = art.querySelector('[data-field]');
    const next = document.createElement(text.length > 90 ? 'textarea' : 'input');
    next.setAttribute('readonly', '');
    next.dataset.field = uid;
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
      // 单张删除 / 取消：进行中与已完成状态下都可用
      const removeBtn = e.target.closest('[data-remove]');
      if (removeBtn) {
        removeTask(removeBtn.dataset.remove, removeBtn);
        return;
      }

      // 单张重试：失败态 / 等待自动重试态卡片上的「重试 / 立即重试」
      const retryBtn = e.target.closest('[data-retry]');
      if (retryBtn) {
        const task = tasks.find((t) => t.uid === retryBtn.dataset.retry);
        if (task) {
          submitRetry(task);
          toast(`${task.name}：已重新提交上传`, 'info', 2400);
        }
        return;
      }

      const tabBtn = e.target.closest('.tabs button');
      if (tabBtn) {
        switchTab(tabBtn.dataset.uid, tabBtn.dataset.tab);
        return;
      }

      const copyBtn = e.target.closest('[data-copy]');
      if (copyBtn) {
        const task = tasks.find((t) => t.uid === copyBtn.dataset.copy);
        const art = copyBtn.closest('.result');
        const field = art.querySelector('[data-field]');
        copyWithToast(field ? field.value : (task && task.item ? task.item.url : ''));
      }
    });

    // 「更多」下拉里的按钮点击后自动收起，避免遮挡列表
    document.querySelectorAll('.results-head .menu-list button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const menu = btn.closest('details.menu');
        if (menu) menu.open = false;
      });
    });

    // 批量操作：没有完成项时给出解释，绝不静默无反应
    const requireDone = () => {
      const items = doneItems();
      if (!items.length) {
        toast('还没有上传完成的图片，等上传完成后再试', 'info', 2800);
        return null;
      }
      return items;
    };

    // 批量重试：一次性重试所有上传失败的图片（含等待自动重试的）
    $('retry-all').addEventListener('click', retryAllFailed);

    $('copy-all-url').addEventListener('click', () => {
      const items = requireDone();
      if (!items) return;
      copyWithToast(items.map((r) => r.url).join('\n'), `已复制 ${items.length} 条链接`);
    });

    $('copy-all-md').addEventListener('click', () => {
      const items = requireDone();
      if (!items) return;
      copyWithToast(items.map((r) => r.formats.markdown).join('\n'), `已复制 ${items.length} 条 Markdown`);
    });

    $('copy-all-bbcode').addEventListener('click', () => {
      const items = requireDone();
      if (!items) return;
      copyWithToast(items.map((r) => r.formats.bbcode).join('\n'), `已复制 ${items.length} 条 BBCode`);
    });

    $('download-urls').addEventListener('click', () => {
      const items = requireDone();
      if (!items) return;
      const lines = [
        `# Lumina 图床导出 · ${new Date().toLocaleString('zh-CN', { hour12: false })}`,
        `# 共 ${items.length} 张`,
        '',
        ...items.map((r) => `${r.url}\t${r.filename}\t${r.width}x${r.height}\t${r.size_human}`),
      ];
      downloadText('lumina-urls.txt', lines.join('\n'));
      toast(`已导出 ${items.length} 条链接列表`, 'success');
    });

    $('clear-results').addEventListener('click', () => {
      // 只清空列表展示：不触碰服务器上的图片（要删图片请用每条的「删除」）
      const finished = tasks.filter((t) => t.state === 'done' || t.state === 'failed');
      if (!finished.length) {
        toast('没有可清理的条目（上传中的任务请单独取消）', 'info', 2800);
        return;
      }
      for (const task of finished) {
        releasePreview(task);
        const card = cardOf(task.uid);
        if (card) card.remove();
        tasks.splice(tasks.indexOf(task), 1);
      }
      syncListChrome();
      toast(`已清空 ${finished.length} 条列表记录（服务器上的图片未被删除）`, 'info', 3400);
    });
  }

  /* -------------------------------- 启动 -------------------------------- */

  document.addEventListener('DOMContentLoaded', () => {
    bindDropzone();
    bindPaste();
    bindResultActions();
    loadConfig();

    // 性能基线测量入口：控制台执行 __luminaPerf.summary() 得到各阶段 p50/p95；
    // 加 ?perf=1（或 localStorage['lumina-perf']='1'）后每张图落定时打印明细。
    // 只暴露内存中的聚合数值，不含文件名与图片内容。
    window.__luminaPerf = { records: perfRecords, summary: perfSummary };
  });
})();
