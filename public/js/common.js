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

  return { store, request, toast, copy, copyWithToast, formatSize, formatTime, escapeHtml, debounce, downloadText, TOKEN_KEY };
})();
