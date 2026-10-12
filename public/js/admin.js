/* ==========================================================================
   Lumina · 管理台逻辑
   单管理员登录 → 统计 / 图片管理（查看·筛选·删除） / 站点设置 / 存储与安全
   ========================================================================== */

(() => {
  'use strict';

  const { request, store, toast, copyWithToast, escapeHtml, formatSize, formatTime, debounce, applyFavicon, TOKEN_KEY } = Lumina;

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
        // 带直达按钮的告警：说清风险的同时，把用户送到修改入口
        const host = $('dash-alert');
        host.innerHTML = `
          <div class="alert warn">当前仍在使用初始密码，存在安全风险，建议立即修改。
            <button class="btn sm" type="button" id="goto-storage">去修改 →</button>
          </div>`;
        $('goto-storage').addEventListener('click', () => activateTab('storage'));
      }
    } catch (_) {
      showLogin();
    }
  }

  function showLogin() {
    document.body.classList.add('is-login');
    $('login-view').hidden = false;
    $('dash-view').hidden = true;
    $('logout-btn').hidden = true;
    $('password').focus();
  }

  function showDash() {
    document.body.classList.remove('is-login');
    $('login-view').hidden = true;
    $('dash-view').hidden = false;
    $('logout-btn').hidden = false;
    activateTab('dashboard'); // 登录后默认落在仪表盘
    loadBrand();
    loadStats();
    loadImages(); // 预加载图片列表：切到「图片管理」即秒开
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
      applyFavicon(cfg.favicon_url);
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

  /* ============================ 侧边栏导航 ============================ */

  const PAGE_TITLES = { dashboard: '仪表盘', images: '图片管理', settings: '站点设置', storage: '存储与安全' };
  const PAGES = Object.keys(PAGE_TITLES);

  /** 收起移动端抽屉（桌面无副作用） */
  function closeDrawer() {
    document.body.classList.remove('side-open');
  }

  /** 切换到指定页面（侧边栏高亮 + 视图显隐 + 顶栏标题），供导航点击与告警快捷跳转共用 */
  function activateTab(target) {
    document.querySelectorAll('.side-nav [data-tab]').forEach((b) => {
      const active = b.dataset.tab === target;
      b.classList.toggle('active', active);
      if (active) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    PAGES.forEach((t) => {
      const el = $(`tab-${t}`);
      if (el) el.hidden = t !== target;
    });
    const title = $('page-title');
    if (title) title.textContent = PAGE_TITLES[target] || '';
    closeDrawer();
    if (target === 'storage') checkStorageHealth();
  }

  function bindSideNav() {
    document.querySelectorAll('.side-nav [data-tab]').forEach((btn) => {
      btn.addEventListener('click', () => activateTab(btn.dataset.tab));
    });
  }

  /**
   * 侧边栏开合（一个按钮双语义）：
   * ≤920px 切 body.side-open（抽屉 + 遮罩），>920px 切 body.side-collapsed（72px 图标条）。
   * 遮罩点击与 Esc 都会收起抽屉；与 common.js 的「Esc 收 details 菜单」互不干扰。
   */
  function bindSideToggle() {
    const isNarrow = () =>
      !!(window.matchMedia && window.matchMedia('(max-width: 920px)').matches);

    $('side-toggle').addEventListener('click', () => {
      document.body.classList.toggle(isNarrow() ? 'side-open' : 'side-collapsed');
    });
    $('side-mask').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeDrawer();
    });
  }

  /* ================================ 统计 ================================ */

  async function loadStats() {
    try {
      const s = await request('/api/images/stats');
      const formats = (s.byExt || [])
        .map((f) => `${f.ext.toUpperCase()} ${f.count}`)
        .join(' · ');
      const DRIVER_TEXT = { local: '本地磁盘', webdav: 'WebDAV 网盘', hybrid: '本地 + WebDAV 双写' };
      const STAT_ICONS = {
        image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
        disk: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
        upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/></svg>',
        tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.83z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>',
      };
      const card = (icon, label, value, sub, extra = '') => `
        <div class="card stat">
          <span class="stat-ico" aria-hidden="true">${STAT_ICONS[icon]}</span>
          <div class="stat-body">
            <div class="label">${label}</div>
            <div class="value"${extra}>${value}</div>
            <div class="sub">${sub}</div>
          </div>
        </div>`;

      $('stats').innerHTML =
        card('image', '图片总数', s.total, `动态图 ${s.animatedCount} · 矢量图 ${s.vectorCount}`) +
        card('disk', '占用空间', escapeHtml(s.total_human),
          `存储方式：${(s.byDriver || []).map((d) => DRIVER_TEXT[d.driver] || d.driver).join(' + ') || '—'}`) +
        card('upload', '今日上传', s.todayCount,
          s.todayCount ? escapeHtml(s.today_bytes_human) : '今日暂无上传') +
        card('tag', '格式分布',
          escapeHtml(formats || '—'), '&nbsp;',
          ' class="clamp" style="font-size:14px;line-height:1.7;font-weight:600" title="' +
          escapeHtml(formats || '—') + '"');

      // 侧边栏底部迷你容量块（来自同一接口，无配额概念仅展示总量）
      $('cap-total').textContent = `共 ${s.total} 张图片`;
      $('cap-size').textContent = `占用 ${s.total_human}`;

      // 动态填充格式筛选下拉框
      const extSelect = $('filter-ext');
      let current = extSelect.value;
      extSelect.innerHTML =
        '<option value="">全部</option>' +
        (s.byExt || [])
          .map((f) => `<option value="${escapeHtml(f.ext)}">${escapeHtml(f.ext.toUpperCase())} (${f.count})</option>`)
          .join('');
      // 旧筛选值对应的格式已不存在时，下拉框会显示「全部」但 state.ext 仍是旧值，
      // 后续刷新/翻页会继续按不可见的旧格式过滤 —— 必须把状态一并重置
      if (current && !Array.from(extSelect.options).some((o) => o.value === current)) {
        current = '';
        state.ext = '';
      }
      extSelect.value = current;
    } catch (err) {
      toast(`统计加载失败：${err.message}`, 'error');
    }
  }

  /* ============================== 图片列表 ============================== */

  async function loadImages() {
    const grid = $('image-grid');
    grid.innerHTML = `<div class="empty"><p>加载中…</p></div>`;

    try {
      const params = new URLSearchParams({
        page: String(state.page),
        limit: String(state.limit),
        order: state.order,
      });
      if (state.q) params.set('q', state.q);
      if (state.uploader) params.set('uploader', state.uploader);
      if (state.ext) params.set('ext', state.ext);

      // 走统一请求封装（full 模式取回分页字段）：401 时自动清理失效 Token，
      // 此前绕过封装导致 Token 过期后列表假死（不清理、不回登录态）
      const payload = await request(`/api/images?${params}`, { full: true });
      state.items = (payload && payload.data) || [];
      state.pagination = (payload && payload.pagination) || null;
      renderGrid();
    } catch (err) {
      grid.innerHTML = `<div class="empty"><p>加载失败：${escapeHtml(err.message)}</p></div>`;
    }
  }

  /** 单张删除：列表快捷按钮与右键菜单共用 */
  async function deleteOne(item) {
    if (!confirm(`确定删除「${item.filename}」吗？\n\n此操作会同时删除存储中的文件，且不可恢复。`)) return;
    try {
      await request(`/api/images/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      state.selected.delete(item.id);
      toast('已删除', 'success');
      loadImages();
      loadStats();
    } catch (err) {
      toast(`删除失败：${err.message}`, 'error');
    }
  }

  /**
   * 瀑布流卡片：按 CSS 多列自适应分列，卡片按原图宽高比占位（不发生加载跳动）；
   * 悬停浮出勾选圈与快捷操作，右键卡片可呼出完整操作菜单。
   */
  function renderGrid() {
    const grid = $('image-grid');

    if (!state.items.length) {
      grid.innerHTML = `<div class="empty"><p>没有符合条件的图片</p></div>`;
    } else {
      grid.innerHTML = state.items
        .map((it) => {
          const ratio = Number(it.width) > 0 && Number(it.height) > 0
            ? ` style="aspect-ratio:${Number(it.width)} / ${Number(it.height)}"` : '';
          const wrapClass = ratio ? 'img-wrap has-ratio' : 'img-wrap';
          const badges = [
            it.animated ? '<span class="badge info">动态</span>' : '',
            it.vector ? '<span class="badge info">矢量</span>' : '',
            `<span class="badge ${it.uploader === 'admin' ? 'info' : ''}">${
              it.uploader === 'admin' ? '管理员' : '游客'
            }</span>`,
          ].join('');
          const selected = state.selected.has(it.id);

          return `
        <figure class="img-card${selected ? ' selected' : ''}" data-id="${escapeHtml(it.id)}"
                title="${escapeHtml(it.filename)} · ${escapeHtml(formatTime(it.created_at))}">
          <div class="${wrapClass}"${ratio}>
            <a href="${escapeHtml(it.page_url)}" target="_blank" rel="noopener" tabindex="-1">
              <img src="${escapeHtml(it.thumb_url)}" alt="${escapeHtml(it.filename)}" loading="lazy" decoding="async" />
            </a>
            <label class="pick">
              <input type="checkbox" class="row-check row-select" data-id="${escapeHtml(it.id)}"
                     ${selected ? 'checked' : ''} aria-label="选择 ${escapeHtml(it.filename)}" />
              <span class="pick-box" aria-hidden="true"></span>
            </label>
            <div class="img-actions">
              <button class="mini" type="button" data-act="copy" data-id="${escapeHtml(it.id)}">复制链接</button>
              <a class="mini" href="${escapeHtml(it.url)}" target="_blank" rel="noopener">查看</a>
              <button class="mini danger" type="button" data-act="delete" data-id="${escapeHtml(it.id)}"
                      title="删除这张图片（不可恢复）">删除</button>
            </div>
          </div>
          <figcaption class="img-meta">
            <div class="img-name">${escapeHtml(it.filename)}</div>
            <div class="img-sub">
              <span class="mono">${it.width || '?'}×${it.height || '?'} · ${escapeHtml(it.size_human || formatSize(it.size))} · ${escapeHtml(String(it.ext || '').toUpperCase())}</span>
              ${badges}
            </div>
          </figcaption>
        </figure>`;
        })
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

  function bindGridActions() {
    const grid = $('image-grid');

    grid.addEventListener('click', async (e) => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      const { act, id } = btn.dataset;
      const item = state.items.find((i) => i.id === id);
      if (!item) return;

      if (act === 'copy') {
        copyWithToast(item.url, '链接已复制');
      } else if (act === 'delete') {
        deleteOne(item);
      }
    });

    grid.addEventListener('change', (e) => {
      const cb = e.target.closest('.row-select');
      if (!cb) return;
      const card = cb.closest('.img-card');
      if (cb.checked) state.selected.add(cb.dataset.id);
      else state.selected.delete(cb.dataset.id);
      if (card) card.classList.toggle('selected', cb.checked);
      syncSelectionUI();
    });

    // 右键卡片：呼出图片操作菜单（阻止默认菜单，具体项见 openContextMenu）
    grid.addEventListener('contextmenu', (e) => {
      const card = e.target.closest('.img-card');
      if (!card) return;
      const item = state.items.find((i) => i.id === card.dataset.id);
      if (!item) return;
      e.stopPropagation(); // 不让 document 级「点击外部关闭」逻辑立即收起菜单
      openContextMenu(e, item);
    });

    $('check-all').addEventListener('change', (e) => {
      const on = e.target.checked;
      state.items.forEach((it) => {
        if (on) state.selected.add(it.id);
        else state.selected.delete(it.id);
      });
      grid.querySelectorAll('.row-select').forEach((cb) => { cb.checked = on; });
      grid.querySelectorAll('.img-card').forEach((card) => {
        card.classList.toggle('selected', on);
      });
      syncSelectionUI();
    });

    $('clear-selection').addEventListener('click', () => {
      state.selected.clear();
      grid.querySelectorAll('.row-select').forEach((cb) => { cb.checked = false; });
      grid.querySelectorAll('.img-card.selected').forEach((card) => card.classList.remove('selected'));
      $('check-all').checked = false;
      $('check-all').indeterminate = false;
      syncSelectionUI();
    });

    $('copy-selected').addEventListener('click', () => {
      const urls = state.items.filter((i) => state.selected.has(i.id)).map((i) => i.url);
      if (!urls.length) return toast('没有可复制的内容', 'info');
      copyWithToast(urls.join('\n'), `已复制 ${urls.length} 条链接`);
    });

    $('delete-selected').addEventListener('click', async () => {
      let ids = [...state.selected];
      if (!ids.length) return;
      // 服务端单次批量删除上限 200：超限会整单 400，前端先行截断并提示
      if (ids.length > 200) {
        toast(`单次最多删除 200 张，本次仅删除前 200 张（已选 ${ids.length} 张）`, 'info', 4000);
        ids = ids.slice(0, 200);
      }
      if (!confirm(`确定删除选中的 ${ids.length} 张图片吗？\n\n文件将被永久移除，不可恢复。`)) return;

      try {
        const res = await request('/api/images/batch-delete', { method: 'POST', body: { ids } });
        toast(`已删除 ${res.deleted.length} 张${res.failed.length ? `，失败 ${res.failed.length} 张` : ''}`,
          res.failed.length ? 'info' : 'success');
        ids.forEach((id) => state.selected.delete(id));
        syncSelectionUI();
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

  /* ============================ 右键菜单 / 详细信息 ============================ */

  const CTX_ICONS = {
    refresh: '<svg class="ctx-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>',
    image: '<svg class="ctx-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>',
    link: '<svg class="ctx-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
    external: '<svg class="ctx-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14L21 3"/></svg>',
    info: '<svg class="ctx-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>',
    trash: '<svg class="ctx-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  };

  /** 右键菜单当前作用对象 */
  let ctxMenu = null;
  let ctxItem = null;

  /** 懒构建单例菜单（跟随系统托底样式，与既有 .menu 风格一致） */
  function ensureContextMenu() {
    if (ctxMenu) return ctxMenu;
    ctxMenu = document.createElement('div');
    ctxMenu.className = 'ctx-menu';
    ctxMenu.hidden = true;
    ctxMenu.setAttribute('role', 'menu');
    ctxMenu.setAttribute('aria-label', '图片操作');
    ctxMenu.innerHTML = `
      <button type="button" class="ctx-item" role="menuitem" data-cmd="refresh">${CTX_ICONS.refresh}刷新</button>
      <div class="ctx-sep" role="separator"></div>
      <button type="button" class="ctx-item" role="menuitem" data-cmd="copy-image">${CTX_ICONS.image}复制图片</button>
      <div class="ctx-has-sub">
        <button type="button" class="ctx-item" role="menuitem" aria-haspopup="true" aria-expanded="false"
                data-cmd="copy-link">${CTX_ICONS.link}复制链接<span class="ctx-arrow" aria-hidden="true">▸</span></button>
        <div class="ctx-sub" role="menu" aria-label="复制链接格式">
          <button type="button" role="menuitem" data-copy="url">Url（直链）</button>
          <button type="button" role="menuitem" data-copy="html">Html</button>
          <button type="button" role="menuitem" data-copy="bbcode">BBCode</button>
          <button type="button" role="menuitem" data-copy="markdown">Markdown</button>
          <button type="button" role="menuitem" data-copy="markdown_thumb">Markdown with link</button>
          <button type="button" role="menuitem" data-copy="thumbnail">Thumbnail url</button>
        </div>
      </div>
      <button type="button" class="ctx-item" role="menuitem" data-cmd="open">${CTX_ICONS.external}新窗口打开</button>
      <button type="button" class="ctx-item" role="menuitem" data-cmd="details">${CTX_ICONS.info}详细信息</button>
      <div class="ctx-sep" role="separator"></div>
      <button type="button" class="ctx-item danger" role="menuitem" data-cmd="delete">${CTX_ICONS.trash}删除</button>`;

    ctxMenu.addEventListener('click', (e) => {
      // 1) 二级菜单里的「复制某种格式」
      const sub = e.target.closest('[data-copy]');
      if (sub) {
        const text = ctxItem && ctxItem.formats && ctxItem.formats[sub.dataset.copy];
        if (text) copyWithToast(text, '已复制');
        closeContextMenu();
        return;
      }
      const btn = e.target.closest('[data-cmd]');
      if (!btn) return;
      const cmd = btn.dataset.cmd;

      // 2) 「复制链接」父项：触屏设备没有 hover，点击切换二级菜单
      if (cmd === 'copy-link') {
        const host = btn.parentElement;
        const opened = host.classList.toggle('sub-open');
        btn.setAttribute('aria-expanded', opened ? 'true' : 'false');
        return;
      }

      // 3) 其余命令：先取走目标对象再收菜单（closeContextMenu 会清空 ctxItem）
      const item = ctxItem;
      closeContextMenu();
      if (!item) return;
      switch (cmd) {
        case 'refresh': loadImages(); loadStats(); break;
        case 'copy-image': copyImageToClipboard(item); break;
        case 'open': window.open(item.url, '_blank', 'noopener'); break;
        case 'details': showDetailsModal(item); break;
        case 'delete': deleteOne(item); break;
        default: break;
      }
    });

    document.body.appendChild(ctxMenu);
    return ctxMenu;
  }

  function openContextMenu(e, item) {
    e.preventDefault();
    ctxItem = item;
    const menu = ensureContextMenu();
    menu.hidden = false;
    menu.classList.remove('sub-left');
    // 光标落在屏幕右侧时二级菜单改为向左展开，避免溢出视口
    if (window.innerWidth - e.clientX < 430) menu.classList.add('sub-left');

    const rect = menu.getBoundingClientRect();
    const x = Math.min(e.clientX, window.innerWidth - rect.width - 8);
    const y = Math.min(e.clientY, window.innerHeight - rect.height - 8);
    menu.style.left = `${Math.max(8, x)}px`;
    menu.style.top = `${Math.max(8, y)}px`;
  }

  function closeContextMenu() {
    if (!ctxMenu) return;
    ctxMenu.hidden = true;
    ctxItem = null;
    const host = ctxMenu.querySelector('.ctx-has-sub');
    if (host) host.classList.remove('sub-open');
    const linkBtn = ctxMenu.querySelector('[data-cmd="copy-link"]');
    if (linkBtn) linkBtn.setAttribute('aria-expanded', 'false');
  }

  /** 菜单外的点击 / 滚动 / 缩放 / Esc 都收起菜单（bind 一次） */
  function bindContextMenuGlobal() {
    document.addEventListener('click', (e) => {
      if (ctxMenu && !ctxMenu.hidden && !ctxMenu.contains(e.target)) closeContextMenu();
    });
    document.addEventListener('contextmenu', (e) => {
      if (ctxMenu && !ctxMenu.hidden && !ctxMenu.contains(e.target)) closeContextMenu();
    });
    document.addEventListener('scroll', () => {
      if (ctxMenu && !ctxMenu.hidden) closeContextMenu();
    }, true);
    window.addEventListener('resize', closeContextMenu);
    window.addEventListener('blur', closeContextMenu);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && ctxMenu && !ctxMenu.hidden) closeContextMenu();
    });
  }

  /** 复制图片本体：非 PNG 先经 Canvas 转成 PNG（剪贴板兼容性最好），失败如实提示 */
  async function copyImageToClipboard(item) {
    if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
      toast('当前浏览器不支持复制图片，可改用「复制链接」', 'error');
      return;
    }
    try {
      const blob = await (await fetch(item.url)).blob();
      let payload = blob;
      if (blob.type !== 'image/png') {
        const bmp = await createImageBitmap(blob);
        const canvas = document.createElement('canvas');
        canvas.width = bmp.width;
        canvas.height = bmp.height;
        canvas.getContext('2d').drawImage(bmp, 0, 0);
        payload = await new Promise((resolve, reject) => {
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG 编码失败'))), 'image/png');
        });
        if (bmp.close) bmp.close();
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': payload })]);
      toast('图片已复制到剪贴板', 'success');
    } catch (err) {
      toast(`复制图片失败：${err.message}`, 'error');
    }
  }

  /* --------------------------- 详细信息弹窗 --------------------------- */

  let detailsModal = null;

  function ensureDetailsModal() {
    if (detailsModal) return detailsModal;
    detailsModal = document.createElement('div');
    detailsModal.className = 'modal-mask';
    detailsModal.hidden = true;
    detailsModal.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="details-title">
        <header class="modal-head">
          <h3 id="details-title">图片详细信息</h3>
          <button type="button" class="modal-close" data-close aria-label="关闭">×</button>
        </header>
        <div class="modal-body">
          <div class="modal-preview"><img alt="" /></div>
          <div class="modal-rows"></div>
          <div class="copybox">
            <input readonly data-link aria-label="图片直链" />
            <button class="btn sm" type="button" data-copy-link>复制直链</button>
          </div>
        </div>
      </div>`;

    detailsModal.addEventListener('click', (e) => {
      if (e.target === detailsModal || e.target.closest('[data-close]')) hideDetailsModal();
      if (e.target.closest('[data-copy-link]')) {
        copyWithToast(detailsModal.querySelector('[data-link]').value, '链接已复制');
      }
    });
    document.body.appendChild(detailsModal);
    return detailsModal;
  }

  function showDetailsModal(item) {
    const modal = ensureDetailsModal();
    const DRIVER_TEXT = { local: '本地磁盘', webdav: 'WebDAV 网盘', hybrid: '本地 + WebDAV 双写' };

    const preview = modal.querySelector('.modal-preview img');
    preview.src = item.url;
    preview.alt = item.filename;

    modal.querySelector('.modal-rows').innerHTML = [
      ['文件名', item.filename],
      ['图片 ID', item.id],
      ['尺寸', `${item.width || '?'} × ${item.height || '?'}${item.animated ? '（动态）' : ''}${item.vector ? '（矢量）' : ''}`],
      ['体积', item.size_human || formatSize(item.size)],
      ['格式', String(item.ext || '').toUpperCase()],
      ['来源', item.uploader === 'admin' ? '管理员上传' : '访客上传'],
      ['上传时间', formatTime(item.created_at)],
      ['存储驱动', DRIVER_TEXT[item.storage_driver] || item.storage_driver || '—'],
    ]
      .map(([k, v]) => `<div class="modal-row"><span class="k">${k}</span><span class="v">${escapeHtml(v)}</span></div>`)
      .join('');

    modal.querySelector('[data-link]').value = item.url;
    modal.hidden = false;
  }

  function hideDetailsModal() {
    if (!detailsModal) return;
    detailsModal.hidden = true;
    detailsModal.querySelector('.modal-preview img').src = '';
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
      renderFavicon(cfg);
      $('token-display').value = store.get(TOKEN_KEY) || '';
    } catch (err) {
      toast(`配置加载失败：${err.message}`, 'error');
    }
  }

  /* ============================== 站点图标 ============================== */

  const FAVICON_DEFAULT = '/favicon.svg';

  /** 按后端配置渲染图标预览与按钮状态 */
  function renderFavicon(cfg) {
    const set = !!(cfg && cfg.favicon_set);
    // 预览加时间戳破缓存，避免刚上传的图标被浏览器缓存挡住
    const bust = (u) => `${u}${u.includes('?') ? '&' : '?'}_=${Date.now()}`;
    $('favicon-preview').src = set ? bust(cfg.favicon_url) : bust(FAVICON_DEFAULT);
    $('favicon-reset').hidden = !set;
    $('favicon-ext').textContent = set
      ? `当前自定义图标：.${cfg.favicon_ext}`
      : '当前使用默认图标';
  }

  function bindFavicon() {
    $('favicon-upload').addEventListener('click', () => $('favicon-input').click());

    $('favicon-input').addEventListener('change', async () => {
      const input = $('favicon-input');
      const file = input.files && input.files[0];
      if (!file) return;
      if (file.size > 1024 * 1024) {
        toast('图标不能超过 1MB', 'error');
        input.value = '';
        return;
      }

      const btn = $('favicon-upload');
      btn.disabled = true;
      btn.textContent = '上传中…';
      try {
        const fd = new FormData();
        fd.append('file', file);
        const res = await request('/api/favicon', { method: 'POST', body: fd });
        renderFavicon({ favicon_set: true, favicon_ext: res.ext, favicon_url: res.favicon_url });
        applyFavicon(res.favicon_url); // 本页图标立即切换
        toast('站点图标已更新', 'success');
      } catch (err) {
        toast(`上传失败：${err.message}`, 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = '上传图标';
        input.value = '';
      }
    });

    $('favicon-reset').addEventListener('click', async () => {
      try {
        const res = await request('/api/favicon', { method: 'DELETE' });
        renderFavicon({ favicon_set: false });
        applyFavicon(res.favicon_url);
        toast('已恢复默认图标', 'success');
      } catch (err) {
        toast(`操作失败：${err.message}`, 'error');
      }
    });
  }

  function bindSettingsForm() {
    $('settings-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('save-settings');
      const floatBtn = $('save-settings-float');
      btn.disabled = true;
      btn.textContent = '保存中…';
      if (floatBtn) { floatBtn.disabled = true; floatBtn.textContent = '保存中…'; }
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
        if (floatBtn) { floatBtn.disabled = false; floatBtn.textContent = '保存设置'; }
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
    bindSideNav();
    bindSideToggle();
    bindGridActions();
    bindContextMenuGlobal();
    bindFilters();
    bindSettingsForm();
    bindFavicon();
    bindPassword();
    boot();
  });
})();
