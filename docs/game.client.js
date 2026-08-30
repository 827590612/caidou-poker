(function () {
  'use strict';

  /*
   * 彩豆扑克 · 单机版（纯前端，浏览器内运行，无需服务器）
   * 引擎逻辑完整移植自 server.js；渲染层沿用 game.js 的结构与样式。
   * 区别：发牌 / 扔豆 / 比大小 / 人机全部在本地完成，不依赖任何后端。
   * 因此可原样放到 GitHub Pages 等静态托管上直接玩（仅单机 vs 电脑）。
   */

  // ================= 牌面配置 =================
  const SUITS = ['♠', '♥', '♦', '♣'];
  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const SCORE_MAP = {
    A: 15, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, J: 11, Q: 12, K: 13
  };
  const RANK_ORDER = {
    A: 14, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9, 10: 10, J: 11, Q: 12, K: 13
  };
  const SUIT_ORDER = { '♠': 4, '♥': 3, '♦': 2, '♣': 1 };

  const MIN_BET = 10;
  const RAISE_AMOUNT = 10;
  const START_BALANCE = 5000;
  const ANTE = 10;
  const MAX_SEATS = 4;
  const MIN_PLAYERS = 2;

  const BOT_NAMES = ['人机·小彩', '人机·豆豆', '人机·阿彩', '人机·彩彩', '人机·豆宝', '人机·幸运星'];

  // ================= 工具 =================
  function randInt(n) { return Math.floor(Math.random() * n); }
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = randInt(i + 1);
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
  function createDeck() {
    const cards = [];
    for (const suit of SUITS) for (const rank of RANKS) cards.push({ suit, rank, id: rank + suit });
    return shuffle(cards);
  }
  function cardScore(card) { return SCORE_MAP[card.rank]; }
  function cardRankValue(card) { return RANK_ORDER[card.rank]; }
  function compareCards(a, b) {
    const ra = cardRankValue(a), rb = cardRankValue(b);
    if (ra !== rb) return ra - rb;
    return SUIT_ORDER[a.suit] - SUIT_ORDER[b.suit];
  }

  function evaluateHand(cards) {
    const counts = {};
    let sum = 0;
    for (const card of cards) {
      const s = cardScore(card);
      counts[card.rank] = (counts[card.rank] || 0) + 1;
      sum += s;
    }
    let category = 0, score = sum, desc = '散牌';
    const maxCount = Math.max(...Object.values(counts));
    if (maxCount >= 5) {
      const rank = Object.keys(counts).find(r => counts[r] >= 5);
      const cScore = cardScore({ rank });
      score = cScore * 5 + 120 + (sum - cScore * 5);
      category = 5; desc = '五条';
    } else if (maxCount >= 4) {
      const rank = Object.keys(counts).find(r => counts[r] >= 4);
      const cScore = cardScore({ rank });
      score = cScore * 4 + 60 + (sum - cScore * 4);
      category = 4; desc = '四条';
    } else if (maxCount >= 3) {
      const rank = Object.keys(counts).find(r => counts[r] >= 3);
      const cScore = cardScore({ rank });
      score = cScore * 3 + 30 + (sum - cScore * 3);
      category = 3; desc = '三条';
    }
    return { category, score, desc };
  }

  function evaluateBest(cards, wildCard) {
    if (!wildCard) return evaluateHand(cards);
    const wildRank = wildCard.rank;
    const wildIdx = [];
    const fixedRanks = new Set();
    cards.forEach((c, i) => {
      if (c.rank === wildRank) wildIdx.push(i);
      else fixedRanks.add(c.rank);
    });
    if (wildIdx.length === 0) return evaluateHand(cards);
    const candidateRanks = Array.from(fixedRanks.size ? fixedRanks : new Set([wildRank]));
    let best = null;
    const k = wildIdx.length;
    const assign = new Array(k);
    function rec(depth) {
      if (depth === k) {
        const all = cards.map(c => ({ ...c }));
        for (let t = 0; t < k; t++) all[wildIdx[t]] = { suit: all[wildIdx[t]].suit, rank: assign[t] };
        const ev = evaluateHand(all);
        if (!best || ev.category > best.category || (ev.category === best.category && ev.score > best.score)) {
          best = { ...ev, usedWild: true };
        }
        return;
      }
      for (const r of candidateRanks) { assign[depth] = r; rec(depth + 1); }
    }
    rec(0);
    return best;
  }

  function compareHands(a, b, wildCard) {
    const ea = evaluateBest(a.hand, wildCard);
    const eb = evaluateBest(b.hand, wildCard);
    if (ea.category !== eb.category) return ea.category - eb.category;
    if (ea.score !== eb.score) return ea.score - eb.score;
    for (const i of [2, 3, 4]) {
      const sa = SCORE_MAP[a.hand[i].rank], sb = SCORE_MAP[b.hand[i].rank];
      if (sa !== sb) return sa - sb;
    }
    for (const i of [0, 1]) {
      const sa = SCORE_MAP[a.hand[i].rank], sb = SCORE_MAP[b.hand[i].rank];
      if (sa !== sb) return sa - sb;
    }
    return 0;
  }

  function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

  // ================= 客户端房间状态 =================
  function createRoomState(opponentCount) {
    const players = [];
    players[0] = {
      id: 0, name: '你', isBot: false, isHost: true,
      balance: START_BALANCE, hand: [], bet: 0, betHistory: [0, 0, 0, 0, 0],
      folded: false, hasLooked: false, ready: true, connected: true
    };
    for (let i = 1; i <= opponentCount && i < MAX_SEATS; i++) {
      players[i] = {
        id: i, name: BOT_NAMES[(i - 1) % BOT_NAMES.length], isBot: true, isHost: false,
        balance: START_BALANCE, hand: [], bet: 0, betHistory: [0, 0, 0, 0, 0],
        folded: false, hasLooked: false, ready: true, connected: true
      };
    }
    return {
      players, deck: [], pot: 0, currentBet: 0, prevRoundBet: 0,
      wildCard: null, turn: -1, waitingFor: -1, message: '',
      gameRunning: false, winnerSeat: -1, roundNo: 0, roundBets: [0, 0, 0, 0, 0], phase: 'lobby'
    };
  }

  function seated(room) { return room.players.filter(Boolean); }
  function botSeated(room) { return room.players.filter(p => p && p.isBot); }

  function botStrength(room, p) {
    const ev = evaluateBest(p.hand, room.wildCard);
    const n = Math.max(1, p.hand.length);
    const avg = ev.score / n;
    const norm = 1 / (1 + Math.exp(-(avg - 8.1) / 1.3));
    let s = (ev.category / 5) * 0.45 + norm * 0.55;
    return Math.max(0, Math.min(1, s));
  }

  function decideBotAction(room, p) {
    let strength = botStrength(room, p);
    strength = Math.max(0, Math.min(1, strength + (Math.random() - 0.5) * 0.18));
    if (!p.hasLooked) {
      const wantLook = strength >= 0.44 || (p.hand.length >= 5 && strength >= 0.4) || Math.random() < 0.12;
      if (wantLook) p.hasLooked = true;
    }
    const active = seated(room).filter(x => !x.folded);
    const allLooked = active.every(x => x.hasLooked);
    const lm = (p.hasLooked && !allLooked) ? 2 : 1;
    const canRaise = room.currentBet === 0;
    const baseNeed = Math.max(0, room.currentBet - p.bet);
    const floor = Math.max(MIN_BET, room.prevRoundBet);
    const baseCost = canRaise ? Math.max(0, floor - p.bet) : baseNeed;
    const cost = baseCost * lm;
    if (!canRaise && cost > 0) {
      const pressure = Math.min(1, cost / Math.max(1, p.balance * 0.12));
      const foldChance = Math.max(0, (0.34 - strength) * 1.3 + pressure * 0.25);
      if (Math.random() < foldChance) return { type: 'fold' };
    }
    let raise = 0;
    if (canRaise) {
      if (strength > 0.56) raise = RAISE_AMOUNT * (1 + randInt(2));
      else if (strength > 0.42 && Math.random() < 0.45) raise = RAISE_AMOUNT;
    } else if (strength > 0.6 && Math.random() < 0.35) {
      raise = RAISE_AMOUNT;
    }
    return { type: 'call', raise };
  }

  function getBetLeaderSeat(room, cardIndex, smallestFirst) {
    const active = seated(room).filter(p => !p.folded);
    if (active.length === 0) return 0;
    if (smallestFirst) {
      let leader = active[0], leaderScore = SCORE_MAP[active[0].hand[cardIndex].rank];
      for (const p of active) {
        const s = SCORE_MAP[p.hand[cardIndex].rank];
        if (s < leaderScore) { leader = p; leaderScore = s; }
      }
      return leader.id;
    }
    let leader = active[0], leaderCard = active[0].hand[cardIndex];
    for (const p of active) if (compareCards(p.hand[cardIndex], leaderCard) > 0) { leader = p; leaderCard = p.hand[cardIndex]; }
    return leader.id;
  }

  function allMatchedOrFolded(room) {
    const active = seated(room).filter(p => !p.folded);
    if (active.length <= 1) return true;
    return active.every(p => p.bet === room.currentBet);
  }
  function checkSingleActive(room) { return seated(room).filter(p => !p.folded).length <= 1; }

  function applyAction(room, player, action) {
    if (action.type === 'fold') { player.folded = true; room.message = player.name + ' 弃牌了。'; return; }
    const allActiveLooked = seated(room).filter(p => !p.folded).every(p => p.hasLooked);
    const lookMultiplier = (player.hasLooked && !allActiveLooked) ? 2 : 1;
    let totalBet;
    if (room.currentBet === 0) {
      const floor = Math.max(MIN_BET, room.prevRoundBet);
      totalBet = floor + (action.raise || 0);
    } else {
      totalBet = room.currentBet + (action.raise || 0);
    }
    let basePay = totalBet - player.bet;
    let effectivePay = basePay * lookMultiplier;
    if (effectivePay > player.balance) {
      if (player.balance > 0) {
        const maxBasePay = Math.floor(player.balance / lookMultiplier);
        basePay = Math.max(0, maxBasePay);
        effectivePay = basePay * lookMultiplier;
        totalBet = player.bet + basePay;
      } else { player.folded = true; room.message = player.name + ' 余额不足，弃牌。'; return; }
    }
    player.balance -= effectivePay;
    player.bet = totalBet;
    if (totalBet > room.currentBet) room.currentBet = totalBet;
    room.pot += effectivePay;
    const roundMap = { bet1: 1, bet2: 2, bet3: 3, bet4: 4, bet5: 5 };
    const rn = roundMap[room.phase] || 0;
    if (rn > 0) {
      if (!player.betHistory) player.betHistory = [0, 0, 0, 0, 0];
      if (!room.roundBets) room.roundBets = [0, 0, 0, 0, 0];
      player.betHistory[rn - 1] += effectivePay;
      room.roundBets[rn - 1] += effectivePay;
    }
    const hint = lookMultiplier > 1 ? `（已看牌×${lookMultiplier}，实际扔 ${effectivePay} 颗）` : '';
    if ((action.raise || 0) > 0) room.message = `${player.name} 加颗到 ${totalBet} 颗${hint}（本局累计 ${player.bet} 颗）。`;
    else if (room.currentBet > 0 && player.bet === room.currentBet) room.message = `${player.name} 跟颗了 ${effectivePay} 颗${hint}（本局累计 ${player.bet} 颗）。`;
    else room.message = `${player.name} 扔豆 ${effectivePay} 颗${hint}。`;
  }

  function dealToAll(room, count) {
    for (let r = 0; r < count; r++) for (const p of room.players) { if (!p) continue; if (room.deck.length === 0) return; p.hand.push(room.deck.pop()); }
  }
  function nextSeat(room, from) {
    for (let i = 1; i <= MAX_SEATS; i++) {
      const s = (from + i) % MAX_SEATS;
      if (room.players[s]) return s;
    }
    return from;
  }

  // 人类操作解析：仅在「跟 / 弃牌」时结束本轮等待；「看牌 / 加颗」只是中途调整，不结束回合
  let humanResolver = null;
  let humanAuto = null; // 无头测试用：若设置则自动返回动作

  async function awaitHumanAction(room, seat) {
    if (humanAuto) return humanAuto(room, seat);
    return new Promise(resolve => { humanResolver = resolve; });
  }

  async function runBettingRound(room, cardIndex, smallestFirst) {
    let turn = getBetLeaderSeat(room, cardIndex, smallestFirst);
    room.turn = turn;
    const acted = new Set();
    while (true) {
      const active = seated(room).filter(p => !p.folded);
      if (active.length <= 1) break;
      const p = room.players[turn];
      if (p && !p.folded && !(room.currentBet > 0 && p.bet === room.currentBet)) {
        room.turn = turn;
        room.waitingFor = turn;
        render();
        let action;
        if (p.isBot) {
          await sleep(600 + randInt(900));
          action = decideBotAction(room, p);
        } else {
          action = await awaitHumanAction(room, turn);
        }
        room.waitingFor = -1;
        if (action.type === 'look') {
          p.hasLooked = true;
          render();
          // 看牌不消耗回合，继续等待其「跟 / 弃牌」
          turn = nextSeat(room, turn);
          continue;
        }
        applyAction(room, p, action);
        acted.add(turn);
        render();
        await sleep(450);
      }
      const allActed = active.every(p => acted.has(p.id));
      if (allActed && allMatchedOrFolded(room)) break;
      turn = nextSeat(room, turn);
    }
    room.prevRoundBet = room.currentBet;
    room.currentBet = 0;
    for (const p of room.players) if (p) p.bet = 0;
    room.turn = -1; room.waitingFor = -1;
    render();
  }

  async function endGame(room) {
    const active = seated(room).filter(p => !p.folded);
    let best = active[0];
    for (const p of active.slice(1)) if (compareHands(p, best, room.wildCard) > 0) best = p;
    const bestEv = evaluateBest(best.hand, room.wildCard);
    room.phase = 'showdown';
    room.winnerSeat = best.id;
    room.message = active.length === 1
      ? `${best.name} 赢！其他人都弃牌了`
      : `比大小！${best.name} 以 ${bestEv.desc}（${bestEv.score} 颗）胜出`;
    render();
    await sleep(5000);
    const settledPot = room.pot;
    best.balance += room.pot;
    const WINNER_TAX = 10;
    best.balance -= WINNER_TAX;
    for (const p of room.players) if (p) p.bet = 0;
    room.pot = 0;
    room.phase = 'result';
    room.gameRunning = false;
    room.winnerSeat = best.id;
    room.message = `${best.name} 赢得彩豆 ${settledPot} 颗（赢家扣 ${WINNER_TAX} 颗）！` + (active.length === 1 ? '（其他人全部弃牌）' : '');
    render();
  }

  async function startGame(room) {
    const ps = seated(room);
    if (room.gameRunning) return;
    if (ps.length < MIN_PLAYERS || ps.length > MAX_SEATS) return;
    room.gameRunning = true;
    room.deck = createDeck();
    room.pot = 0; room.currentBet = 0; room.prevRoundBet = 0; room.winnerSeat = -1;
    for (const p of ps) {
      p.balance = START_BALANCE; p.hand = []; p.bet = 0;
      p.betHistory = [0, 0, 0, 0, 0]; p.folded = false; p.hasLooked = false;
    }
    room.roundBets = [0, 0, 0, 0, 0]; room.roundNo = 0;
    if (room.deck.length > 0) room.wildCard = room.deck.pop();
    for (const p of ps) { p.balance -= ANTE; room.pot += ANTE; }
    dealToAll(room, 2); dealToAll(room, 1);
    room.phase = 'bet1';
    room.message = `开局！${ps.length} 人对局，每人 ${START_BALANCE} 颗、底注 ${ANTE} 颗；癞子牌点数 ${room.wildCard.rank} 为百搭。第 3 张明牌最大者先说话。`;
    render();
    await runBettingRound(room, 2, false);
    if (checkSingleActive(room)) { await endGame(room); return; }
    room.phase = 'deal4'; dealToAll(room, 1); room.phase = 'bet2';
    room.message = '第 4 张明牌已发，第 4 张明牌分值最大者先扔豆。'; render();
    await runBettingRound(room, 3, false);
    if (checkSingleActive(room)) { await endGame(room); return; }
    room.phase = 'deal5'; dealToAll(room, 1); room.phase = 'bet3';
    room.message = '第 5 张明牌已发，结束摸牌。第 5 张明牌最大者先扔豆。'; render();
    await runBettingRound(room, 4, false);
    if (checkSingleActive(room)) { await endGame(room); return; }
    room.phase = 'bet4';
    room.message = '第 6 轮扔豆：以第 5 张明牌分值比较，分值最小者先扔豆。'; render();
    await runBettingRound(room, 4, true);
    if (checkSingleActive(room)) { await endGame(room); return; }
    room.phase = 'bet5';
    room.message = '第 7 轮扔豆：以第 5 张明牌分值比较，分值最小者先扔豆。'; render();
    await runBettingRound(room, 4, true);
    if (checkSingleActive(room)) { await endGame(room); return; }
    room.phase = 'reveal'; room.turn = -1; room.message = '亮牌！准备比大小…'; render();
    await sleep(5000);
    await endGame(room);
  }

  // ================= 视图（与 game.js 期望的结构一致） =================
  function buildView(room, seat) {
    const revealAll = (room.phase === 'reveal' || room.phase === 'result' || room.phase === 'showdown');
    const ps = seated(room);
    const players = room.players.map((p, i) => {
      if (!p) return null;
      const isViewer = (i === seat);
      const hand = p.hand.map((card, ci) => {
        const isHole = ci < 2;
        let visible = true;
        if (isHole) {
          if (revealAll) visible = true;
          else if (isViewer) visible = p.hasLooked;
          else visible = false;
        }
        if (!visible) return { back: true, hole: true };
        return { suit: card.suit, rank: card.rank, hole: isHole };
      });
      let score = '';
      if (revealAll && !p.folded) {
        const ev = evaluateBest(p.hand, room.wildCard);
        const wildNote = (ev.usedWild && room.wildCard) ? `（含癞子：${room.wildCard.rank}百搭）` : '';
        score = `${ev.desc} · ${ev.score}分${wildNote}`;
      } else if (p.folded) score = '已弃牌';
      return {
        id: i, name: p.name, connected: p.connected, isHost: i === 0,
        balance: p.balance, bet: p.bet, roundBets: (p.betHistory || [0, 0, 0, 0, 0]).slice(),
        folded: p.folded, hasLooked: p.hasLooked, ready: p.ready, isBot: !!p.isBot,
        isTurn: room.turn === i, hand, score
      };
    });
    const roundNames = {
      lobby: '大厅', bet1: '第三轮扔豆', deal4: '发第四张', bet2: '第四轮扔豆',
      deal5: '发第五张', bet3: '第五轮扔豆', bet4: '第六轮扔豆', bet5: '第七轮扔豆',
      reveal: '亮牌', showdown: '比大小', result: '比大小'
    };
    const me = room.players[seat];
    const allActiveLooked = ps.filter(p => !p.folded).every(p => p.hasLooked);
    const lookMultiplier = (me && me.hasLooked && !allActiveLooked) ? 2 : 1;
    let actions = { call: false, raise: false, fold: false, look: false, need: 0, floor: 0, lookMultiplier };
    if (me && room.gameRunning && room.waitingFor === seat && room.phase.startsWith('bet')) {
      const baseNeed = room.currentBet - me.bet;
      const canRaise = (room.currentBet === 0);
      const baseFloor = Math.max(MIN_BET, room.prevRoundBet);
      actions = {
        call: true, raise: canRaise, fold: true, look: !me.hasLooked,
        need: baseNeed * lookMultiplier, floor: baseFloor * lookMultiplier, lookMultiplier
      };
    }
    return {
      room: '单机', phase: room.phase, roundName: roundNames[room.phase] || room.phase,
      pot: room.pot, currentBet: room.currentBet,
      roundBets: (room.roundBets || [0, 0, 0, 0, 0]).slice(), roundNo: room.roundNo || 0,
      roundLabels: ['第3轮', '第4轮', '第5轮', '第6轮', '第7轮'],
      message: room.message, turn: room.turn, waitingFor: room.waitingFor,
      winnerSeat: room.winnerSeat,
      wildCard: room.wildCard ? { rank: room.wildCard.rank, suit: room.wildCard.suit } : null,
      you: me ? { seat, name: me.name, isHost: seat === 0, ready: me.ready } : null,
      players, filled: ps.length, minPlayers: MIN_PLAYERS, maxSeats: MAX_SEATS,
      allReady: true, gameRunning: room.gameRunning,
      canStart: false, botCount: botSeated(room).length, botMax: MAX_SEATS - ps.length,
      canAddBot: false, canRemoveBot: false, actions
    };
  }

  // ================= 渲染层 =================
  let view = null;
  let room = null;
  let els = {};
  let pendingRaise = 0;

  function renderCard(card, publicCard) {
    const isRed = card.suit === '♥' || card.suit === '♦';
    const div = document.createElement('div');
    div.className = `card ${isRed ? 'red' : 'black'} ${publicCard ? 'public' : ''}`;
    div.innerHTML = `<span class="corner top-left">${card.rank}<br>${card.suit}</span><span class="suit">${card.suit}</span><span class="corner bottom-right">${card.rank}<br>${card.suit}</span>`;
    return div;
  }
  function renderBack() { const div = document.createElement('div'); div.className = 'card back'; return div; }

  function renderWild() {
    els.wild.innerHTML = '';
    if (!view.wildCard) return;
    const { rank, suit } = view.wildCard;
    const label = document.createElement('div');
    label.className = 'wild-label';
    label.textContent = `桌面癞子牌：手中 ${rank} 为百搭（每局随机变换）`;
    els.wild.appendChild(label);
    const isRed = suit === '♥' || suit === '♦';
    const div = document.createElement('div');
    div.className = `card ${isRed ? 'red' : 'black'} wild`;
    div.innerHTML = `<span class="corner top-left">${rank}<br>${suit}</span><span class="suit">${suit}</span><span class="corner bottom-right">${rank}<br>${suit}</span><span class="wild-badge">癞子</span>`;
    els.wild.appendChild(div);
  }

  function layoutSeats() {
    const idx = [];
    for (let i = 0; i < MAX_SEATS; i++) if (view.players[i]) idx.push(i);
    const posMap = { 2: ['bottom', 'top'], 3: ['bottom', 'left', 'right'], 4: ['bottom', 'right', 'top', 'left'] };
    const positions = posMap[idx.length] || ['bottom', 'top'];
    idx.forEach((seat, k) => { const el = els.players[seat]; el.dataset.pos = positions[k] || 'bottom'; el.hidden = false; });
    for (let i = 0; i < MAX_SEATS; i++) if (!view.players[i]) els.players[i].hidden = true;
  }

  function renderPlayer(i) {
    const p = view.players[i];
    const el = els.players[i];
    if (!p) { el.hidden = true; return; }
    el.hidden = false;
    const handEl = el.querySelector('.hand');
    handEl.innerHTML = '';
    const revealAll = (view.phase === 'reveal' || view.phase === 'result' || view.phase === 'showdown');
    const isMe = view.you && i === view.you.seat;
    p.hand.forEach(card => {
      if (card.back) { handEl.appendChild(renderBack()); return; }
      const cardEl = renderCard(card, !card.hole);
      if (card.hole) {
        if (revealAll) { const t = document.createElement('span'); t.className = 'ming-tag'; t.textContent = '明牌'; cardEl.appendChild(t); }
        else if (isMe && p.hasLooked) { const t = document.createElement('span'); t.className = 'look-tag'; t.textContent = '看牌'; cardEl.appendChild(t); }
      }
      handEl.appendChild(cardEl);
    });
    el.querySelector('.score').textContent = (!p.score) ? '' : p.score;
    el.querySelector('.name').textContent = p.name;
    el.querySelector('.balance b').textContent = p.balance;
    const rb = p.roundBets || [0, 0, 0, 0, 0];
    const rbTotal = rb.reduce((a, b) => a + b, 0);
    el.querySelector('.bet b').textContent = rbTotal;
    const rbEl = el.querySelector('.round-bets');
    const labels = view.roundLabels || ['第3轮', '第4轮', '第5轮', '第6轮', '第7轮'];
    const rn = view.roundNo || 0;
    const rbParts = [];
    for (let r = 0; r < 5; r++) { const v = rb[r] || 0; if (v > 0 || r < rn) rbParts.push(labels[r] + ' ' + v); }
    if (rbParts.length) { rbEl.textContent = rbParts.join(' · '); rbEl.hidden = false; } else { rbEl.textContent = ''; rbEl.hidden = true; }

    const roleEl = el.querySelector('.role');
    const parts = [];
    if (p.isBot) parts.push('🤖 人机');
    else if (p.isHost) parts.push('👑 你');
    if (p.hasLooked) parts.push('👁 已看牌');
    roleEl.textContent = parts.join(' ');
    roleEl.classList.toggle('looked', !!p.hasLooked);

    const tagEl = el.querySelector('.raise-tag');
    const lm = (view.actions && view.actions.lookMultiplier) || 1;
    if (isMe && pendingRaise > 0) {
      const eff = pendingRaise * lm;
      tagEl.textContent = lm > 1 ? `待扔豆 +${pendingRaise}（实际 +${eff}）` : `待扔豆 +${pendingRaise}`;
      tagEl.classList.add('show');
    } else if (p.bet > 0) {
      const eff = p.bet * (p.hasLooked ? 2 : 1);
      tagEl.textContent = `本局扔豆 ${p.bet}${p.hasLooked ? '（已看牌×2）' : ''}`;
      tagEl.classList.add('show');
    } else { tagEl.textContent = ''; tagEl.classList.remove('show'); }

    el.classList.toggle('active', !!p.isTurn);
    el.classList.toggle('folded', !!p.folded);
    el.classList.toggle('revealing', view.phase === 'reveal');
    const won = view.winnerSeat === i && !view.gameRunning && view.phase === 'result';
    el.classList.toggle('winner', won);
    el.querySelector('.winner-badge').classList.toggle('show', won);
  }

  function showMessage(text) { els.message.textContent = text; }

  function render() {
    if (typeof document === 'undefined') return; // 无头测试时跳过 DOM 渲染
    if (!view) return;
    els.pot.textContent = view.pot;
    els.currentBet.textContent = view.currentBet;
    els.round.textContent = view.roundName;
    els.topRoom.textContent = view.room || '单机';

    const rbTotals = view.roundBets || [0, 0, 0, 0, 0];
    const rLabels = view.roundLabels || ['第3轮', '第4轮', '第5轮', '第6轮', '第7轮'];
    const inGame = view.gameRunning || view.phase === 'result' || view.phase === 'showdown' || view.phase === 'reveal';
    if (inGame && els.roundSummary) {
      const seg = [];
      for (let r = 0; r < 5; r++) if ((rbTotals[r] || 0) > 0 || r < (view.roundNo || 0)) seg.push(`${rLabels[r]} ${rbTotals[r] || 0} 颗`);
      els.roundSummary.textContent = '每轮扔豆：' + (seg.length ? seg.join(' · ') : '0 颗');
      els.roundSummary.hidden = false;
    } else if (els.roundSummary) els.roundSummary.hidden = true;

    els.table.hidden = false;
    els.controls.hidden = false;
    els.messageArea.hidden = false;
    els.wild.hidden = (view.phase === 'lobby');
    els.btnRestart.hidden = (view.phase !== 'result');

    layoutSeats();
    for (let i = 0; i < MAX_SEATS; i++) renderPlayer(i);
    renderWild();

    const a = view.actions;
    let msg = view.message || '';
    const lm = (a && a.lookMultiplier) || 1;
    const lookNote = lm > 1 ? `（已看牌×${lm}）` : '';
    if (view.you && view.waitingFor === view.you.seat && a.call) {
      if (a.raise) msg = `轮到你了（你是本轮首个扔豆者）。本轮最低彩豆 ${a.floor} 颗${lookNote}${pendingRaise ? `，当前加颗 +${pendingRaise * lm} 颗` : ''}；点「加颗」每次 +${RAISE_AMOUNT * lm} 颗${lookNote}，点「跟」确认，或「弃牌」。` + (msg ? `（${msg}）` : '');
      else msg = `轮到你了。豆数已锁定，点「跟」补齐 ${a.need} 颗${lookNote}，或「弃牌」。` + (msg ? `（${msg}）` : '');
    }
    showMessage(msg);
    els.btnCall.disabled = !a.call;
    els.btnRaise.disabled = !a.raise;
    els.btnLook.disabled = !a.look;
    els.btnFold.disabled = !a.fold;
  }

  // ================= 人类操作 =================
  function humanCall() {
    if (!humanResolver) return;
    const r = humanResolver; humanResolver = null;
    const pr = pendingRaise; pendingRaise = 0;
    r({ type: 'call', raise: pr });
  }
  function humanFold() {
    if (!humanResolver) return;
    const r = humanResolver; humanResolver = null;
    pendingRaise = 0;
    r({ type: 'fold' });
  }
  function humanLook() {
    if (!room || !view || !view.you) return;
    const me = room.players[view.you.seat];
    if (room.phase.startsWith('bet') && !me.hasLooked) { me.hasLooked = true; render(); }
  }
  function humanRaise() { pendingRaise += RAISE_AMOUNT; render(); }

  // ================= 初始化 =================
  async function startSolo() {
    if (!els.opponentCount) return;
    const opp = parseInt(els.opponentCount.value, 10) || 2;
    room = createRoomState(opp);
    view = buildView(room, 0);
    els.setup.hidden = true;
    await startGame(room);
  }

  if (typeof document !== 'undefined') {
    els = {
      setup: document.getElementById('setup'),
      opponentCount: document.getElementById('opponent-count'),
      btnStartSolo: document.getElementById('btn-start-solo'),
      btnRestart: document.getElementById('btn-restart'),
      table: document.getElementById('table'),
      controls: document.getElementById('controls'),
      messageArea: document.getElementById('message-area'),
      message: document.getElementById('message'),
      pot: document.getElementById('pot'),
      currentBet: document.getElementById('current-bet'),
      round: document.getElementById('round'),
      topRoom: document.getElementById('top-room'),
      wild: document.getElementById('wild'),
      roundSummary: document.getElementById('round-summary'),
      btnCall: document.getElementById('btn-call'),
      btnRaise: document.getElementById('btn-raise'),
      btnLook: document.getElementById('btn-look'),
      btnFold: document.getElementById('btn-fold'),
      players: [
        document.getElementById('player-0'),
        document.getElementById('player-1'),
        document.getElementById('player-2'),
        document.getElementById('player-3')
      ]
    };
    els.btnStartSolo.addEventListener('click', startSolo);
    els.btnRestart.addEventListener('click', startSolo);
    els.btnCall.addEventListener('click', humanCall);
    els.btnFold.addEventListener('click', humanFold);
    els.btnLook.addEventListener('click', humanLook);
    els.btnRaise.addEventListener('click', humanRaise);
    showMessage('选择对手数量后点「开始游戏」。');
  }

  // ================= 无头测试导出 =================
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      createRoomState, startGame, buildView, applyAction, decideBotAction,
      evaluateBest, compareHands,
      playHeadless(opponentCount) {
        room = createRoomState(opponentCount);
        humanAuto = (r, s) => ({ type: 'call', raise: 0 });
        return startGame(room).then(() => ({
          phase: room.phase, winnerSeat: room.winnerSeat, pot: room.pot,
          players: room.players.map(p => p && { name: p.name, isBot: p.isBot, balance: p.balance, folded: p.folded })
        }));
      }
    };
  }
})();
