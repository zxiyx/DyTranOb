'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const state = { token: '', accounts: [], actions: [], events: [], connections: [], revision: 0, connectionFilter: '', connectionsLoaded: false, editing: null, deleting: null, selected: null, paused: false, connected: false, stream: null, session: null, poll: null, reconnect: null, qrPoll: null, qrRequest: 0, generation: 0 };
  const names = { overview: '运行概览', connections: '连接配置', events: '事件日志', actions: '动作调试' };
  const tokenKey = 'dytranob.accessToken';
  const mobileViewport = window.matchMedia('(max-width: 650px)');
  const pendingConnections = new Set();
  let toastTimer;

  function el(tag, className, content) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = String(content);
    return node;
  }

  function toast(message, error = false) {
    const node = $('toast');
    node.textContent = message;
    node.className = `toast${error ? ' error' : ''}`;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 3600);
  }

  function navigate(view) {
    if (!state.connected || !Object.hasOwn(names, view)) return;
    for (const key of Object.keys(names)) $(`${key}-view`).hidden = key !== view;
    for (const button of document.querySelectorAll('[data-view]')) {
      const active = button.dataset.view === view;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
    $('page-title').textContent = names[view];
    document.title = `DyTranOb · ${names[view]}`;
    window.scrollTo({ top: 0, behavior: 'instant' });
    if (view === 'events') renderEvents();
    if (view === 'connections') loadConnections().catch(() => {});
    closeMobileMenu();
  }

  function connection(label, status = '') {
    const badge = $('connection-state');
    badge.replaceChildren(el('span', 'status-dot'), document.createTextNode(label));
    badge.className = `connection-badge ${status}`;
    for (const node of document.querySelectorAll('[data-runtime-state]')) { node.textContent = status === 'connected' ? '运行中' : label; node.classList.toggle('online', status === 'connected'); }
  }

  async function api(path, options = {}) {
    if (!state.token) throw new Error('请先登录控制台。');
    const generation = state.generation;
    const headers = new Headers(options.headers);
    headers.set('Authorization', `Bearer ${state.token}`);
    if (options.body) headers.set('Content-Type', 'application/json');
    const response = await fetch(path, { ...options, headers, signal: state.session?.signal, cache: 'no-store' });
    if (generation !== state.generation) throw new DOMException('会话已结束。', 'AbortError');
    if (response.status === 401) {
      stopConnection('访问令牌已失效，请重新登录。');
      const error = new Error('访问令牌不正确或已失效，请检查启动日志中的 WebUI Token。');
      error.status = 401;
      throw error;
    }
    let payload;
    try { payload = await response.json(); } catch { throw new Error(`运行时返回了非 JSON 响应（HTTP ${response.status}）。`); }
    if (generation !== state.generation) throw new DOMException('会话已结束。', 'AbortError');
    if (!response.ok || payload.status === 'failed') {
      const error = new Error(payload.message || payload.wording || `请求失败（HTTP ${response.status}）。`);
      error.retcode = payload.retcode;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function uptime(seconds) {
    const value = Math.max(0, Number(seconds) || 0);
    if (value < 60) return `${Math.floor(value)}s`;
    if (value < 3600) return `${Math.floor(value / 60)}m`;
    if (value < 86400) return `${Math.floor(value / 3600)}h ${Math.floor(value % 3600 / 60)}m`;
    return `${Math.floor(value / 86400)}d ${Math.floor(value % 86400 / 3600)}h`;
  }

  function isOnline(account) { return account.online === true || account.status === 'online'; }

  function renderAccounts() {
    const container = $('account-list');
    container.replaceChildren();
    $('account-count').textContent = String(state.accounts.length);
    if (!state.accounts.length) {
      const empty = el('div', 'empty-state');
      empty.append(el('span', '', '◎'), el('h3', '', state.connected ? '尚未配置账号' : '连接你的运行时'), el('p', '', state.connected ? '点击右上角「添加账号」开始。' : '填写访问令牌，读取账号与连接状态。'));
      container.append(empty);
    }
    for (const account of state.accounts) {
      const id = String(account.id ?? account.account_id ?? 'default');
      const online = isOnline(account);
      const row = el('div', 'account-row');
      const info = el('div', 'account-info');
      const displayName = account.nickname || account.name || account.account?.nickname || id;
      info.append(el('strong', '', displayName), el('small', '', `${id} · ${account.kind || account.type || 'douyin'}${account.self_id ? ` · ${account.self_id}` : ''}`));
      const status = el('span', `account-state${online ? ' online' : ''}`);
      status.append(el('span', 'tiny-dot'), document.createTextNode(online ? '在线' : '离线'));
      const login = el('button', 'button secondary account-login', online ? '登录信息' : '扫码登录');
      login.addEventListener('click', () => startQrLogin(id, online));
      const remove = el('button', 'button secondary account-remove', '移除');
      remove.dataset.testid = 'remove-account';
      remove.setAttribute('aria-label', `移除账号 ${id}`);
      // The runtime keeps at least one account.
      remove.disabled = state.accounts.length <= 1 || state.accountBusy;
      remove.title = state.accounts.length <= 1 ? '至少保留一个账号' : '停止并移除此账号（本地会话数据保留）';
      remove.addEventListener('click', () => openRemoveAccount(id));
      const actions = el('div', 'account-actions');
      actions.append(login, remove);
      row.append(el('span', 'avatar', String(displayName).slice(0, 1).toUpperCase()), info, status, actions);
      container.append(row);
    }
    const previous = $('action-account').value;
    $('action-account').replaceChildren(new Option('运行时默认账号', ''));
    for (const account of state.accounts) {
      const id = String(account.id ?? account.account_id ?? 'default');
      $('action-account').add(new Option(id, id));
    }
    $('action-account').value = previous;
    $('stat-accounts').replaceChildren(document.createTextNode(String(state.accounts.filter(isOnline).length)), el('small', '', ` / ${state.accounts.length}`));
  }

  async function refreshStatus() {
    const { data } = await api('/api/status');
    state.accounts = Array.isArray(data.accounts) ? data.accounts : [];
    renderAccounts();
    $('stat-uptime').textContent = uptime(data.uptime);
    $('stat-version').textContent = `DyTranOb v${data.version || '0.1.0'}`;
    $('footer-version').textContent = data.version || '0.1.0';
    $('sidebar-version').textContent = data.version || '0.1.0';
    $('active-account').textContent = state.accounts.length ? `${state.accounts[0].nickname || state.accounts[0].name || state.accounts[0].id} · ${state.accounts.length} 个账号` : '本地运行时';
  }

  function sampleParams(schema) {
    if (schema?.examples?.[0]) return structuredClone(schema.examples[0]);
    const output = {};
    const fields = schema?.properties || {};
    const required = Array.isArray(schema?.required) ? schema.required : [];
    for (const name of required) {
      const field = fields[name] || {};
      if (field.default !== undefined) output[name] = field.default;
      else if (Array.isArray(field.enum) && field.enum.length) output[name] = field.enum[0];
      else if (name === 'message') output[name] = [{ type: 'text', data: { text: '你好，来自 DyTranOb' } }];
      else if (field.type === 'integer' || field.type === 'number') output[name] = field.minimum ?? 0;
      else if (field.type === 'boolean') output[name] = false;
      else if (field.type === 'array') output[name] = [];
      else if (field.type === 'object') output[name] = {};
      else output[name] = '';
    }
    return output;
  }

  function selectAction() {
    const action = state.actions.find((item) => item.action === $('action-select').value);
    $('action-description').textContent = action?.description || '选择一个动作。';
    $('action-schema').textContent = JSON.stringify(action?.params || {}, null, 2);
    $('action-params').value = JSON.stringify(sampleParams(action?.params), null, 2);
  }

  function renderActions() {
    const previous = $('action-select').value;
    $('action-select').replaceChildren();
    for (const action of state.actions) $('action-select').add(new Option(action.action, action.action));
    if (state.actions.some((action) => action.action === previous)) $('action-select').value = previous;
    else if (state.actions.some((action) => action.action === 'get_status')) $('action-select').value = 'get_status';
    $('stat-actions').replaceChildren(document.createTextNode(String(state.actions.length)), el('small', '', ' 个'));
    selectAction();
  }

  function eventDescription(event) {
    if (typeof event.raw_message === 'string' && event.raw_message) return event.raw_message;
    if (Array.isArray(event.message)) return event.message.map((segment) => segment.type === 'text' ? segment.data?.text || '' : `[${segment.type}]`).join('');
    return event.notice_type || event.request_type || event.meta_event_type || event.message_type || event.post_type || 'event';
  }

  function eventTime(event) {
    const time = Number(event.time);
    return Number.isFinite(time) ? new Date(time * 1000).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
  }

  function eventType(event) {
    const known = ['message', 'message_sent', 'notice', 'request', 'meta_event'];
    const type = String(event.post_type || 'event');
    return el('span', `event-type${known.includes(type) ? ` ${type}` : ''}`, type);
  }

  function inspectEvent(event, shouldNavigate = false) {
    state.selected = event;
    $('event-json').textContent = JSON.stringify(event, null, 2);
    if (shouldNavigate) navigate('events');
    renderEvents();
  }

  function renderEvents() {
    if (state.paused) return;
    const recent = $('recent-events');
    recent.replaceChildren();
    for (const event of state.events.slice(0, 4)) {
      const row = el('button', 'recent-row');
      row.append(el('span', 'recent-time', eventTime(event)), eventType(event), el('span', 'event-preview', eventDescription(event)), el('span', 'recent-arrow', '↗'));
      row.addEventListener('click', () => inspectEvent(event, true));
      recent.append(row);
    }
    if (!state.events.length) recent.append(el('div', 'empty-inline', state.connected ? '等待运行时的新事件。' : '事件将在连接后显示。'));
    const filter = $('event-filter').value;
    const search = $('event-search').value.toLocaleLowerCase();
    const filtered = state.events.filter((event) => (!filter || event.post_type === filter) && (!search || JSON.stringify(event).toLocaleLowerCase().includes(search)));
    $('event-count').textContent = `${filtered.length} / ${state.events.length} 条事件`;
    const list = $('event-list');
    list.replaceChildren();
    if (!filtered.length) {
      const empty = el('div', 'empty-state');
      empty.append(el('span', '', '≋'), el('h3', '', state.events.length ? '没有匹配的事件' : '正在等待事件'), el('p', '', state.events.length ? '尝试其他搜索词或事件类型。' : '连接后，消息、通知与心跳将在这里出现。'));
      list.append(empty);
    }
    for (const event of filtered) {
      const row = el('button', `event-row${event === state.selected ? ' selected' : ''}`);
      const source = el('span');
      source.append(eventType(event), el('span', 'event-source', `self_id: ${event.self_id ?? '—'}`));
      row.append(el('span', 'recent-time', eventTime(event)), source, el('span', 'event-preview', eventDescription(event)));
      row.addEventListener('click', () => inspectEvent(event));
      list.append(row);
    }
  }

  function addEvent(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return;
    state.events.unshift(event);
    if (state.events.length > 300) state.events.length = 300;
    renderEvents();
  }

  async function subscribe(generation) {
    if (generation !== state.generation || !state.connected) return;
    state.stream?.abort();
    const controller = new AbortController();
    state.stream = controller;
    try {
      const response = await fetch('/events', { headers: { Authorization: `Bearer ${state.token}`, Accept: 'text/event-stream' }, signal: controller.signal, cache: 'no-store' });
      if (generation !== state.generation) return;
      if (response.status === 401) { stopConnection('访问令牌已失效，请重新登录。'); return; }
      if (!response.ok || !response.body) throw new Error(`事件流连接失败（HTTP ${response.status}）。`);
      connection('运行时已连接', 'connected');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (generation !== state.generation) return;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
          if (data) { try { addEvent(JSON.parse(data)); } catch { /* Ignore non-JSON SSE control frames. */ } }
        }
      }
      if (!controller.signal.aborted) throw new Error('事件流已断开。');
    } catch (error) {
      if (controller.signal.aborted || generation !== state.generation) return;
      connection('事件流重连中', 'error');
      state.reconnect = setTimeout(() => subscribe(generation), 3000);
    }
  }

  function stopConnection(message = '') {
    state.generation++;
    state.connected = false;
    state.session?.abort();
    state.session = null;
    state.stream?.abort();
    clearInterval(state.poll);
    clearTimeout(state.reconnect);
    invalidateQrLogin();
    state.token = '';
    state.accounts = [];
    state.actions = [];
    state.events = [];
    state.connections = [];
    state.revision = 0;
    state.connectionFilter = '';
    state.connectionsLoaded = false;
    pendingConnections.clear();
    connectionRequest++;
    state.editing = null;
    state.deleting = null;
    state.selected = null;
    state.paused = false;
    try { sessionStorage.removeItem(tokenKey); } catch { /* Private-mode storage may be unavailable. */ }
    $('auth-token').value = '';
    $('auth-token').type = 'password';
    $('toggle-token').textContent = '显示';
    $('toggle-token').setAttribute('aria-pressed', 'false');
    $('toggle-token').setAttribute('aria-label', '显示访问令牌');
    $('app-shell').hidden = true;
    $('app-shell').inert = true;
    $('auth-screen').hidden = false;
    $('auth-error').textContent = message;
    document.title = 'DyTranOb · 登录';
    closeMobileMenu();
    $('event-json').textContent = '选择一条事件查看详情。';
    $('action-result').textContent = '// 连接运行时后调用动作。';
    $('qr-content').replaceChildren();
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
    $('connection-form').reset();
    $('connection-token').value = '';
    $('connection-list').replaceChildren();
    $('nav-connection-count').textContent = '0';
    $('stat-connections').replaceChildren(document.createTextNode('—'), el('small', '', ' 个'));
    $('stat-connection-summary').textContent = '等待连接状态';
    $('connection-summary').textContent = '正在获取连接配置…';
    $('connection-revision').textContent = '';
    $('connections-error').textContent = '';
    connection('未连接');
    renderAccounts();
    $('action-select').replaceChildren(new Option('请先连接运行时', ''));
    $('stat-actions').replaceChildren(document.createTextNode('—'), el('small', '', ' 个'));
    $('stat-uptime').textContent = '—';
    $('stat-version').textContent = '等待运行时信息';
    $('action-description').textContent = '动作目录将在连接后加载。';
    $('action-schema').textContent = '{}';
    $('result-status').textContent = 'READY';
    $('result-status').className = 'small-badge';
    $('result-meta').textContent = '等待执行动作';
    $('action-params').value = '{}';
    $('event-search').value = '';
    $('event-filter').value = '';
    $('pause-events').textContent = '暂停显示';
    $('pause-events').setAttribute('aria-pressed', 'false');
    clearTimeout(toastTimer);
    $('toast').hidden = true;
    renderEvents();
    $('auth-token').focus();
  }

  async function connect(token, remember) {
    if (!token) throw new Error('请输入启动日志中的 WebUI Token。');
    state.generation++;
    const generation = state.generation;
    state.stream?.abort();
    state.session?.abort();
    state.session = new AbortController();
    clearInterval(state.poll);
    clearTimeout(state.reconnect);
    state.token = token;
    const auth = await api('/api/auth', { method: 'POST' });
    if (auth.data?.authenticated !== true) throw new Error('运行时未确认认证成功，请检查服务版本。');
    await refreshStatus();
    const [actions, events] = await Promise.all([api('/api/actions'), api('/api/events')]);
    if (generation !== state.generation) return;
    state.actions = Array.isArray(actions.data) ? actions.data : [];
    state.events = Array.isArray(events.data) ? events.data.slice(-300).reverse() : [];
    state.connected = true;
    try { if (remember) sessionStorage.setItem(tokenKey, token); else sessionStorage.removeItem(tokenKey); } catch { toast('浏览器无法保存凭据，本次仅在内存中使用。'); }
    $('auth-token').value = '';
    $('auth-token').type = 'password';
    $('toggle-token').textContent = '显示';
    $('toggle-token').setAttribute('aria-pressed', 'false');
    $('toggle-token').setAttribute('aria-label', '显示访问令牌');
    $('auth-screen').hidden = true;
    $('app-shell').inert = false;
    $('app-shell').hidden = false;
    renderActions();
    renderEvents();
    connection('运行时已连接', 'connected');
    navigate('overview');
    $('main').focus();
    loadConnections().catch(() => {});
    state.poll = setInterval(() => {
      if (!state.connected) return;
      refreshStatus().catch((error) => { if (state.connected && error.name !== 'AbortError') connection('状态刷新失败', 'error'); });
      loadConnections(false).catch(() => {});
    }, 15000);
    subscribe(generation);
  }

  function closeMobileMenu() {
    const hadFocus = $('sidebar').contains(document.activeElement);
    $('sidebar').classList.remove('mobile-open');
    $('sidebar').inert = mobileViewport.matches;
    $('mobile-menu').setAttribute('aria-expanded', 'false');
    if (mobileViewport.matches && hadFocus && state.connected) $('mobile-menu').focus();
  }

  const connectionTypes = {
    http: { name: 'HTTP 服务', icon: '{ }', color: 'blue', help: '监听 HTTP 请求，供机器人框架调用 OneBot 动作。动作路径为 /api/action。' },
    ws: { name: '正向 WebSocket', icon: '↔', color: 'violet', help: '监听 WebSocket 连接，同时接收动作并推送事件。通用路径为 /ws。' },
    http_post: { name: 'HTTP 上报', icon: '↗', color: 'teal', help: '主动向目标 HTTP(S) 地址推送 OneBot 事件。请填写接收端的完整地址。' },
    ws_reverse: { name: '反向 WebSocket', icon: '⇄', color: 'amber', help: '主动连接机器人框架的 WS(S) 服务，推送事件并接收动作。' },
  };
  const connectionStates = { running: '运行中', stopped: '已停用', connecting: '连接中', connected: '已连接', error: '运行异常' };
  let connectionRequest = 0;

  function connectionAddress(item) {
    if (item.type === 'http_post' || item.type === 'ws_reverse') return item.url || '尚未设置目标地址';
    if (item.actualPort === undefined && item.port === 0) return '启用后自动分配端口';
    const host = item.host || '127.0.0.1';
    const address = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    const port = item.actualPort ?? item.port ?? 0;
    return `${item.type === 'http' ? 'http' : 'ws'}://${address}:${port}${item.type === 'http' ? '/api/action' : '/ws'}`;
  }

  function renderConnections() {
    const list = $('connection-list');
    list.replaceChildren();
    const running = state.connections.filter((item) => item.status === 'running' || item.status === 'connected').length;
    $('connection-summary').textContent = `共 ${state.connections.length} 个连接 · ${running} 个正在运行`;
    $('connection-revision').textContent = `REV ${state.revision}`;
    $('nav-connection-count').textContent = String(state.connections.length);
    $('stat-connections').replaceChildren(document.createTextNode(String(state.connections.length)), el('small', '', ' 个'));
    $('stat-connection-summary').textContent = `${running} 个运行中 · ${state.connections.filter((item) => item.enabled).length} 个已启用`;
    for (const node of document.querySelectorAll('[data-type-count]')) node.textContent = String(state.connections.filter((item) => !node.dataset.typeCount || item.type === node.dataset.typeCount).length);
    for (const button of document.querySelectorAll('[data-filter-type]')) {
      const active = button.dataset.filterType === state.connectionFilter;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    }
    const items = state.connections.filter((item) => !state.connectionFilter || item.type === state.connectionFilter);
    if (!items.length) {
      const empty = el('div', 'empty-state');
      empty.append(el('span', '', '⌁'), el('h3', '', state.connections.length ? '此类型下还没有连接' : '添加你的第一个连接'), el('p', '', '选择 HTTP 或 WebSocket 接入方式，填写地址与端口后即可使用。'));
      const button = el('button', 'button secondary', '＋ 新增连接');
      button.addEventListener('click', () => openConnection());
      empty.append(button); list.append(empty);
    }
    for (const item of items) {
      const type = connectionTypes[item.type] || connectionTypes.http;
      const card = el('article', 'network-card');
      card.dataset.connectionId = item.id;
      card.dataset.testid = 'connection-card';
      const heading = el('div', 'network-card-head');
      const title = el('div'); title.append(el('h3', '', item.name), el('small', '', type.name));
      const toggle = el('button', 'switch');
      toggle.type = 'button'; toggle.setAttribute('role', 'switch'); toggle.setAttribute('aria-checked', String(item.enabled));
      toggle.disabled = pendingConnections.has(item.id);
      toggle.setAttribute('aria-label', `${item.enabled ? '停用' : '启用'} ${item.name}`); toggle.dataset.testid = 'connection-toggle';
      toggle.addEventListener('click', () => toggleConnection(item, toggle));
      heading.append(el('span', `transport-icon ${type.color}`, type.icon), title, toggle);
      const body = el('div', 'network-card-body');
      const address = el('code', 'network-address', connectionAddress(item)); address.title = address.textContent;
      const meta = el('div', 'network-meta');
      const status = Object.hasOwn(connectionStates, item.status) ? item.status : 'stopped';
      meta.append(el('span', `network-state ${status}`, connectionStates[status]), el('span', '', item.tokenConfigured ? '独立 Token' : '不启用 OneBot 鉴权'));
      body.append(address, meta);
      if (item.error) body.append(el('p', 'network-error', item.error));
      const footer = el('div', 'network-card-footer'); const actions = el('div', 'network-card-actions');
      const edit = el('button', 'text-button', '编辑'); edit.dataset.testid = 'edit-connection'; edit.setAttribute('aria-label', `编辑 ${item.name}`); edit.addEventListener('click', () => openConnection(item));
      const remove = el('button', 'text-button delete', '删除'); remove.dataset.testid = 'delete-connection'; remove.setAttribute('aria-label', `删除 ${item.name}`); remove.addEventListener('click', () => openDelete(item));
      edit.disabled = remove.disabled = pendingConnections.has(item.id);
      actions.append(edit, remove); footer.append(el('code', '', item.id), actions); card.append(heading, body, footer); list.append(card);
    }
  }

  async function loadConnections(showLoading = true) {
    if (!state.connected) return;
    const request = ++connectionRequest;
    if (showLoading) { $('refresh-connections').disabled = true; $('connection-list').setAttribute('aria-busy', 'true'); }
    if (!state.connectionsLoaded && showLoading) $('connection-list').replaceChildren(el('div', 'empty-state', '正在加载连接配置…'));
    try {
      const { data } = await api('/api/connections');
      if (request !== connectionRequest || !state.connected) return;
      if (!Array.isArray(data?.connections)) throw new Error('运行时返回的连接配置无效。');
      state.connections = data.connections;
      state.revision = data.revision;
      state.connectionsLoaded = true;
      $('connections-error').textContent = '';
      renderConnections();
    } catch (error) {
      if (request !== connectionRequest || !state.connected || error.name === 'AbortError') return;
      $('connections-error').textContent = `读取连接配置失败：${error.message}`;
      if (!state.connectionsLoaded) {
        $('connection-summary').textContent = '无法获取连接配置';
        $('connection-list').replaceChildren(el('div', 'empty-state', '连接配置未加载，请检查运行时状态并点击刷新。'));
      }
      throw error;
    } finally {
      if (request === connectionRequest) { $('refresh-connections').disabled = false; $('connection-list').removeAttribute('aria-busy'); }
    }
  }

  function updateConnectionFields() {
    const type = $('connection-type').value;
    const inbound = type === 'http' || type === 'ws';
    $('listen-fields').hidden = !inbound;
    $('outbound-fields').hidden = inbound;
    $('connection-host').disabled = !inbound;
    $('connection-port').disabled = !inbound;
    $('connection-url').disabled = inbound;
    $('allow-remote-field').hidden = !inbound;
    $('remote-help').hidden = !inbound;
    $('connection-type-help').textContent = connectionTypes[type].help;
    $('connection-url').placeholder = type === 'ws_reverse' ? 'ws://127.0.0.1:6700/onebot/v11/ws' : 'http://127.0.0.1:5700/onebot/v11/http';
  }

  function openConnection(item = null) {
    if (!state.connected || state.connectionBusy) return;
    state.editing = item;
    $('connection-form').reset();
    $('connection-title').textContent = item ? '编辑连接' : '新增连接';
    $('connection-type').value = item?.type || state.connectionFilter || 'http';
    $('connection-name').value = item?.name || '';
    $('connection-host').value = item?.host || '127.0.0.1';
    $('connection-port').value = String(item?.port ?? 5089);
    $('connection-url').value = item?.url || '';
    $('connection-heartbeat').value = String(item?.heartbeatInterval ?? 15000);
    $('connection-enabled').checked = item?.enabled ?? true;
    $('connection-allow-remote').checked = item?.allowRemote ?? false;
    $('connection-token').value = '';
    $('connection-token').disabled = false;
    $('connection-token').placeholder = item ? '留空保持当前 Token 设置' : '留空表示不启用 OneBot 鉴权';
    $('connection-token-help').textContent = item ? `${item.tokenConfigured ? '当前使用独立 Token' : '当前未启用 OneBot 鉴权'}，留空保持不变。` : '仅用于此 OneBot 连接，与 WebUI Token 独立；留空不鉴权。';
    $('clear-token-field').hidden = !item?.tokenConfigured;
    $('connection-clear-token').checked = false;
    $('connection-form-error').textContent = '';
    $('save-connection').disabled = false;
    updateConnectionFields();
    $('connection-dialog').showModal();
    $('connection-name').focus();
  }

  function connectionPayload() {
    const type = $('connection-type').value;
    const body = { name: $('connection-name').value.trim(), type, enabled: $('connection-enabled').checked, heartbeatInterval: Number($('connection-heartbeat').value) };
    if (!body.name) throw new Error('请填写连接名称。');
    if (type === 'http' || type === 'ws') {
      body.host = $('connection-host').value.trim();
      body.port = Number($('connection-port').value);
      body.allowRemote = $('connection-allow-remote').checked;
      if (!body.host) throw new Error('请填写监听地址。');
    } else {
      body.url = $('connection-url').value.trim();
      let url;
      try { url = new URL(body.url); } catch { throw new Error('请填写有效的完整目标地址。'); }
      const protocols = type === 'http_post' ? ['http:', 'https:'] : ['ws:', 'wss:'];
      if (!protocols.includes(url.protocol)) throw new Error(`目标地址必须使用 ${protocols.join(' 或 ')} 协议。`);
      if (url.hash) throw new Error('目标地址不能包含 # 片段。');
      if (url.username || url.password || [...url.searchParams.keys()].some((key) => /^(token|access_token|authorization|password|secret)$/i.test(key))) throw new Error('请在连接 Token 字段中填写认证信息，目标地址不能包含密码或 Token。');
    }
    if (state.editing && $('connection-clear-token').checked) body.token = '';
    else if ($('connection-token').value) body.token = $('connection-token').value;
    if (body.token && !/^[\x21-\x7e]{1,4096}$/.test(body.token)) throw new Error('连接 Token 只能包含不含空格的可见 ASCII 字符，最多 4096 个字符。');
    return body;
  }

  async function saveConnection(event) {
    event.preventDefault();
    if ($('save-connection').disabled || !state.connected) return;
    let body;
    try { body = connectionPayload(); } catch (error) { $('connection-form-error').textContent = error.message; return; }
    const editing = state.editing;
    const generation = state.generation;
    setConnectionBusy(true);
    $('save-connection').textContent = '正在保存…';
    $('connection-form').setAttribute('aria-busy', 'true');
    $('connection-form-error').textContent = '';
    try {
      const { data } = await api(editing ? `/api/connections/${encodeURIComponent(editing.id)}` : '/api/connections', { method: editing ? 'PUT' : 'POST', body: JSON.stringify(body) });
      if (generation !== state.generation || !state.connected) return;
      const index = state.connections.findIndex((item) => item.id === data.id);
      if (index < 0) state.connections.push(data); else state.connections[index] = data;
      state.connectionsLoaded = true;
      state.connectionFilter = '';
      renderConnections();
      $('connection-dialog').close();
      toast(data.status === 'error' ? '配置已保存，连接运行异常。请查看卡片中的错误信息。' : '连接配置已保存并应用。', data.status === 'error');
      loadConnections(false).catch(() => {});
    } catch (error) {
      if (generation === state.generation && state.connected && error.name !== 'AbortError') $('connection-form-error').textContent = `保存失败：${error.message}`;
    } finally {
      setConnectionBusy(false);
      $('save-connection').textContent = '保存并应用';
      $('connection-form').removeAttribute('aria-busy');
    }
  }

  function setConnectionBusy(busy) {
    state.connectionBusy = busy;
    for (const control of $('connection-form').querySelectorAll('input, select, button')) control.disabled = busy;
    if (!busy) {
      updateConnectionFields();
      $('connection-token').disabled = $('connection-clear-token').checked;
    }
  }

  async function toggleConnection(item, button) {
    if (pendingConnections.has(item.id) || !state.connected) return;
    pendingConnections.add(item.id);
    button.disabled = true;
    const generation = state.generation;
    try {
      const { data } = await api(`/api/connections/${encodeURIComponent(item.id)}`, { method: 'PUT', body: JSON.stringify({ enabled: !item.enabled }) });
      if (generation !== state.generation || !state.connected) return;
      state.connections = state.connections.map((value) => value.id === item.id ? data : value);
      renderConnections();
      toast(data.enabled ? '连接已启用。' : '连接已停用。');
      loadConnections(false).catch(() => {});
    } catch (error) { if (generation === state.generation && state.connected && error.name !== 'AbortError') { $('connections-error').textContent = `更新连接失败：${error.message}`; toast(error.message, true); } }
    finally { pendingConnections.delete(item.id); button.disabled = false; if (generation === state.generation && state.connected) renderConnections(); }
  }

  function openDelete(item) {
    if (state.deleteBusy || !state.connected) return;
    state.deleting = item;
    $('delete-description').textContent = `确定删除“${item.name}”吗？此连接将立即停止，并从已保存的配置中移除。`;
    $('delete-error').textContent = '';
    $('delete-dialog').showModal();
    $('cancel-delete').focus();
  }

  async function deleteConnection(event) {
    event.preventDefault();
    if ($('confirm-delete').disabled || !state.connected) return;
    const item = state.deleting;
    if (!item) return;
    const generation = state.generation;
    state.deleteBusy = true;
    for (const control of $('delete-form').querySelectorAll('button')) control.disabled = true;
    $('delete-error').textContent = '';
    try {
      await api(`/api/connections/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      if (generation !== state.generation || !state.connected) return;
      state.connections = state.connections.filter((value) => value.id !== item.id);
      renderConnections();
      $('delete-dialog').close();
      toast('连接已删除。');
      loadConnections(false).catch(() => {});
    } catch (error) { if (generation === state.generation && state.connected && error.name !== 'AbortError') $('delete-error').textContent = `删除失败：${error.message}`; }
    finally { state.deleteBusy = false; for (const control of $('delete-form').querySelectorAll('button')) control.disabled = false; }
  }

  function openAccount() {
    if (!state.connected || state.accountBusy) return;
    $('account-form').reset();
    $('account-form-error').textContent = '';
    $('account-dialog').showModal();
    $('account-id').focus();
  }

  function setAccountBusy(busy, form) {
    state.accountBusy = busy;
    for (const control of $(form).querySelectorAll('input, select, button')) control.disabled = busy;
  }

  async function saveAccount(event) {
    event.preventDefault();
    if (state.accountBusy || !state.connected) return;
    const id = $('account-id').value.trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) { $('account-form-error').textContent = '账号 ID 只能包含字母、数字、_ 或 -，最多 64 个字符。'; return; }
    if (state.accounts.some((account) => String(account.id) === id)) { $('account-form-error').textContent = '该账号 ID 已存在。'; return; }
    const type = $('account-type').value;
    const generation = state.generation;
    setAccountBusy(true, 'account-form');
    $('save-account').textContent = '正在添加…';
    $('account-form-error').textContent = '';
    try {
      await api('/api/accounts', { method: 'POST', body: JSON.stringify({ id, type }) });
      if (generation !== state.generation || !state.connected) return;
      $('account-dialog').close();
      await refreshStatus().catch(() => {});
      toast(`账号 ${id} 已添加。`);
      // A new Douyin account has no session yet; go straight to QR login.
      if (type === 'douyin') startQrLogin(id, false);
    } catch (error) {
      if (generation === state.generation && state.connected && error.name !== 'AbortError') $('account-form-error').textContent = `添加失败：${error.message}`;
    } finally {
      setAccountBusy(false, 'account-form');
      $('save-account').textContent = '添加账号';
    }
  }

  function openRemoveAccount(id) {
    if (!state.connected || state.accountBusy) return;
    state.removingAccount = id;
    $('remove-account-description').textContent = `确定移除账号“${id}”吗？该账号会立即下线并从账号列表中移除；本地登录会话数据会保留，之后用相同 ID 重新添加即可恢复。`;
    $('remove-account-error').textContent = '';
    $('remove-account-dialog').showModal();
    $('cancel-remove-account').focus();
  }

  async function removeAccount(event) {
    event.preventDefault();
    const id = state.removingAccount;
    if (!id || state.accountBusy || !state.connected) return;
    const generation = state.generation;
    setAccountBusy(true, 'remove-account-form');
    $('remove-account-error').textContent = '';
    try {
      await api(`/api/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (generation !== state.generation || !state.connected) return;
      $('remove-account-dialog').close();
      await refreshStatus().catch(() => {});
      toast(`账号 ${id} 已移除。`);
    } catch (error) {
      if (generation === state.generation && state.connected && error.name !== 'AbortError') $('remove-account-error').textContent = `移除失败：${error.message}`;
    } finally {
      setAccountBusy(false, 'remove-account-form');
    }
  }

  function showLogin(data) {
    const status = data || {};
    $('qr-content').replaceChildren();
    if (status.online || status.state === 'online') {
      $('qr-content').append(el('span', '', '✓'), el('strong', '', '账号已在线'));
      $('qr-status').textContent = '登录成功，会话已保存。';
      clearInterval(state.qrPoll);
      refreshStatus().catch(() => {});
      return;
    }
    const raw = status.qrcodeBase64;
    const image = typeof raw === 'string' ? (raw.startsWith('data:image/') ? raw : `data:image/png;base64,${raw}`) : null;
    if (image && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\s]+$/.test(image)) {
      const img = el('img'); img.src = image; img.alt = '抖音登录二维码';
      $('qr-content').append(img);
    } else if (status.qrcodeUrl) {
      try {
        const url = new URL(status.qrcodeUrl);
        if (url.protocol === 'https:') {
          const link = el('a', '', '打开抖音登录二维码');
          link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
          $('qr-content').append(link, el('p', '', '请在新窗口中查看二维码，并使用抖音 App 扫码。'));
        }
      } catch { /* Only verified absolute HTTPS links are shown. */ }
    }
    if (status.verification?.url) {
      try {
        const url = new URL(status.verification.url);
        if (['http:', 'https:'].includes(url.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
          const link = el('a', '', '打开本机登录验证页面');
          link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer';
          $('qr-content').append(link);
        }
      } catch { /* Verification remains a manual action. */ }
    }
    if (!$('qr-content').childNodes.length) $('qr-content').append(el('p', '', status.error || '暂未获得二维码，请关闭后重新获取。'));
    const labels = { waiting: '等待扫码…', pending: '等待扫码…', scanned: '已扫码，请在抖音 App 中确认。', confirmed: '已确认，正在完成登录…', expired: '二维码已过期，请关闭后重新获取。', verification: '需要完成登录验证。', error: '登录遇到问题。', offline: '账号尚未登录。', 'logging-in': '等待扫码或 App 确认…', reconnecting: '账号正在重新连接…' };
    $('qr-status').textContent = status.error || (status.verification ? '需要完成登录验证。' : labels[status.qrStatus] || labels[status.state]) || `登录状态：${status.qrStatus || status.state || '等待扫码'}`;
    if (['expired', 'error'].includes(status.state) || ['expired', 'error'].includes(status.qrStatus)) clearInterval(state.qrPoll);
  }

  function invalidateQrLogin() {
    state.qrRequest++;
    clearInterval(state.qrPoll);
    state.qrPoll = null;
  }

  async function startQrLogin(id, online = false) {
    if (!state.connected) return;
    const generation = state.generation;
    invalidateQrLogin();
    const qrRequest = state.qrRequest;
    const isCurrent = () => generation === state.generation && qrRequest === state.qrRequest && state.connected && $('qr-dialog').open;
    $('qr-account').textContent = `账号 ${id} · 使用抖音 App 扫码并确认。`;
    $('qr-content').replaceChildren(el('p', '', '正在获取登录信息…'));
    $('qr-status').textContent = '正在连接原生会话…';
    if (!$('qr-dialog').open) $('qr-dialog').showModal();
    try {
      const path = `/api/accounts/${encodeURIComponent(id)}/login`;
      const result = await api(online ? path : `${path}/qr`, online ? {} : { method: 'POST', body: '{}' });
      if (!isCurrent()) return;
      showLogin(result.data);
      if (!result.data?.online && !['online', 'expired', 'error'].includes(result.data?.state) && !['expired', 'error'].includes(result.data?.qrStatus)) {
        let polling = false;
        state.qrPoll = setInterval(async () => {
          if (!isCurrent() || polling) return;
          polling = true;
          try { const next = await api(path); if (isCurrent()) showLogin(next.data); }
          catch (error) { if (isCurrent()) $('qr-status').textContent = error.message; }
          finally { polling = false; }
        }, 3000);
      }
    } catch (error) { if (isCurrent()) { $('qr-content').replaceChildren(el('p', '', error.message)); $('qr-status').textContent = '获取登录信息失败。'; } }
  }

  for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => navigate(button.dataset.view));
  $('hero-debug').addEventListener('click', () => navigate('actions'));
  $('hero-connections').addEventListener('click', () => navigate('connections'));
  $('show-events').addEventListener('click', () => navigate('events'));
  $('mobile-menu').addEventListener('click', () => { const open = $('sidebar').classList.toggle('mobile-open'); $('sidebar').inert = !open && mobileViewport.matches; $('mobile-menu').setAttribute('aria-expanded', String(open)); });
  mobileViewport.addEventListener('change', closeMobileMenu);
  document.addEventListener('click', (event) => { if (!$('sidebar').contains(event.target) && !$('mobile-menu').contains(event.target)) closeMobileMenu(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMobileMenu(); });
  $('logout').addEventListener('click', () => stopConnection());
  $('toggle-token').addEventListener('click', () => {
    const show = $('auth-token').type === 'password';
    $('auth-token').type = show ? 'text' : 'password';
    $('toggle-token').textContent = show ? '隐藏' : '显示';
    $('toggle-token').setAttribute('aria-label', show ? '隐藏访问令牌' : '显示访问令牌');
    $('toggle-token').setAttribute('aria-pressed', String(show));
  });
  $('close-qr').addEventListener('click', () => { invalidateQrLogin(); $('qr-dialog').close(); $('qr-content').replaceChildren(); });
  $('qr-dialog').addEventListener('cancel', invalidateQrLogin);
  $('qr-dialog').addEventListener('close', () => {
    // A close event may be queued before a new account reopens the dialog.
    if ($('qr-dialog').open) return;
    invalidateQrLogin();
    $('qr-content').replaceChildren();
  });

  async function login(token, remember) {
    if ($('connect-button').disabled) return;
    $('connect-button').disabled = true;
    $('connect-button').textContent = '正在验证令牌…';
    $('auth-token').disabled = true;
    $('toggle-token').disabled = true;
    $('remember-token').disabled = true;
    $('auth-form').setAttribute('aria-busy', 'true');
    $('auth-error').textContent = '';
    try { await connect(token, remember); }
    catch (error) {
      if (error.name !== 'AbortError') stopConnection(error.status === 401 ? error.message : `登录失败：${error.message}`);
    } finally {
      $('connect-button').disabled = false;
      $('connect-button').replaceChildren(document.createTextNode('进入工作空间 '), el('span', '', '→'));
      $('auth-token').disabled = false;
      $('toggle-token').disabled = false;
      $('remember-token').disabled = false;
      $('auth-form').removeAttribute('aria-busy');
      if (!state.connected) $('auth-token').focus();
    }
  }
  $('auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    await login($('auth-token').value.trim(), $('remember-token').checked);
  });
  $('refresh-status').addEventListener('click', async () => {
    if (!state.connected) return;
    $('refresh-status').disabled = true;
    try { await refreshStatus(); toast('状态已更新。'); } catch (error) { if (state.connected && error.name !== 'AbortError') toast(error.message, true); }
    finally { $('refresh-status').disabled = false; }
  });
  $('action-select').addEventListener('change', selectAction);
  $('format-params').addEventListener('click', () => { try { $('action-params').value = JSON.stringify(JSON.parse($('action-params').value), null, 2); } catch { toast('参数 JSON 格式无效。', true); } });
  $('action-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.connected) return;
    const generation = state.generation;
    let params;
    try { params = JSON.parse($('action-params').value); if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error(); }
    catch { toast('参数必须是有效的 JSON 对象。', true); return; }
    $('run-action').disabled = true;
    $('result-status').textContent = 'RUNNING';
    $('result-status').className = 'small-badge';
    const started = performance.now();
    try {
      const body = { action: $('action-select').value, params, echo: `webui-${Date.now()}` };
      if ($('action-account').value) body.account_id = $('action-account').value;
      const result = await api('/api/action', { method: 'POST', body: JSON.stringify(body) });
      if (generation !== state.generation) return;
      $('action-result').textContent = JSON.stringify(result, null, 2);
      $('result-status').textContent = 'OK';
      $('result-status').className = 'small-badge ok';
    } catch (error) {
      if (generation !== state.generation || !state.connected || error.name === 'AbortError') return;
      $('action-result').textContent = JSON.stringify(error.payload || { status: 'failed', message: error.message }, null, 2);
      $('result-status').textContent = 'FAILED';
      $('result-status').className = 'small-badge failed';
    } finally {
      if (generation === state.generation) $('result-meta').textContent = `${$('action-select').value} · ${Math.round(performance.now() - started)} ms`;
      $('run-action').disabled = false;
    }
  });
  $('event-search').addEventListener('input', renderEvents);
  $('event-filter').addEventListener('change', renderEvents);
  $('pause-events').title = '暂停界面刷新；事件仍保留最近 300 条';
  $('pause-events').addEventListener('click', () => { state.paused = !state.paused; $('pause-events').textContent = state.paused ? '继续显示' : '暂停显示'; $('pause-events').setAttribute('aria-pressed', String(state.paused)); renderEvents(); });
  $('clear-events').addEventListener('click', () => { state.events = []; state.selected = null; $('event-json').textContent = '选择一条事件查看详情。'; const paused = state.paused; state.paused = false; renderEvents(); state.paused = paused; toast('已清空本地事件视图。'); });
  async function copy(id) { try { await navigator.clipboard.writeText($(id).textContent); toast('已复制到剪贴板。'); } catch { toast('浏览器无法访问剪贴板，请选中文本复制。', true); } }
  $('copy-event').addEventListener('click', () => copy('event-json'));
  $('copy-result').addEventListener('click', () => copy('action-result'));
  $('http-endpoint').value = `${location.origin}/action`;
  $('ws-endpoint').value = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
  $('login-origin').textContent = location.host;
  for (const button of document.querySelectorAll('[data-copy-input]')) button.addEventListener('click', async () => { try { await navigator.clipboard.writeText($(button.dataset.copyInput).value); toast('已复制到剪贴板。'); } catch { toast('请选中地址手动复制。', true); } });

  $('add-account').addEventListener('click', openAccount);
  $('account-form').addEventListener('submit', saveAccount);
  $('account-dialog').addEventListener('cancel', (event) => { if (state.accountBusy) event.preventDefault(); });
  for (const id of ['close-account', 'cancel-account']) $(id).addEventListener('click', () => { if (!state.accountBusy) $('account-dialog').close(); });
  $('remove-account-form').addEventListener('submit', removeAccount);
  $('remove-account-dialog').addEventListener('cancel', (event) => { if (state.accountBusy) event.preventDefault(); });
  for (const id of ['close-remove-account', 'cancel-remove-account']) $(id).addEventListener('click', () => { if (!state.accountBusy) $('remove-account-dialog').close(); });
  $('remove-account-dialog').addEventListener('close', () => { state.removingAccount = null; });
  $('add-connection').addEventListener('click', () => openConnection());
  $('refresh-connections').addEventListener('click', () => loadConnections().catch(() => {}));
  for (const button of document.querySelectorAll('[data-filter-type]')) button.addEventListener('click', () => { state.connectionFilter = button.dataset.filterType; renderConnections(); });
  $('connection-type').addEventListener('change', updateConnectionFields);
  $('connection-heartbeat').max = '3600000';
  $('connection-clear-token').addEventListener('change', () => { $('connection-token').disabled = $('connection-clear-token').checked; if ($('connection-clear-token').checked) $('connection-token').value = ''; });
  $('connection-form').addEventListener('submit', saveConnection);
  $('connection-dialog').addEventListener('cancel', (event) => { if (state.connectionBusy) event.preventDefault(); });
  for (const id of ['close-connection', 'cancel-connection']) $(id).addEventListener('click', () => $('connection-dialog').close());
  $('connection-dialog').addEventListener('close', () => { state.editing = null; $('connection-token').value = ''; });
  $('delete-form').addEventListener('submit', deleteConnection);
  $('delete-dialog').addEventListener('cancel', (event) => { if (state.deleteBusy) event.preventDefault(); });
  for (const id of ['close-delete', 'cancel-delete']) $(id).addEventListener('click', () => $('delete-dialog').close());
  $('delete-dialog').addEventListener('close', () => { state.deleting = null; });

  let remembered;
  try { remembered = sessionStorage.getItem(tokenKey); } catch { /* Memory-only credentials remain available. */ }
  if (remembered) { $('remember-token').checked = true; login(remembered, true); }
})();
