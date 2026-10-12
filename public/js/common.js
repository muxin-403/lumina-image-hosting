/* ==========================================================================
   Lumina · 前端公共库
   原生 ES2020，无框架、无构建步骤，直接 <script> 引入
   ========================================================================== */

const Lumina = (() => {
  'use strict';

  const TOKEN_KEY = 'lumina_token';

  /* ------------------------------ 本地存储 ------------------------------ */

  const store = {
    get: (k) => {
      try { return localStorage.getItem(k); } catch (_) { return null; }
    },
    set: (k, v) => {
      try { localStorage.setItem(k, v); } catch (_) { /* 无痕模式下忽略 */ }
    },
    del: (k) => {
      try { localStorage.removeItem(k); } catch (_) { /* ignore */ }
    },
  };

  /* ------------------------------- 网络 ------------------------------- */

  /** 统一请求封装：自动带 Token、统一解包 { success, data }、统一抛错 */
  async function request(path, options = {}) {
    const init = { method: options.method || 'GET', headers: { ...(options.headers || {}) } };

    const token = store.get(TOKEN_KEY);
    if (token && options.auth !== false) init.headers.Authorization = `Bearer ${token}`;

    if (options.body instanceof FormData) {
      init.body = options.body; // 交给浏览器自动带 boundary
    } else if (options.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(options.body);
    }

    let res;
    try {
      res = await fetch(path, init);
    } catch (err) {
      const e = new Error('网络请求失败，请检查服务是否在线');
      e.code = 'NETWORK_ERROR';
      throw e;
    }

    let payload = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      payload = await res.json().catch(() => null);
    }

    if (!res.ok) {
      const err = new Error((payload && payload.error && payload.error.message) || `HTTP ${res.status}`);
      err.status = res.status;
      err.code = payload && payload.error ? payload.error.code : `E${res.status}`;
      if (res.status === 401) store.del(TOKEN_KEY); // Token 失效：清理本地缓存
      throw err;
    }
    if (options.full) return payload; // 需要随 data 一起返回的分页等附加字段时使用
    return payload ? payload.data : null;
  }

  /* ------------------------------- 提示 ------------------------------- */

  function toastHost() {
    let host = document.querySelector('.toast-host');
    if (!host) {
      host = document.createElement('div');
      host.className = 'toast-host';
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      document.body.appendChild(host);
    }
    return host;
  }

  function toast(message, type = 'info', timeout = 2600) {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    toastHost().appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .2s, transform .2s';
      el.style.opacity = '0';
      el.style.transform = 'translateX(16px)';
      setTimeout(() => el.remove(), 220);
    }, timeout);
  }

  /* ------------------------------ 剪贴板 ------------------------------ */

  /** 复制文本：优先 Clipboard API，失败时回退 execCommand（http 环境必需） */
  async function copy(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) { /* 继续回退 */ }

    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      const okFlag = document.execCommand('copy');
      ta.remove();
      return okFlag;
    } catch (_) {
      return false;
    }
  }

  async function copyWithToast(text, label = '已复制') {
    const done = await copy(text);
    toast(done ? label : '复制失败，请手动选择文本复制', done ? 'success' : 'error');
    return done;
  }

  /* ------------------------------ 明暗主题 ------------------------------ */

  const THEME_KEY = 'lumina_theme'; // light | dark | auto（其余值一律视为 auto）
  const THEME_BG = { light: '#f4f6fa', dark: '#0d1117' }; // 与 style.css 的 --bg 对应，用于 theme-color
  const THEME_ICONS = {
    auto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/></svg>',
    light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  };

  function systemPrefersDark() {
    try {
      return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch (_) {
      return false;
    }
  }

  /** 把偏好档位解析为具体主题：手动 light/dark 原样返回，auto 跟随系统 */
  function resolveTheme(pref) {
    if (pref === 'light' || pref === 'dark') return pref;
    return systemPrefersDark() ? 'dark' : 'light';
  }

  function getThemePref() {
    const v = store.get(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'auto';
  }

  /** 把主题落到 <html data-theme="light|dark">，并同步浏览器地址栏配色（theme-color） */
  function applyTheme(pref) {
    const eff = resolveTheme(pref);
    if (document.documentElement.dataset.theme !== eff) {
      document.documentElement.dataset.theme = eff;
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', THEME_BG[eff]);
    return eff;
  }

  function setThemePref(pref) {
    store.set(THEME_KEY, pref === 'light' || pref === 'dark' ? pref : 'auto');
    applyTheme(pref);
    refreshThemeToggle();
  }

  // 「跟随系统」档位下，系统偏好变化实时生效（含旧 Safari 的 addListener 兼容）
  try {
    const mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
    if (mq) {
      const onSchemeChange = () => {
        if (getThemePref() === 'auto') applyTheme('auto');
      };
      if (mq.addEventListener) mq.addEventListener('change', onSchemeChange);
      else if (mq.addListener) mq.addListener(onSchemeChange);
    }
  } catch (_) { /* ignore */ }

  // 本脚本在 body 末尾执行时 DOM 已就绪：立即落一次主题（幂等），
  // 与各页面 <head> 的早期内联脚本结果一致，并兜底未加早期脚本的页面
  applyTheme(getThemePref());

  /** 同步顶栏切换入口的图标与选中态 */
  function refreshThemeToggle() {
    const details = document.querySelector('.theme-menu');
    if (!details) return;
    const pref = getThemePref();
    const summary = details.querySelector('summary');
    if (summary) summary.innerHTML = THEME_ICONS[resolveTheme(pref)];
    details.querySelectorAll('button[data-pref]').forEach((b) => {
      const active = b.dataset.pref === pref;
      b.classList.toggle('active', active);
      b.setAttribute('aria-checked', active ? 'true' : 'false');
    });
  }

  /** 向顶栏注入主题切换入口（跟随系统 / 浅色 / 暗色），各页面无需重复写标记 */
  function initThemeToggle() {
    const nav = document.querySelector('.topnav');
    if (!nav || nav.querySelector('.theme-menu')) return;

    const details = document.createElement('details');
    details.className = 'menu theme-menu';
    details.innerHTML = `
      <summary class="theme-toggle" title="切换明暗主题" aria-label="切换明暗主题"></summary>
      <div class="menu-list" role="menu" aria-label="明暗主题">
        <button type="button" role="menuitemradio" data-pref="auto">${THEME_ICONS.auto}<span>跟随系统</span><span class="tmark">✓</span></button>
        <button type="button" role="menuitemradio" data-pref="light">${THEME_ICONS.light}<span>浅色</span><span class="tmark">✓</span></button>
        <button type="button" role="menuitemradio" data-pref="dark">${THEME_ICONS.dark}<span>暗色</span><span class="tmark">✓</span></button>
      </div>`;

    details.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-pref]');
      if (!btn) return;
      e.preventDefault();
      setThemePref(btn.dataset.pref);
      details.removeAttribute('open');
    });
    details.addEventListener('toggle', refreshThemeToggle);

    nav.appendChild(details);
    refreshThemeToggle();
  }

  // 打开状态的 <details class="menu">：点击外部或按 Esc 时收起（主题菜单与「更多」菜单通用）
  document.addEventListener('click', (e) => {
    document.querySelectorAll('details.menu[open]').forEach((d) => {
      if (!d.contains(e.target)) d.removeAttribute('open');
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('details.menu[open]').forEach((d) => d.removeAttribute('open'));
    }
  });

  initThemeToggle();

  /* ------------------------------- 工具 ------------------------------- */

  function formatSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let n = bytes;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
    return `${i === 0 ? Math.round(n) : n.toFixed(n >= 100 ? 1 : 2)} ${units[i]}`;
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * 应用站点图标：用 /api/config 下发的带版本号地址替换页面 <link rel="icon">
   * （服务端图标更新后，版本号变化可穿透浏览器缓存）
   */
  function applyFavicon(url) {
    if (!url || typeof url !== 'string') return;
    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    if (link.getAttribute('href') !== url) link.setAttribute('href', url);
  }

  function debounce(fn, wait = 280) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
  }

  /** 触发浏览器下载一个文本文件（用于导出 URL 列表） */
  function downloadText(filename, text, mime = 'text/plain;charset=utf-8') {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return {
    store, request, toast, copy, copyWithToast, formatSize, formatTime, escapeHtml,
    applyFavicon, debounce, downloadText, TOKEN_KEY,
    theme: { get: getThemePref, set: setThemePref, apply: applyTheme, resolve: resolveTheme },
  };
})();
