/* ==========================================================================
   Lumina · 管理台逻辑
   单管理员登录 → 统计 / 图片管理（查看·筛选·删除） / 站点设置 / 存储与安全
   ========================================================================== */

(() => {
  'use strict';

  const { request, store, toast, copyWithToast, escapeHtml, formatSize, formatTime, debounce, TOKEN_KEY } = Lumina;

  const $ = (id) => document.getElementById(id);

  /** 列表状态 */
  const state = {
    page: 1,
    limit: 24,
    q: '',
    uploader: '',
    ext: '',
    order: 'newest',
    pagination: null,
    items: [],
    selected: new Set(),
  };

  /* ============================ 启动 / 登录态 ============================ */

  async function boot() {
    if (!store.get(TOKEN_KEY)) return showLogin();

    try {
      const me = await request('/api/auth/me');
      $('token-display').value = store.get(TOKEN_KEY);
      showDash();
      if (me.default_password) {
        showAlert('dash-alert', 'warn',
          '当前仍在使用初始密码，存在安全风险。请到「存储与安全」标签页立即修改。');
      }
    } catch (_) {
      showLogin();
    }
  }

  function showLogin() {
    $('login-view').hidden = false;
    $('dash-view').hidden = true;
    $('logout-btn').hidden = true;
    $('password').focus();
  }

  function showDash() {
    $('login-view').hidden = true;
    $('dash-view').hidden = false;
    $('logout-btn').hidden = false;
    loadBrand();
    loadStats();
    loadImages();
    loadSettings();
  }

  function showAlert(hostId, type, message) {
    const host = $(hostId);
    if (!host) return;
    host.innerHTML = message ? `<div class="alert ${type}">${escapeHtml(message)}</div>` : '';
  }

  async function loadBrand() {
    try {
      const cfg = await request('/api/config', { auth: false });
      if (cfg.site_name) {
        $('brand-name').textContent = cfg.site_name;
        document.title = `管理台 · ${cfg.site_name}`;
      }
    } catch (_) { /* 忽略 */ }
  }

  /* ================================ 登录 ================================ */

  function bindLogin() {
    $('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('login-btn');
      const pwd = $('password').value;
      btn.disabled = true;
      btn.textContent = '登录中…';
      showAlert('login-alert', 'info', '');

      try {
        const data = await request('/api/auth/login', { method: 'POST', body: { password: pwd }, auth: false });
        store.set(TOKEN_KEY, data.token);
        $('token-display').value = data.token;
        $('password').value = '';
        toast('登录成功', 'success');
        showDash();
      } catch (err) {
        showAlert('login-alert', 'error', err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = '登录';
      }
    });

    $('logout-btn').addEventListener('click', async () => {
      try {
        await request('/api/auth/logout', { method: 'POST' });
      } catch (_) { /* 即便失败也清理本地 */ }
      store.del(TOKEN_KEY);
      toast('已退出登录', 'info');
      location.reload();
    });
  }

  /* ============================== 标签页切换 ============================== */

  function bindTabs() {
    document.querySelectorAll('.tabs-nav button[data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.tab;
        document.querySelectorAll('.tabs-nav button[data-tab]').forEach((b) => {
          const active = b === btn;
          b.classList.toggle('active', active);
          b.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        ['images', 'settings', 'storage'].forEach((t) => {
          $(`tab-${t}`).hidden = t !== target;
        });
        if (target === 'storage') checkStorageHealth();
      });
    });
  }

  /* ================================ 统计 ================================ */

  async function loadStats() {
    try {
      const s = await request('/api/images/stats');
      const formats = (s.byExt || [])
        .map((f) => `${f.ext.toUpperCase()} ${f.count}`)
        .join(' · ') || '—';

      $('stats').innerHTML = `
        <div class="card stat">
          <div class="label">图片总数</div>
          <div class="value">${s.total}</div>
          <div class="sub">动态图 ${s.animatedCount} · 矢量图 ${s.vectorCount}</div>
        </div>
        <div class="card stat">
          <div class="label">占用空间</div>
          <div class="value">${escapeHtml(s.total_human)}</div>
          <div class="sub">存储驱动：${(s.byDriver || []).map((d) => d.driver).join(' + ') || '—'}</div>
        </div>
        <div class="card stat">
          <div class="label">今日上传</div>
          <div class="value">${s.todayCount}</div>
          <div class="sub">${escapeHtml(s.today_bytes_human)}</div>
        </div>
        <div class="card stat">
          <div class="label">格式分布</div>
          <div class="value" style="font-size:14px;line-height:1.7;font-weight:600">${escapeHtml(formats)}</div>
        </div>`;

      // 动态填充格式筛选下拉框
      const extSelect = $('filter-ext');
      const current = extSelect.value;
      extSelect.innerHTML =
        '<option value="">全部格式</option>' +
        (s.byExt || [])
          .map((f) => `<option value="${escapeHtml(f.ext)}">${escapeHtml(f.ext.toUpperCase())} (${f.count})</option>`)
          .join('');
      extSelect.value = current;
    } catch (err) {
      toast(`统计加载失败：${err.message}`, 'error');
    }
  }

  /* ============================== 图片列表 ============================== */

  async function loadImages() {
    const tbody = $('image-tbody');
    tbody.innerHTML = `<tr><td colspan="8"><div class="empty"><p>加载中…</p></div></td></tr>`;

    try {
      const params = new URLSearchParams({
        page: String(state.page),
        limit: String(state.limit),
        order: state.order,
      });
      if (state.q) params.set('q', state.q);
      if (state.uploader) params.set('uploader', state.uploader);
      if (state.ext) params.set('ext', state.ext);

      const res = await fetch(`/api/images?${params}`, {
        headers: { Authorization: `Bearer ${store.get(TOKEN_KEY)}` },
      });
      const payload = await res.json();
      if (!res.ok) throw new Error((payload.error && payload.error.message) || `HTTP ${res.status}`);

      state.items = payload.data || [];
      state.pagination = payload.pagination;
      renderTable();
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="8"><div class="empty"><p>加载失败：${escapeHtml(err.message)}</p></div></td></tr>`;
    }
  }

  function renderTable() {
    const tbody = $('image-tbody');

    if (!state.items.length) {
      tbody.innerHTML = `<tr><td colspan="8"><div class="empty"><p>没有符合条件的图片</p></div></td></tr>`;
    } else {
      tbody.innerHTML = state.items
        .map(
          (it) => `
        <tr data-id="${escapeHtml(it.id)}">
          <td><input type="checkbox" class="row-check row-select" data-id="${escapeHtml(it.id)}"
                     ${state.selected.has(it.id) ? 'checked' : ''} aria-label="选择 ${escapeHtml(it.filename)}" /></td>
          <td class="thumb-cell">
            <a href="${escapeHtml(it.page_url)}" target="_blank" rel="noopener">
              <img src="${escapeHtml(it.thumb_url)}" alt="" loading="lazy" decoding="async" />
            </a>
          </td>
          <td class="name-cell">
            <div>${escapeHtml(it.filename)}</div>
            <div class="mono">${escapeHtml(it.id)} · ${escapeHtml(it.ext.toUpperCase())}${
              it.animated ? ' · 动态' : ''
            }${it.vector ? ' · 矢量' : ''}</div>
          </td>
          <td class="mono">${it.width || '?'} × ${it.height || '?'}</td>
          <td class="mono">${escapeHtml(it.size_human || formatSize(it.size))}</td>
          <td><span class="badge ${it.uploader === 'admin' ? 'info' : ''}">${
            it.uploader === 'admin' ? '管理员' : '游客'
          }</span></td>
          <td class="mono">${escapeHtml(formatTime(it.created_at))}</td>
          <td class="actions-cell">
            <button class="btn sm ghost" type="button" data-act="copy" data-id="${escapeHtml(it.id)}">复制链接</button>
            <a class="btn sm ghost" href="${escapeHtml(it.url)}" target="_blank" rel="noopener">查看</a>
            <button class="btn sm danger" type="button" data-act="delete" data-id="${escapeHtml(it.id)}">删除</button>
          </td>
        </tr>`,
        )
        .join('');
    }

    const p = state.pagination || { page: 1, pages: 1, total: 0 };
    $('page-info').textContent = `第 ${p.page} / ${p.pages} 页 · 共 ${p.total} 张`;
    $('prev-page').disabled = !p.has_prev;
    $('next-page').disabled = !p.has_next;

    syncSelectionUI();
  }

  function syncSelectionUI() {
    // 清理已不在当前页但仍被选中的 ID 无意义，这里保留跨页选择
    const count = state.selected.size;
    $('batch-bar').hidden = count === 0;
    $('selected-count').textContent = `已选 ${count} 张`;

    const pageIds = state.items.map((i) => i.id);
    const checkAll = $('check-all');
    checkAll.checked = pageIds.length > 0 && pageIds.every((id) => state.selected.has(id));
    checkAll.indeterminate = !checkAll.checked && pageIds.some((id) => state.selected.has(id));
  }

  function bindTableActions() {
    const tbody = $('image-tbody');

    tbody.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const { act, id } = btn.dataset;
      const item = state.items.find((i) => i.id === id);
      if (!item) return;

      if (act === 'copy') {
        copyWithToast(item.url, '直链已复制');
      } else if (act === 'delete') {
        if (!confirm(`确定删除「${item.filename}」吗？\n\n此操作会同时删除存储中的文件，且不可恢复。`)) return;
        try {
          await request(`/api/images/${encodeURIComponent(id)}`, { method: 'DELETE' });
          state.selected.delete(id);
          toast('已删除', 'success');
          loadImages();
          loadStats();
        } catch (err) {
          toast(`删除失败：${err.message}`, 'error');
        }
      }
    });

    tbody.addEventListener('change', (e) => {
      const cb = e.target.closest('.row-select');
      if (!cb) return;
      if (cb.checked) state.selected.add(cb.dataset.id);
      else state.selected.delete(cb.dataset.id);
      syncSelectionUI();
    });

    $('check-all').addEventListener('change', (e) => {
      const on = e.target.checked;
      state.items.forEach((it) => {
        if (on) state.selected.add(it.id);
        else state.selected.delete(it.id);
      });
      tbody.querySelectorAll('.row-select').forEach((cb) => { cb.checked = on; });
      syncSelectionUI();
    });

    $('clear-selection').addEventListener('click', () => {
      state.selected.clear();
      tbody.querySelectorAll('.row-select').forEach((cb) => { cb.checked = false; });
      $('check-all').checked = false;
      $('check-all').indeterminate = false;
      syncSelectionUI();
    });

    $('copy-selected').addEventListener('click', () => {
      const urls = state.items.filter((i) => state.selected.has(i.id)).map((i) => i.url);
      if (!urls.length) return toast('没有可复制的内容', 'info');
      copyWithToast(urls.join('\n'), `已复制 ${urls.length} 条直链`);
    });

    $('delete-selected').addEventListener('click', async () => {
      const ids = [...state.selected];
      if (!ids.length) return;
      if (!confirm(`确定删除选中的 ${ids.length} 张图片吗？\n\n文件将被永久移除，不可恢复。`)) return;

      try {
        const res = await request('/api/images/batch-delete', { method: 'POST', body: { ids } });
        toast(`已删除 ${res.deleted.length} 张${res.failed.length ? `，失败 ${res.failed.length} 张` : ''}`,
          res.failed.length ? 'info' : 'success');
        state.selected.clear();
        loadImages();
        loadStats();
      } catch (err) {
        toast(`批量删除失败：${err.message}`, 'error');
      }
    });
  }

  function bindFilters() {
    $('search-input').addEventListener('input', debounce(() => {
      state.q = $('search-input').value.trim();
      state.page = 1;
      loadImages();
    }, 320));

    $('filter-uploader').addEventListener('change', (e) => {
      state.uploader = e.target.value;
      state.page = 1;
      loadImages();
    });
    $('filter-ext').addEventListener('change', (e) => {
      state.ext = e.target.value;
      state.page = 1;
      loadImages();
    });
    $('filter-order').addEventListener('change', (e) => {
      state.order = e.target.value;
      state.page = 1;
      loadImages();
    });
    $('filter-limit').addEventListener('change', (e) => {
      state.limit = Number(e.target.value);
      state.page = 1;
      loadImages();
    });
    $('refresh-btn').addEventListener('click', () => { loadImages(); loadStats(); });

    $('prev-page').addEventListener('click', () => {
      if (state.page > 1) { state.page -= 1; loadImages(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    });
    $('next-page').addEventListener('click', () => {
      if (state.pagination && state.page < state.pagination.pages) {
        state.page += 1;
        loadImages();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  }

  /* ============================== 站点设置 ============================== */

  /** 从表单收集所有 data-key 字段，并按 data-type 转换 */
  function collect(root) {
    const out = {};
    root.querySelectorAll('[data-key]').forEach((el) => {
      const key = el.dataset.key;
      const type = el.dataset.type || 'text';

      switch (type) {
        case 'bool':
          out[key] = el.checked;
          break;
        case 'int':
          out[key] = Number(el.value);
          break;
        case 'mb':
          out[key] = Math.round(Number(el.value) * 1024 * 1024);
          break;
        case 'csv':
          out[key] = el.value.split(',').map((s) => s.trim()).filter(Boolean);
          break;
        default:
          out[key] = el.value;
      }
    });
    return out;
  }

  /** 把后端配置回填到表单 */
  function apply(root, cfg) {
    root.querySelectorAll('[data-key]').forEach((el) => {
      const key = el.dataset.key;
      if (!(key in cfg)) return;
      const type = el.dataset.type || 'text';
      const val = cfg[key];

      switch (type) {
        case 'bool':
          el.checked = !!val;
          break;
        case 'mb':
          el.value = String(Math.round(Number(val) / 1024 / 1024) || 1);
          break;
        case 'csv':
          el.value = Array.isArray(val) ? val.join(',') : String(val || '');
          break;
        case 'enum':
          el.value = val;
          break;
        default:
          // 敏感字段（如 WebDAV 密码）后端不回传明文，保持留空
          if (key === 'webdav_password') { el.value = ''; el.placeholder = val === undefined ? '未设置' : '留空表示不修改'; break; }
          el.value = val === undefined || val === null ? '' : String(val);
      }
    });
  }

  async function loadSettings() {
    try {
      const cfg = await request('/api/settings');
      apply($('settings-form'), cfg);
      apply($('tab-storage'), cfg);
      $('token-display').value = store.get(TOKEN_KEY) || '';
    } catch (err) {
      toast(`配置加载失败：${err.message}`, 'error');
    }
  }

  function bindSettingsForm() {
    $('settings-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('save-settings');
      btn.disabled = true;
      btn.textContent = '保存中…';
      try {
        const body = collect($('settings-form'));
        const res = await request('/api/settings', { method: 'PATCH', body });
        toast(`已更新 ${res.updated.length} 项配置${res.warnings && res.warnings.length ? '（有告警）' : ''}`,
          res.warnings && res.warnings.length ? 'info' : 'success');
        if (res.warnings && res.warnings.length) {
          showAlert('dash-alert', 'warn', res.warnings.join('；'));
        } else {
          showAlert('dash-alert', 'info', '');
        }
        loadStats();
      } catch (err) {
        toast(`保存失败：${err.message}`, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '保存设置';
      }
    });

    $('save-webdav').addEventListener('click', async () => {
      const btn = $('save-webdav');
      btn.disabled = true;
      btn.textContent = '保存中…';
      try {
        const body = collect($('tab-storage'));
        // 未填写的 WebDAV 密码不提交，避免误清空
        if (!body.webdav_password) delete body.webdav_password;
        const res = await request('/api/settings', { method: 'PATCH', body });
        toast(`存储配置已保存（${res.config.storage_driver}）`, 'success');
        checkStorageHealth();
      } catch (err) {
        toast(`保存失败：${err.message}`, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '保存存储配置';
      }
    });

    $('test-storage').addEventListener('click', checkStorageHealth);
  }

  async function checkStorageHealth() {
    const host = $('storage-health');
    host.innerHTML = '<div class="alert info">正在检测存储驱动…</div>';
    try {
      const res = await request('/api/storage/health');
      host.innerHTML = res.drivers
        .map(
          (d) => `<div class="alert ${d.ok ? 'ok' : 'error'}">
            <strong>${escapeHtml(d.driver)}</strong>：${escapeHtml(d.message)}
            ${d.detail ? `<span class="mono"> — ${escapeHtml(d.detail)}</span>` : ''}
          </div>`,
        )
        .join('');
    } catch (err) {
      host.innerHTML = `<div class="alert error">检测失败：${escapeHtml(err.message)}</div>`;
    }
  }

  /* ============================== 密码 / Token ============================== */

  function bindPassword() {
    $('password-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const oldPwd = $('old-password').value;
      const newPwd = $('new-password').value;
      if (newPwd.length < 6) return toast('新密码至少 6 位', 'error');

      try {
        const res = await request('/api/auth/password', {
          method: 'POST',
          body: { old_password: oldPwd, new_password: newPwd },
        });
        store.set(TOKEN_KEY, res.token);
        $('token-display').value = res.token;
        $('old-password').value = '';
        $('new-password').value = '';
        toast('密码已更新，其它会话已失效', 'success', 3600);
        showAlert('dash-alert', 'info', '');
      } catch (err) {
        toast(`修改失败：${err.message}`, 'error');
      }
    });

    $('copy-token').addEventListener('click', () => {
      copyWithToast($('token-display').value, 'Token 已复制');
    });
  }

  /* ================================ 启动 ================================ */

  document.addEventListener('DOMContentLoaded', () => {
    bindLogin();
    bindTabs();
    bindTableActions();
    bindFilters();
    bindSettingsForm();
    bindPassword();
    boot();
  });
})();
