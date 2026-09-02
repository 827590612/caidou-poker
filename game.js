(function () {
  'use strict';

  /*
   * 联机客户端：只负责「渲染服务器状态 + 发送自己的动作」。
   * 所有游戏逻辑（发牌 / 扔豆 / 比大小）都在服务器，客户端不持有任何牌面真相。
   * 服务器只把「你自己」的暗牌下发给你，因此「看牌仅自己可看」天然成立。
   * 身份：账号（手机号+密码）用于登录；座位由 seatToken 标识，重进房间会回收原座位。
   */

  const MAX_SEATS = 4;
  const RAISE_AMOUNT = 10;

  const els = {
    authSection: document.getElementById('auth-section'),
    tabLogin: document.getElementById('tab-login'),
    tabRegister: document.getElementById('tab-register'),
    inputPhone: document.getElementById('input-phone'),
    inputPassword: document.getElementById('input-password'),
    inputNick: document.getElementById('input-nick'),
    rowNickname: document.getElementById('row-nickname'),
    btnAuth: document.getElementById('btn-auth'),
    authHint: document.getElementById('auth-hint'),

    joinSection: document.getElementById('join-section'),
    myCode: document.getElementById('my-code'),
    myNick: document.getElementById('my-nick'),
    inputRoom: document.getElementById('input-room'),
    btnEnter: document.getElementById('btn-enter'),
    btnLogout: document.getElementById('btn-logout'),

    roomPanel: document.getElementById('room-panel'),
    roomCode: document.getElementById('room-code'),
    inviteLink: document.getElementById('invite-link'),
    inviteHint: document.getElementById('invite-hint'),
    btnCopy: document.getElementById('btn-copy'),
    lobbyMsg: document.getElementById('lobby-msg'),
    btnStart: document.getElementById('btn-start'),
    btnReadyLobby: document.getElementById('btn-ready-lobby'),
    btnLeave: document.getElementById('btn-leave'),
    botActions: document.getElementById('bot-actions'),
    botHint: document.getElementById('bot-hint'),
    btnAddBot: document.getElementById('btn-add-bot'),
    btnFillBot: document.getElementById('btn-fill-bot'),
    btnRemoveBot: document.getElementById('btn-remove-bot'),

    table: document.getElementById('table'),
    topBar: document.getElementById('top-bar'),
    controls: document.getElementById('controls'),
    messageArea: document.getElementById('message-area'),
    message: document.getElementById('message'),
    pot: document.getElementById('pot'),
    currentBet: document.getElementById('current-bet'),
    round: document.getElementById('round'),
    topRoom: document.getElementById('top-room'),
    conn: document.getElementById('conn'),
    connBadge: document.getElementById('conn-badge'),
    rulesFloat: document.getElementById('btn-rules-float'),
    rotateHint: document.getElementById('rotate-hint'),
    rotateHintBtn: document.getElementById('btn-rotate-ok'),
    wild: document.getElementById('wild'),
    roundSummary: document.getElementById('round-summary'),

    btnNew: document.getElementById('btn-new'),
    btnReady: document.getElementById('btn-ready'),
    btnCall: document.getElementById('btn-call'),
    btnRaise: document.getElementById('btn-raise'),
    btnLook: document.getElementById('btn-look'),
    btnFold: document.getElementById('btn-fold'),

    btnSpectate: document.getElementById('btn-spectate'),
    btnExitSpectate: document.getElementById('btn-exit-spectate'),
    spectateBanner: document.getElementById('spectate-banner'),
    spectateRoom: document.getElementById('spectate-room'),

    players: [
      document.getElementById('player-0'),
      document.getElementById('player-1'),
      document.getElementById('player-2'),
      document.getElementById('player-3')
    ]
  };

  let account = null;   // { token, phone, code, nickname }
  let roomSession = null; // { room, seat, seatToken }
  let view = null;
  let sse = null;
  let pendingRaise = 0;
  let lastTurnKey = '';
  let authMode = 'login';
  let spectating = false;   // 是否为观战模式（不占座位、不可操作）
  let topBarVisible = true;  // 顶栏当前是否可见；对局中隐藏顶栏时，连接状态改由右上角徽标显示

  // —— SSE 连接健康守护（针对 iOS Safari 长连接易静默断连/不重连）——
  let reconnecting = false;       // 正在重连 SSE，避免重复建连
  let reconnectTimer = null;      // 退避重连定时器
  let reconnectAttempts = 0;      // 重连尝试次数（用于退避）
  let lastSseMsgTs = 0;           // 最近一次收到 SSE 消息的时间戳
  let sseKeepAlive = null;        // 静默断连检测 + 轮询兜底定时器
  let sseReconnectFn = null;      // 当前连接的正确重连函数（玩家 or 观战）
  let rotateDismissed = false;    // 用户已点“竖屏也行”，本次会话内不再弹“请横屏”浮层
  let autoRefreshTimer = null;    // 每 500ms 轻量刷新（仅拉状态 + 重渲染，不整页重载）

  // ---------- 存储 ----------
  function loadAccount() {
    try {
      const raw = localStorage.getItem('poker-account');
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function saveAccount(a) {
    account = a;
    try { localStorage.setItem('poker-account', JSON.stringify(a)); } catch (e) {}
  }
  function clearAccount() {
    account = null;
    try { localStorage.removeItem('poker-account'); } catch (e) {}
  }
  function loadRoomSession() {
    try {
      const raw = sessionStorage.getItem('poker-room');
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function saveRoomSession(s) {
    roomSession = s;
    try { sessionStorage.setItem('poker-room', JSON.stringify(s)); } catch (e) {}
  }
  function clearRoomSession() {
    stopSseKeepAlive();
    stopReconnect();
    roomSession = null;
    try { sessionStorage.removeItem('poker-room'); } catch (e) {}
  }

  // ---------- 网络 ----------
  async function api(path, body) {
    const opts = body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { method: 'GET' };
    const res = await fetch(path, opts);
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) throw new Error((data && data.error) || ('请求失败 ' + res.status));
    return data;
  }

  async function sendAction(action) {
    if (!roomSession) return;
    try {
      await api('/api/action', {
        room: roomSession.room,
        seat: roomSession.seat,
        seatToken: roomSession.seatToken,
        action
      });
      showMessage('操作成功：' + (action.type === 'addBot' ? '已添加 1 个人机' : action.type === 'fillBot' ? '已补满人机' : action.type === 'removeBot' ? '已移除人机' : '等待同步…'));
    } catch (e) {
      alert('操作失败：' + e.message);
      showMessage('操作失败：' + e.message);
    } finally {
      // 动作成功后立即主动拉一次状态，作为 SSE 推送的后备，确保界面一定刷新
      refreshState();
    }
  }

  async function refreshState() {
    if (!roomSession) return;
    try {
      const v = await api(`/api/state?room=${roomSession.room}&seat=${roomSession.seat}`);
      view = v;
      render();
    } catch (e) {
      // state 拉取失败通常意味着座位已失效，交给 SSE 断线处理
    }
  }

  // 每 500ms 轻量刷新一次页面数据：仅重新拉取状态并重渲染，
  // 不做整页 location.reload()（整页重载会打断 SSE 长连接、丢失交互状态、引发闪烁与服务器压力）。
  function startAutoRefresh() {
    if (autoRefreshTimer) return;
    autoRefreshTimer = setInterval(() => {
      if (spectating) { refreshSpectateState(); }
      else if (roomSession) { refreshState(); }
    }, 500);
  }

  async function refreshSpectateState() {
    if (!spectating || !view || !view.room) return;
    try {
      const v = await api(`/api/state?room=${encodeURIComponent(view.room)}&spectate=1`);
      view = v;
      render();
    } catch (e) { /* 观战轮询失败静默，依赖 SSE 兜底 */ }
  }

  // SSE 健康守护：检测静默断连、定时兜底轮询，确保 iOS 上机器人回合也能刷新
  function startSseKeepAlive() {
    stopSseKeepAlive();
    sseKeepAlive = setInterval(() => {
      if (!roomSession && !spectating) { stopSseKeepAlive(); return; }
      const now = Date.now();
      // 1) 连接已彻底关闭（CLOSED）：触发重连；CONNECTING 状态交给浏览器自身处理，避免打断在途连接
      if (!sse || sse.readyState === EventSource.CLOSED) {
        doReconnect();
        return;
      }
      // 2) 连接还“开着”但很久没收到消息（iOS 静默挂起）：强制重连
      if (now - lastSseMsgTs > 12000) {
        reconnecting = true; try { sse.close(); } catch (e) {} if (sseReconnectFn) sseReconnectFn();
        return;
      }
      // 3) 5 秒以上无消息：用轮询兜底刷新（不重建连接），保证机器人回合可见
      if (now - lastSseMsgTs > 5000) {
        refreshState();
      }
    }, 4000);
  }
  function stopSseKeepAlive() {
    if (sseKeepAlive) { clearInterval(sseKeepAlive); sseKeepAlive = null; }
  }

  function openStream() {
    closeSse();
    const url = `/api/stream?room=${encodeURIComponent(roomSession.room)}&seat=${roomSession.seat}&seatToken=${encodeURIComponent(roomSession.seatToken)}`;
    sse = new EventSource(url);
    sseReconnectFn = openStream;
    sse.onopen = () => { reconnecting = false; reconnectAttempts = 0; lastSseMsgTs = Date.now(); setConn('已连接', true); };
    sse.onmessage = (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      lastSseMsgTs = Date.now();
      if (data.kicked) {
        leaveRoomUI(data.reason === 'other'
          ? '你的账号已在其他位置进入本房间，此页面已退出。'
          : '你已被移出房间。');
        return;
      }
      view = data;
      render();
    };
    sse.onerror = () => { doReconnect(); };
    startSseKeepAlive();
  }

  function setConn(text, ok) {
    if (els.conn) {
      els.conn.textContent = text;
      els.conn.classList.toggle('ok', !!ok);
      els.conn.classList.toggle('bad', !ok);
    }
    // 顶栏隐藏（对局中）时，连接状态同步到右上角固定徽标；顶栏可见时不显示徽标，避免重复
    if (els.connBadge) {
      els.connBadge.textContent = text;
      els.connBadge.classList.toggle('ok', !!ok);
      els.connBadge.classList.toggle('bad', !ok);
      els.connBadge.hidden = topBarVisible;
    }
  }

  function closeSse() {
    if (sse) { try { sse.close(); } catch (e) {} sse = null; }
  }

  // 统一重连入口：带退避，避免重连风暴（尤其 iOS / 隧道抖动时反复 onerror 会狂建连接）
  function stopReconnect() {
    reconnecting = false;
    reconnectAttempts = 0;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  }

  function doReconnect() {
    if (reconnecting || !sseReconnectFn) return;
    reconnecting = true;
    reconnectAttempts++;
    setConn('连接中断，重连中…', false);
    const delay = Math.min(8000, 400 * reconnectAttempts);  // 退避递增，最多 8s
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      reconnecting = false;            // 放行下一轮重连
      if (sseReconnectFn) sseReconnectFn();
    }, delay);
  }

  // 进入房间时尽量把手机锁成横屏全屏：仅触屏设备尝试（安卓 Chrome 支持；
  // iOS 既无全屏 API 也无 orientation.lock，由“请横屏”浮层引导，这里直接跳过）
  function tryLockOrientation() {
    try {
      const coarse = window.matchMedia('(pointer: coarse)').matches;
      const small = window.matchMedia('(max-width: 1024px)').matches;
      if (!(coarse && small)) return;
      const doc = document.documentElement;
      if (screen.orientation && typeof screen.orientation.lock === 'function') {
        const fs = doc.requestFullscreen || doc.webkitRequestFullscreen || doc.webkitRequestFullScreen;
        if (fs) {
          Promise.resolve(fs.call(doc)).then(function () {
            screen.orientation.lock('landscape').catch(function () {});
          }).catch(function () {});
        }
      }
    } catch (e) {}
  }

  // 观战者通道：与玩家 SSE 共用服务器推送，但服务端以虚拟座位 -1 下发隐藏暗牌、无操作权限的只读视图
  function openSpectateStream(room, token) {
    closeSse();
    const url = `/api/stream?room=${encodeURIComponent(room)}&spectate=1&token=${encodeURIComponent(token || '')}`;
    sse = new EventSource(url);
    sseReconnectFn = () => openSpectateStream(room, token);
    sse.onopen = () => { reconnecting = false; lastSseMsgTs = Date.now(); setConn('观战中', true); };
    sse.onmessage = (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      lastSseMsgTs = Date.now();
      view = data;
      render();
    };
    sse.onerror = () => { doReconnect(); };
    startSseKeepAlive();
  }

  async function spectateRoom() {
    if (!account) { showAuth(); return; }
    const roomInput = (els.inputRoom.value || '').trim().toUpperCase();
    if (!roomInput) { alert('请输入要观战的房间号'); return; }
    els.btnSpectate.disabled = true;
    try {
      // 先用 spectate=1 拉一次状态，验证房间存在；拿不到则返回 404
      const v = await api(`/api/state?room=${roomInput}&spectate=1`);
      view = v;
      spectating = true;
      history.replaceState(null, '', `?room=${encodeURIComponent(roomInput)}&spectate=1`);
      showRoom();
      showSpectateBanner();
      openSpectateStream(roomInput, account.token);
      tryLockOrientation();   // 进房即尝试锁横屏（安卓全屏+横屏；iOS 忽略）
    } catch (e) {
      alert('观战失败：' + e.message);
    } finally {
      els.btnSpectate.disabled = false;
    }
  }

  function exitSpectate() {
    closeSse();
    stopReconnect();
    spectating = false;
    view = null;
    els.spectateBanner.hidden = true;
    setConn('未进入房间', false);
    showJoin();
  }

  // ---------- 渲染 ----------
  function renderCard(card, publicCard) {
    const isRed = card.suit === '♥' || card.suit === '♦';
    const div = document.createElement('div');
    div.className = `card ${isRed ? 'red' : 'black'} ${publicCard ? 'public' : ''}`;
    div.innerHTML = `
      <span class="corner top-left">${card.rank}<br>${card.suit}</span>
      <span class="suit">${card.suit}</span>
      <span class="corner bottom-right">${card.rank}<br>${card.suit}</span>
    `;
    return div;
  }
  function renderBack() {
    const div = document.createElement('div');
    div.className = 'card back';
    return div;
  }

  function renderWild() {
    els.wild.innerHTML = '';
    if (!view.wildCard) return;
    const { rank, suit } = view.wildCard;
    // 去掉原“桌面癞子牌：手中 X 为百搭（每局随机变换）”说明文字，
    // 只保留中央大牌面 + 「癞子」角标，画面更干净（用户要求不显示该说明）。
    const isRed = suit === '♥' || suit === '♦';
    const div = document.createElement('div');
    div.className = `card ${isRed ? 'red' : 'black'} wild`;
    div.innerHTML = `
      <span class="corner top-left">${rank}<br>${suit}</span>
      <span class="suit">${suit}</span>
      <span class="corner bottom-right">${rank}<br>${suit}</span>
      <span class="wild-badge">癞子</span>
    `;
    els.wild.appendChild(div);
  }

  // 按实际入座人数动态安排方位。includeEmpty=true 时把空座位也纳入布局
  // （大厅阶段显示「空位 N」框，人机补位后位置稳定不变）
  function layoutSeats(includeEmpty) {
    const idx = [];
    for (let i = 0; i < MAX_SEATS; i++) {
      if (view.players[i]) idx.push(i);
      else if (includeEmpty) idx.push(i);
    }
    const posMap = {
      2: ['bottom', 'top'],
      3: ['bottom', 'left', 'right'],
      4: ['bottom', 'right', 'top', 'left']
    };
    const positions = posMap[idx.length] || ['bottom', 'top'];
    idx.forEach((seat, k) => {
      const el = els.players[seat];
      el.dataset.pos = positions[k] || 'bottom';
      el.hidden = false;
    });
    if (!includeEmpty) {
      for (let i = 0; i < MAX_SEATS; i++) {
        if (!view.players[i]) els.players[i].hidden = true;
      }
    }
  }

  function renderPlayer(i, lobby) {
    const p = view.players[i];
    const el = els.players[i];
    if (!p) {
      if (lobby) {
        el.hidden = false;
        el.classList.remove('active', 'folded', 'revealing', 'winner', 'offline');
        el.querySelector('.name').textContent = '空位 ' + (i + 1);
        el.querySelector('.seat-ready').textContent = '等待加入';
        el.querySelector('.seat-ready').className = 'seat-ready empty';
        el.querySelector('.balance b').textContent = '--';
        el.querySelector('.bet b').textContent = '--';
        el.querySelector('.round-bets').textContent = '';
        el.querySelector('.round-bets').hidden = true;
        el.querySelector('.role').textContent = '';
        el.querySelector('.raise-tag').textContent = '';
        el.querySelector('.raise-tag').classList.remove('show');
        el.querySelector('.score').textContent = '';
        el.querySelector('.hand').innerHTML = '';
        el.querySelector('.winner-badge').classList.remove('show');
      } else {
        el.hidden = true;
      }
      return;
    }

    el.hidden = false;
    const handEl = el.querySelector('.hand');
    const infoEl = el.querySelector('.player-info');
    handEl.innerHTML = '';

    const revealAll = (view.phase === 'reveal' || view.phase === 'result' || view.phase === 'showdown');
    const isMe = roomSession && i === roomSession.seat;

    if (!lobby) {
      p.hand.forEach(card => {
        if (card.back) { handEl.appendChild(renderBack()); return; }
        const cardEl = renderCard(card, !card.hole);
        if (card.hole) {
          if (revealAll) {
            const tag = document.createElement('span');
            tag.className = 'ming-tag';
            tag.textContent = '明牌';
            cardEl.appendChild(tag);
          } else if (isMe && p.hasLooked) {
            const tag = document.createElement('span');
            tag.className = 'look-tag';
            tag.textContent = '看牌';
            cardEl.appendChild(tag);
          }
        }
        handEl.appendChild(cardEl);
      });
    }

    el.querySelector('.score').textContent = (!lobby && p.score) ? p.score : '';
    el.querySelector('.name').textContent = p.name;
    el.querySelector('.balance b').textContent = p.balance;

    // 每一轮扔豆数量
    const rb = p.roundBets || [0, 0, 0, 0, 0];
    const rbTotal = rb.reduce((a, b) => a + b, 0);
    el.querySelector('.bet b').textContent = rbTotal;
    const rbEl = el.querySelector('.round-bets');
    const labels = view.roundLabels || ['第3轮', '第4轮', '第5轮', '第6轮', '第7轮'];
    const rn = view.roundNo || 0;
    const rbParts = [];
    for (let r = 0; r < 5; r++) {
      const v = rb[r] || 0;
      if (v > 0 || r < rn) rbParts.push(labels[r] + ' ' + v);
    }
    if (rbParts.length && !lobby) {
      rbEl.textContent = rbParts.join(' · ');
      rbEl.hidden = false;
    } else {
      rbEl.textContent = '';
      rbEl.hidden = true;
    }

    const roleEl = infoEl.querySelector('.role');
    const parts = [];
    if (p.isBot) parts.push('🤖 人机');
    else if (p.isHost) parts.push('👑 房主');
    if (!lobby && p.hasLooked) parts.push('👁 已看牌');
    roleEl.textContent = parts.join(' ');
    roleEl.classList.toggle('looked', !lobby && !!p.hasLooked);

    // 准备状态：仅大厅阶段显示在每个座位上
    const readyEl = el.querySelector('.seat-ready');
    if (lobby) {
      readyEl.textContent = p.ready ? '✓ 已准备' : '未准备';
      readyEl.className = 'seat-ready' + (p.ready ? ' ready' : '');
    } else {
      readyEl.textContent = '';
      readyEl.className = 'seat-ready';
    }

    const tagEl = infoEl.querySelector('.raise-tag');
    const lm = (view.actions && view.actions.lookMultiplier) || 1;
    if (!lobby && isMe && pendingRaise > 0) {
      const effRaise = pendingRaise * lm;
      tagEl.textContent = lm > 1 ? `待扔豆 +${pendingRaise}（实际 +${effRaise}）` : `待扔豆 +${pendingRaise}`;
      tagEl.classList.add('show');
    } else if (!lobby && p.bet > 0) {
      const effBet = p.bet * (p.hasLooked ? 2 : 1);
      tagEl.textContent = `本局扔豆 ${p.bet}${p.hasLooked ? '（已看牌×2）' : ''}`;
      tagEl.classList.add('show');
    } else {
      tagEl.textContent = '';
      tagEl.classList.remove('show');
    }

    el.classList.toggle('active', !lobby && !!p.isTurn);
    el.classList.toggle('folded', !lobby && !!p.folded);
    el.classList.toggle('revealing', !lobby && view.phase === 'reveal');
    el.classList.toggle('offline', !lobby && !p.connected);
    const won = !lobby && view.winnerSeat === i && !view.gameRunning && view.phase === 'result';
    el.classList.toggle('winner', won);
    el.querySelector('.winner-badge').classList.toggle('show', won);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function showMessage(text) { els.message.textContent = text; }

  // 「人机陪玩」区域：房间里任何玩家都能用，按当前空位动态提示
  function renderBotArea(filled) {
    const botCount = view.botCount || 0;
    const empty = Math.max(0, (view.maxSeats || MAX_SEATS) - filled);
    // 容错：老版本服务器不下发 canAddBot 时，按本地条件推算，避免按钮永远是灰的
    const lobbyOk = !view.gameRunning && (view.phase === 'lobby' || view.phase === 'result');
    const canAdd = view.canAddBot !== undefined ? !!view.canAddBot : (lobbyOk && empty > 0);
    const canRemove = view.canRemoveBot !== undefined ? !!view.canRemoveBot : (lobbyOk && botCount > 0);

    if (els.botActions) els.botActions.hidden = false;
    els.btnAddBot.disabled = !canAdd;
    els.btnFillBot.disabled = !canAdd;
    els.btnRemoveBot.disabled = !canRemove;
    els.btnAddBot.textContent = empty > 0 ? `添加人机（空 ${empty} 位）` : '添加人机';
    els.btnFillBot.textContent = empty > 0 ? `补满人机（+${empty}）` : '补满人机';

    if (empty === 0) {
      els.botHint.textContent = botCount > 0
        ? `座位已满（${filled} 人，其中人机 ${botCount} 个）。真人加入会自动顶掉人机。`
        : '座位已满，无法再添加人机。';
    } else if (botCount > 0) {
      els.botHint.textContent = `已有人机 ${botCount} 个，还可补 ${empty} 个。人机自动准备，随时可以开始游戏。`;
    } else {
      const min = view.minPlayers || 2;
      const tip = filled < min ? `现在 ${filled} 人，补入人机凑够 ${min} 人就能开局。` : '';
      els.botHint.textContent = `还有 ${empty} 个空位。${tip}点「添加人机」一次加一个，或点「补满人机」直接凑齐 ${view.maxSeats || MAX_SEATS} 个座位。`;
    }
  }

  // 大厅（等待）阶段：中央房间面板 + 四个座位当席位
  function renderLobby() {
    els.roomCode.textContent = view.room;
    const min = view.minPlayers || 2;
    const filled = view.filled;
    const readyCount = view.players.filter(p => p && p.ready).length;

    const iAmReady = !!(view.you && view.you.ready);
    els.btnReadyLobby.textContent = iAmReady ? '✓ 已准备（点击取消）' : '准备';
    els.btnReadyLobby.classList.toggle('pulse', !iAmReady);
    els.btnStart.disabled = !view.canStart;

    renderBotArea(filled);

    if (filled < min) {
      els.lobbyMsg.textContent = `还需要至少 ${min - filled} 位玩家（最少 ${min} 人，最多 ${MAX_SEATS} 人）；也可点「添加人机 / 补满人机」凑人开局…`;
    } else if (readyCount < filled) {
      els.lobbyMsg.textContent = `已到 ${filled} 人，还有 ${filled - readyCount} 人未准备…`;
    } else if (view.you && view.you.isHost) {
      els.lobbyMsg.textContent = `全员已准备（${filled} 人），点击「开始游戏」开始。`;
    } else {
      els.lobbyMsg.textContent = `全员已准备（${filled} 人），等待房主开始…`;
    }
  }

  function render() {
    try {
    if (!view) return;

    // 调试：方便在浏览器控制台确认收到的人数与人机状态
    if (view.phase === 'lobby') {
      console.log('[render] phase=lobby filled=' + view.filled + ' botCount=' + (view.botCount || 0),
        'players=', view.players.map(p => p ? (p.name + (p.isBot ? '(BOT)' : '') + ':' + p.ready) : null));
    }

    els.pot.textContent = view.pot;
    els.currentBet.textContent = view.currentBet;
    els.round.textContent = view.roundName;
    els.topRoom.textContent = view.room || '--';

    // 本局「每一轮扔豆总额」面板（游戏中显示，大厅隐藏）。
    // 顶栏在对局中会隐藏，这里把「房间 / 轮次 / 底池 / 当前豆」一并搬到牌桌中央状态条，
    // 做到“只保留游戏桌面”的同时信息不丢。
    const rbTotals = view.roundBets || [0, 0, 0, 0, 0];
    const rLabels = view.roundLabels || ['第3轮', '第4轮', '第5轮', '第6轮', '第7轮'];
    const inGame = view.gameRunning || view.phase === 'result' || view.phase === 'showdown' || view.phase === 'reveal';
    if (inGame && els.roundSummary) {
      const seg = [];
      for (let r = 0; r < 5; r++) {
        if ((rbTotals[r] || 0) > 0 || r < (view.roundNo || 0)) {
          seg.push(`${rLabels[r]} ${rbTotals[r] || 0} 颗`);
        }
      }
      let txt = `房间 ${view.room || '--'} ｜ ${view.roundName} ｜ 底池 ${view.pot} 颗 ｜ 当前豆 ${view.currentBet} 颗`;
      txt += `\n每轮扔豆：${seg.length ? seg.join(' · ') : '0 颗'}`;
      els.roundSummary.textContent = txt;
      els.roundSummary.hidden = false;
    } else if (els.roundSummary) {
      els.roundSummary.hidden = true;
    }

    // 座位已被回收（被移出房间）→ 回到房间选择；观战者不占座位、view.you 恒为 null，需排除
    if (roomSession && !view.you && !spectating) { leaveRoomUI('你已离开房间。'); return; }

    // 进入房间后牌桌画面常驻；中央面板在大厅显示房间控制，游戏中显示癞子牌
    els.joinSection.hidden = true;
    els.table.hidden = false;
    // “请横屏”浮层显隐由 updateRotateHint() 统一裁决（见下），避免 CSS 媒体查询
    // 在部分机型横屏下失效应而遮挡大厅/开始按钮，导致进不去游戏。
    updateRotateHint();

    const lobby = view.phase === 'lobby';
    // 进入游戏（对局中或结算）后只保留牌桌：隐藏顶栏与消息栏等杂项，
    // 关键信息已搬进牌桌中央状态条（roundSummary），操作按钮固定在屏幕底部。
    const inPlay = view.gameRunning && !lobby;
    const cleanTable = inPlay || view.phase === 'result';
    if (els.topBar) els.topBar.hidden = cleanTable;
    topBarVisible = !cleanTable;                            // 供 setConn 决定是否用右上角徽标显示连接状态
    if (els.connBadge) els.connBadge.hidden = !cleanTable;  // 顶栏隐藏时由右上角徽标显示连接状态
    // 进入游戏（顶栏隐藏）后，用左上角悬浮「玩法」按钮开关规则弹窗，替代顶栏的「玩法」入口
    if (els.rulesFloat) els.rulesFloat.hidden = !cleanTable;

    if (spectating) {
      // 观战模式：纯只读，不显示任何可操作面板（房间控制 / 人机陪玩 / 操作按钮）
      els.roomPanel.hidden = true;
      els.botActions.hidden = true;
      els.messageArea.hidden = false;
      els.controls.hidden = true;
      showSpectateBanner();
    } else {
      els.roomPanel.hidden = !lobby;
      els.wild.hidden = lobby;
      els.botActions.hidden = !(lobby || view.phase === 'result');
      // 对局进行中隐藏消息栏（提示已并入牌桌中央状态条）；大厅/结算仍显示
      els.messageArea.hidden = lobby || inPlay;
      els.controls.hidden = lobby;      // 大厅用中央「准备 / 开始」；对局/结算时底部固定栏可见
    }

    if (lobby) {
      layoutSeats(true);   // 大厅也要布局：显示空位框，人机补位后位置稳定
      if (spectating) {
        showMessage(view.message || '（观战模式）等待玩家准备…');
      } else {
        renderLobby();
      }
      for (let i = 0; i < MAX_SEATS; i++) renderPlayer(i, true);
      return;
    }

    layoutSeats(false);
    for (let i = 0; i < MAX_SEATS; i++) renderPlayer(i, false);
    renderWild();

    const a = view.actions;
    let msg = view.message || '';
    const lm = (a && a.lookMultiplier) || 1;
    const lookNote = lm > 1 ? `（已看牌×${lm}）` : '';
    if (roomSession && view.waitingFor === roomSession.seat && a.call) {
      if (a.raise) {
        msg = `轮到你了（你是本轮首个扔豆者）。本轮最低彩豆 ${a.floor} 颗${lookNote}${pendingRaise ? `，当前加颗 +${pendingRaise * lm} 颗` : ''}；点「加颗」每次 +${RAISE_AMOUNT * lm} 颗${lookNote}，点「跟」确认，或「弃牌」。` + (msg ? `（${msg}）` : '');
      } else {
        msg = `轮到你了。豆数已锁定，点「跟」补齐 ${a.need} 颗${lookNote}，或「弃牌」。` + (msg ? `（${msg}）` : '');
      }
    }
    showMessage(msg);
    // 对局进行中消息栏已隐藏，把“轮到你了…”提示并入牌桌中央状态条，确保玩家看得见该操作
    if (inPlay && els.roundSummary && !els.roundSummary.hidden && msg) {
      els.roundSummary.textContent += '\n' + msg;
    }

    // 结算阶段：显示准备 / 开始下一局，同时允许房主调整人机
    const resultPhase = (view.phase === 'result');
    if (resultPhase && !spectating) renderBotArea(view.filled);
    els.btnReady.hidden = !resultPhase;
    if (resultPhase) {
      els.btnReady.disabled = false;
      els.btnReady.textContent = (view.you && view.you.ready) ? '取消准备' : '准备下一局';
    }
    els.btnNew.disabled = !view.canStart || !resultPhase;
    els.btnNew.hidden = !resultPhase;
    els.btnNew.classList.toggle('pulse', !!view.canStart && resultPhase);

    els.btnCall.disabled = !a.call;
    els.btnRaise.disabled = !a.raise;
    els.btnLook.disabled = !a.look;
    els.btnFold.disabled = !a.fold;

    const key = `${view.room}-${view.phase}-${view.waitingFor}`;
    if (key !== lastTurnKey) { lastTurnKey = key; pendingRaise = 0; }

    // 对局进行中（下注/发牌/亮牌等）自动隐藏 PWA 安装引导条，
    // 避免它（即便已置为点击穿透）在任意布局下遮挡操作按钮，导致「卡住」。
    const pwaBar = document.getElementById('pwa-install-bar');
    if (pwaBar) pwaBar.hidden = !!view.gameRunning;
    } catch (err) {
      console.error('[render 异常，已跳过本次刷新]', err);
    }
  }

  // ---------- 界面切换 ----------
  function showAuth(msg) {
    topBarVisible = true;   // 登录页顶栏可见，连接状态走顶栏，不显示右上角徽标
    els.authSection.hidden = false;
    els.joinSection.hidden = true;
    els.table.hidden = true;
    els.controls.hidden = true;
    els.messageArea.hidden = true;
    els.botActions.hidden = true;
    if (els.rotateHint) els.rotateHint.hidden = true;
    if (msg) els.authHint.textContent = msg;
    setConn('未登录', false);
  }

  function showJoin() {
    topBarVisible = true;   // 进入房间页顶栏可见，连接状态走顶栏，不显示右上角徽标
    els.authSection.hidden = true;
    els.joinSection.hidden = false;
    els.table.hidden = true;
    els.controls.hidden = true;
    els.messageArea.hidden = true;
    els.botActions.hidden = true;
    if (els.rotateHint) els.rotateHint.hidden = true;
    if (account) {
      els.myCode.textContent = account.code;
      els.myNick.textContent = account.nickname ? `（${account.nickname}）` : '';
    }
    setConn('未进入房间', false);
  }

  function showRoom() {
    // 进入房间即显示牌桌画面，房间控制面板由 render() 根据阶段决定显示
    els.authSection.hidden = true;
    els.joinSection.hidden = true;
    els.table.hidden = false;
  }

  function showSpectateBanner() {
    if (view && view.room) els.spectateRoom.textContent = view.room;
    els.spectateBanner.hidden = false;
  }

  function leaveRoomUI(msg) {
    clearRoomSession();
    if (sse) { try { sse.close(); } catch (e) {} }
    sse = null;
    view = null;
    showJoin();
    if (msg) alert(msg);
  }

  // ---------- 账号 ----------
  function setAuthMode(mode) {
    authMode = mode;
    const reg = mode === 'register';
    els.tabLogin.classList.toggle('active', !reg);
    els.tabRegister.classList.toggle('active', reg);
    els.rowNickname.hidden = !reg;
    els.btnAuth.textContent = reg ? '注册并登录' : '登录';
    els.authHint.textContent = reg
      ? '注册后会生成一个专属且不重复的 6 位玩家编码。'
      : '还没有账号？点上方「注册」。';
  }

  async function submitAuth() {
    const phone = (els.inputPhone.value || '').trim();
    const password = els.inputPassword.value || '';
    const nickname = (els.inputNick.value || '').trim();
    if (!/^1\d{10}$/.test(phone)) { alert('请输入正确的 11 位手机号'); return; }
    if (password.length < 6) { alert('密码至少 6 位'); return; }

    els.btnAuth.disabled = true;
    try {
      let data;
      if (authMode === 'register') {
        if (!nickname) { alert('请输入昵称'); els.btnAuth.disabled = false; return; }
        data = await api('/api/register', { phone, password, nickname });
        alert(`注册成功！你的玩家编码是 ${data.code}，请记住它。`);
      } else {
        data = await api('/api/login', { phone, password });
      }
      saveAccount({ token: data.token, phone: data.phone, code: data.code, nickname: data.nickname });
      els.inputPassword.value = '';
      showJoin();
    } catch (e) {
      alert(e.message);
    } finally {
      els.btnAuth.disabled = false;
    }
  }

  // ---------- 房间 ----------
  function syncEnterLabel() {
    const v = (els.inputRoom.value || '').trim();
    els.btnEnter.textContent = v ? '加入房间' : '创建房间并进入';
  }

  async function enterRoom() {
    if (!account) { showAuth(); return; }
    const roomInput = (els.inputRoom.value || '').trim().toUpperCase();
    els.btnEnter.disabled = true;
    try {
    const data = roomInput
      ? await api('/api/join', { room: roomInput, token: account.token })
      : await api('/api/create', { token: account.token });
    saveRoomSession({ room: data.room, seat: data.seat, seatToken: data.seatToken });
    history.replaceState(null, '', `?room=${encodeURIComponent(data.room)}`);
    showRoom();
    // 关键修复：先立即拉一次完整状态并渲染，确保“进入房间”后大厅/牌桌立刻出现，
    // 不再依赖 SSE 首帧；否则一旦后续步骤（如复制邀请链接）抛错，openStream 不执行、
    // 牌桌永远空白，表现为“进入房间却进不去 / 卡在空桌面”。
    try {
      const v = await api(`/api/state?room=${encodeURIComponent(data.room)}&seat=${data.seat}`);
      view = v;
      render();
    } catch (e) { /* SSE 仍会兜底渲染，这里静默即可 */ }
    openStream();            // 建立游戏实时推送（断线重连 / 轮询兜底已在内部处理）
    tryLockOrientation();    // 进房即尝试锁横屏（安卓全屏+横屏；iOS 忽略）
    refreshInviteLink();     // 复制邀请链接：失败不影响进房（函数内部已 try-catch）
    } catch (e) {
      alert(e.message);
    } finally {
      els.btnEnter.disabled = false;
    }
  }

  async function refreshInviteLink() {
    try {
      const info = await api('/api/info');
      let base = window.location.origin;
      if (/localhost|127\.0\.0\.1/.test(base)) base = `http://${info.lanIp}:${info.port}`;
      els.inviteLink.value = `${base}/?room=${roomSession.room}`;
      els.inviteHint.textContent = `同网络好友可直接用此链接加入；异地好友需先做内网穿透（见下方规则）。服务器局域网地址：http://${info.lanIp}:${info.port}`;
    } catch (e) {
      els.inviteLink.value = `${window.location.origin}/?room=${roomSession ? roomSession.room : ''}`;
    }
  }

  // ---------- 事件 ----------
  els.tabLogin.addEventListener('click', () => setAuthMode('login'));
  els.tabRegister.addEventListener('click', () => setAuthMode('register'));
  els.btnAuth.addEventListener('click', submitAuth);
  els.inputPassword.addEventListener('keydown', e => { if (e.key === 'Enter') submitAuth(); });

  els.btnLogout.addEventListener('click', () => {
    if (sse) { try { sse.close(); } catch (e) {} }
    clearRoomSession();
    clearAccount();
    view = null;
    setAuthMode('login');
    showAuth();
  });

  els.btnEnter.addEventListener('click', enterRoom);
  els.inputRoom.addEventListener('keydown', e => { if (e.key === 'Enter') enterRoom(); });
  els.inputRoom.addEventListener('input', syncEnterLabel);

  els.btnStart.addEventListener('click', () => sendAction({ type: 'start' }));
  els.btnNew.addEventListener('click', () => sendAction({ type: 'start' }));

  function toggleReady() {
    const ready = view && view.you && view.you.ready;
    sendAction({ type: ready ? 'unready' : 'ready' });
  }
  els.btnReadyLobby.addEventListener('click', toggleReady);
  els.btnReady.addEventListener('click', toggleReady);

  els.btnAddBot.addEventListener('click', () => sendAction({ type: 'addBot' }));
  els.btnFillBot.addEventListener('click', () => sendAction({ type: 'fillBot' }));
  els.btnRemoveBot.addEventListener('click', () => sendAction({ type: 'removeBot' }));

  els.btnLeave.addEventListener('click', () => {
    sendAction({ type: 'leave' });
    leaveRoomUI();
  });

  els.btnSpectate.addEventListener('click', spectateRoom);
  els.btnExitSpectate.addEventListener('click', exitSpectate);

  // 对局中（顶栏隐藏）用左上角悬浮「玩法」按钮开关规则弹窗：点一下打开，再点一下关闭
  if (els.rulesFloat) {
    els.rulesFloat.addEventListener('click', function () {
      const r = document.getElementById('rules');
      if (!r) return;
      if (r.classList.contains('open')) r.classList.remove('open');
      else r.classList.add('open');
    });
  }

  els.btnCopy.addEventListener('click', async () => {
    const text = els.inviteLink.value;
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      els.inviteLink.select();
      document.execCommand('copy');
    }
    els.btnCopy.textContent = '已复制';
    setTimeout(() => { els.btnCopy.textContent = '复制链接'; }, 1500);
  });

  els.btnCall.addEventListener('click', () => {
    sendAction({ type: 'call', raise: pendingRaise });
    pendingRaise = 0;
    disableActionButtons();
  });
  els.btnRaise.addEventListener('click', () => { pendingRaise += RAISE_AMOUNT; render(); });
  els.btnLook.addEventListener('click', () => {
    sendAction({ type: 'look' });
    els.btnLook.disabled = true;
  });
  els.btnFold.addEventListener('click', () => {
    sendAction({ type: 'fold' });
    pendingRaise = 0;
    disableActionButtons();
  });

  function disableActionButtons() {
    els.btnCall.disabled = true;
    els.btnRaise.disabled = true;
    els.btnFold.disabled = true;
    els.btnLook.disabled = true;
  }

  // ---------- 初始化 ----------
  // 关闭“请横屏”浮层：点按钮或点浮层任意处都生效，本次会话内不再弹
  function dismissRotateHint() {
    rotateDismissed = true;
    if (els.rotateHint) els.rotateHint.hidden = true;
  }

  // 统一裁决“请横屏”浮层是否显示：
  // - 仅在对局进行中（非大厅、非观战）才提示，大厅/结算阶段的准备/开始按钮绝不被遮挡；
  // - 用 innerWidth/innerHeight 实际宽高比判断竖屏（比 CSS orientation 媒体查询更可靠，
  //   规避部分机型横屏下媒体查询失效应、浮层仍盖住入口的问题）；
  //   横屏（宽 > 高）一律隐藏，任何方向都能正常进游戏。
  function updateRotateHint() {
    if (!els.rotateHint) return;
    const portrait = window.innerWidth <= window.innerHeight;
    const inPlay = view && view.phase !== 'lobby' && !spectating;
    const show = portrait && inPlay && !rotateDismissed;
    els.rotateHint.hidden = !show;
  }

  (function init() {
    const params = new URLSearchParams(location.search);
    const roomParam = params.get('room');
    if (roomParam) els.inputRoom.value = roomParam.toUpperCase();
    syncEnterLabel();

    if (els.rotateHintBtn) els.rotateHintBtn.addEventListener('click', dismissRotateHint);
    if (els.rotateHint) els.rotateHint.addEventListener('click', dismissRotateHint);
    // 旋转 / 尺寸变化时即时裁决浮层显隐，避免横竖切换后浮层状态不同步
    window.addEventListener('orientationchange', updateRotateHint);
    window.addEventListener('resize', updateRotateHint);

    startAutoRefresh();   // 每 500ms 轻量刷新页面数据（拉状态+重渲染，不整页重载）

    const savedAccount = loadAccount();
    if (!savedAccount) { showAuth(); return; }

    // 校验登录态
    api(`/api/me?token=${encodeURIComponent(savedAccount.token)}`)
      .then(data => {
        saveAccount({ token: savedAccount.token, phone: data.phone, code: data.code, nickname: data.nickname });
        showJoin();
        // 通过 ?spectate=1 进入（如刷新观战页面）：登录后直接回到观战模式
        if (roomParam && params.get('spectate') === '1') {
          spectateRoom();
          return;
        }
        // 有房间会话则直接回到原座位（刷新 / 重开页面都直接回到房间等待界面）
        const rs = loadRoomSession();
        if (rs && (!roomParam || rs.room === roomParam.toUpperCase())) {
          api(`/api/state?room=${rs.room}&seat=${rs.seat}`)
            .then(v => {
              roomSession = rs;
              view = v;
              showRoom();
              refreshInviteLink();
              openStream();
            })
            .catch(() => {
              clearRoomSession();
              // 会话失效：带房间号就直接进那个房间，否则留在进入房间面板
              if (roomParam) enterRoom(); else showJoin();
            });
          return;
        }
        // 好友点开邀请链接（带 ?room=XXXX）：登录后自动进入房间等待界面
        if (roomParam) enterRoom();
      })
      .catch(() => { clearAccount(); showAuth(); });
  })();
})();
