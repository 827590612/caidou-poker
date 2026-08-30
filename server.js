'use strict';

/*
 * 扑克牌游戏 · 联网服务器（权威游戏主机）
 * 纯 Node 原生 http + SSE，无外部依赖。运行：node server.js
 *
 *  - 服务器持有全部状态并运行游戏主循环；浏览器只是「视图 + 输入」终端。
 *  - 账号：手机号 + 密码注册，每人一个不重复的 6 位玩家编码。
 *  - 私密性：每个客户端只收到自己座位的暗牌，他人暗牌永远不下发。
 *  - 人数：2~4 人，全部「准备」后房主才能开始。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = __dirname;
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');

// ---------- 牌面配置 ----------
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
const MAX_SEATS = 4;   // 最多 4 个座位
const MIN_PLAYERS = 2; // 最少 2 人即可开局

// 人机（电脑玩家）名字池
const BOT_NAMES = ['人机·小彩', '人机·豆豆', '人机·阿彩', '人机·彩彩', '人机·豆宝', '人机·幸运星'];

// ---------- 工具 ----------
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
  for (const suit of SUITS) {
    for (const rank of RANKS) cards.push({ suit, rank, id: `${rank}${suit}` });
  }
  return shuffle(cards);
}

function newToken() { return crypto.randomBytes(12).toString('hex'); }

// ---------- 牌型评估 ----------
function cardScore(card) { return SCORE_MAP[card.rank]; }
function cardRankValue(card) { return RANK_ORDER[card.rank]; }

function compareCards(a, b) {
  const ra = cardRankValue(a);
  const rb = cardRankValue(b);
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
      for (let t = 0; t < k; t++) {
        all[wildIdx[t]] = { suit: all[wildIdx[t]].suit, rank: assign[t] };
      }
      const ev = evaluateHand(all);
      if (!best || ev.category > best.category ||
        (ev.category === best.category && ev.score > best.score)) {
        best = { ...ev, usedWild: true };
      }
      return;
    }
    for (const r of candidateRanks) {
      assign[depth] = r;
      rec(depth + 1);
    }
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
    const sa = SCORE_MAP[a.hand[i].rank];
    const sb = SCORE_MAP[b.hand[i].rank];
    if (sa !== sb) return sa - sb;
  }
  for (const i of [0, 1]) {
    const sa = SCORE_MAP[a.hand[i].rank];
    const sb = SCORE_MAP[b.hand[i].rank];
    if (sa !== sb) return sa - sb;
  }
  return 0;
}

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

// ================= 账号系统 =================
let accounts = {};           // phone -> { code, phone, salt, hash, nickname, createdAt }
const codeSet = new Set();   // 已占用的玩家编码，保证不重复
const sessions = new Map();  // token -> phone

function loadAccounts() {
  try {
    const raw = fs.readFileSync(ACCOUNTS_FILE, 'utf8');
    accounts = JSON.parse(raw) || {};
  } catch (e) { accounts = {}; }
  codeSet.clear();
  for (const a of Object.values(accounts)) if (a.code) codeSet.add(a.code);
}
function saveAccounts() {
  try { fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), 'utf8'); }
  catch (e) { console.error('保存账号失败:', e.message); }
}
loadAccounts();

function genPlayerCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混字符
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += chars[randInt(chars.length)];
  } while (codeSet.has(code));
  codeSet.add(code);
  return code;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

function validatePhone(phone) { return /^1\d{10}$/.test(String(phone || '').trim()); }

function accountPublic(a) {
  return { phone: a.phone, code: a.code, nickname: a.nickname };
}

// ================= 房间 =================
const rooms = new Map();

function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[randInt(chars.length)];
  } while (rooms.has(code));
  return code;
}

function createRoom() {
  const code = genRoomCode();
  const room = {
    code,
    players: new Array(MAX_SEATS).fill(null),
    hostSeat: null,
    phase: 'lobby',
    deck: [],
    pot: 0,
    currentBet: 0,
    prevRoundBet: 0,
    wildCard: null,
    turn: -1,
    waitingFor: -1,
    message: '等待玩家加入并准备…',
    gameRunning: false,
    winnerSeat: -1,
    awaitingAction: null,
    awaitTimer: null
  };
  rooms.set(code, room);
  return room;
}

function seated(room) { return room.players.filter(Boolean); }
function humanSeated(room) { return room.players.filter(p => p && !p.isBot); }
function botSeated(room) { return room.players.filter(p => p && p.isBot); }
function allReady(room) {
  const ps = seated(room);
  return ps.length >= MIN_PLAYERS && ps.every(p => p.ready);
}
function resetReady(room) {
  // 名单变动时清空真人的准备状态，要求重新准备；人机永远处于「已准备」
  for (const p of room.players) if (p && !p.isBot) p.ready = false;
}

// ---------- 人机 ----------
function botNameTaken(room, name) {
  return room.players.some(p => p && p.isBot && p.name === name);
}

// 往空座位添加一个人机（返回座位号，没有空位返回 -1）
function addBot(room) {
  const seat = room.players.findIndex(p => !p);
  if (seat < 0) return -1;
  let name = BOT_NAMES[randInt(BOT_NAMES.length)];
  let guard = 0;
  while (botNameTaken(room, name) && guard++ < 20) name = BOT_NAMES[randInt(BOT_NAMES.length)];
  room.players[seat] = {
    id: seat,
    phone: null,
    code: 'BOT' + (seat + 1),
    name,
    seatToken: newToken(),
    balance: START_BALANCE,
    hand: [],
    bet: 0,
    folded: false,
    hasLooked: false,
    ready: true,          // 人机自动准备
    connected: true,      // 人机永远在线
    sse: null,
    isBot: true           // 服务器自动代打
  };
  return seat;
}

// 补满所有空座位
function fillBots(room) {
  let n = 0;
  while (seated(room).length < MAX_SEATS && addBot(room) >= 0) n++;
  return n;
}

// 移除全部人机
function removeBots(room) {
  let n = 0;
  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[i];
    if (p && p.isBot) {
      if (room.hostSeat === i) room.hostSeat = null;
      room.players[i] = null;
      n++;
    }
  }
  if (room.hostSeat === null) {
    const h = humanSeated(room)[0];
    room.hostSeat = h ? h.id : null;
  }
  return n;
}

// 按账号分配座位：已在该房间则回收原座位（修复「加入后不可再次进入」）
function seatPlayer(room, account) {
  const existing = room.players.findIndex(p => p && p.phone === account.phone);
  if (existing >= 0) {
    const p = room.players[existing];
    // 旧连接（原页面）被顶下线，避免出现两个可操作的页面
    if (p.sse) {
      try { p.sse.write('data: {"kicked":true,"reason":"other"}\n\n'); } catch (e) {}
      p.sse = null;
      p.connected = false;
    }
    p.name = account.nickname;
    p.code = account.code;
    p.seatToken = newToken(); // 旧 seatToken 失效，新连接接管座位
    resetReady(room);
    return { seat: existing, seatToken: p.seatToken, isHost: existing === room.hostSeat, reclaimed: true };
  }
  let seat = room.players.findIndex(p => !p);
  // 座位被人机占满时，真人优先：顶掉最后一个人机
  if (seat < 0) {
    let botSeat = -1;
    for (let i = 0; i < room.players.length; i++) {
      if (room.players[i] && room.players[i].isBot) botSeat = i;
    }
    if (botSeat < 0) return null;
    if (room.hostSeat === botSeat) room.hostSeat = null;
    room.players[botSeat] = null;
    seat = botSeat;
  }
  room.players[seat] = {
    id: seat,
    phone: account.phone,
    code: account.code,
    name: account.nickname,
    seatToken: newToken(),
    balance: START_BALANCE,
    hand: [],
    bet: 0,
    folded: false,
    hasLooked: false,
    ready: false,
    connected: false,
    sse: null,
    isBot: false
  };
  if (room.hostSeat === null) room.hostSeat = seat;
  resetReady(room);
  return { seat, seatToken: room.players[seat].seatToken, isHost: seat === room.hostSeat, reclaimed: false };
}

function removePlayer(room, seat) {
  const p = room.players[seat];
  if (!p) return;
  if (p.sse) { try { p.sse.write('data: {"kicked":true}\n\n'); } catch (e) {} }
  room.players[seat] = null;
  if (room.hostSeat === seat) {
    const h = humanSeated(room)[0];
    room.hostSeat = h ? h.id : null;
  }
  resetReady(room);
  // 真人全部离开后房间直接回收（人机没有意义自己留着）
  if (humanSeated(room).length === 0) rooms.delete(room.code);
}

function getBetLeaderSeat(room, cardIndex, smallestFirst) {
  const active = seated(room).filter(p => !p.folded);
  if (active.length === 0) return 0;
  if (smallestFirst) {
    let leader = active[0];
    let leaderScore = SCORE_MAP[active[0].hand[cardIndex].rank];
    for (const p of active) {
      const s = SCORE_MAP[p.hand[cardIndex].rank];
      if (s < leaderScore) { leader = p; leaderScore = s; }
    }
    return leader.id;
  }
  let leader = active[0];
  let leaderCard = active[0].hand[cardIndex];
  for (const p of active) {
    if (compareCards(p.hand[cardIndex], leaderCard) > 0) {
      leader = p; leaderCard = p.hand[cardIndex];
    }
  }
  return leader.id;
}

function allMatchedOrFolded(room) {
  const active = seated(room).filter(p => !p.folded);
  if (active.length <= 1) return true;
  return active.every(p => p.bet === room.currentBet);
}

function checkSingleActive(room) {
  return seated(room).filter(p => !p.folded).length <= 1;
}

function setMessage(room, text) { room.message = text; }

// ================= 视图（按客户端裁剪，保证私密） =================
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
        else visible = false; // 他人的暗牌永远不下发
      }
      if (!visible) return { back: true, hole: true };
      return { suit: card.suit, rank: card.rank, hole: isHole };
    });

    let score = '';
    if (revealAll && !p.folded) {
      const ev = evaluateBest(p.hand, room.wildCard);
      const wildNote = (ev.usedWild && room.wildCard) ? `（含癞子：${room.wildCard.rank}百搭）` : '';
      score = `${ev.desc} · ${ev.score}分${wildNote}`;
    } else if (p.folded) {
      score = '已弃牌';
    }

    return {
      id: i,
      name: p.name,
      code: p.code,
      connected: p.connected,
      isHost: i === room.hostSeat,
      balance: p.balance,
      bet: p.bet,
      roundBets: (p.betHistory || [0, 0, 0, 0, 0]).slice(), // 每一轮扔豆
      folded: p.folded,
      hasLooked: p.hasLooked,
      ready: p.ready,
      isBot: !!p.isBot,
      isTurn: room.turn === i,
      hand,
      score
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
    // 客户端显示的 need/floor 已按乘数放大，展示的是「实际要扔多少颗」
    actions = {
      call: true, raise: canRaise, fold: true, look: !me.hasLooked,
      need: baseNeed * lookMultiplier,
      floor: baseFloor * lookMultiplier,
      lookMultiplier
    };
  }

  const readyOk = ps.length >= MIN_PLAYERS && ps.every(p => p.ready);
  const isHost = room.hostSeat === seat;
  const lobbyPhase = !room.gameRunning && (room.phase === 'lobby' || room.phase === 'result');

  return {
    room: room.code,
    phase: room.phase,
    roundName: roundNames[room.phase] || room.phase,
    pot: room.pot,
    currentBet: room.currentBet,
    roundBets: (room.roundBets || [0, 0, 0, 0, 0]).slice(), // 每一轮全员扔豆总额
    roundNo: room.roundNo || 0, // 当前所在轮次（1~5，0=未开始）
    roundLabels: ['第3轮', '第4轮', '第5轮', '第6轮', '第7轮'],
    message: room.message,
    turn: room.turn,
    waitingFor: room.waitingFor,
    winnerSeat: room.winnerSeat,
    wildCard: room.wildCard ? { rank: room.wildCard.rank, suit: room.wildCard.suit } : null,
    you: me
      ? { seat, name: me.name, code: me.code, isHost: seat === room.hostSeat, ready: me.ready }
      : null,
    players,
    filled: ps.length,
    minPlayers: MIN_PLAYERS,
    maxSeats: MAX_SEATS,
    allReady: readyOk,
    gameRunning: room.gameRunning,
    canStart: isHost && !room.gameRunning && readyOk &&
      (room.phase === 'lobby' || room.phase === 'result'),
    // 人机：大厅/结算阶段，房间内任何真人玩家都可以添加或移除
    botCount: botSeated(room).length,
    botMax: MAX_SEATS - ps.length,
    canAddBot: Boolean(me && !me.isBot) && lobbyPhase && ps.length < MAX_SEATS,
    canRemoveBot: Boolean(me && !me.isBot) && lobbyPhase && botSeated(room).length > 0,
    actions
  };
}

function broadcast(room) {
  for (const p of room.players) {
    if (p && p.sse) {
      try { p.sse.write(`data: ${JSON.stringify(buildView(room, p.id))}\n\n`); }
      catch (e) { /* ignore */ }
    }
  }
}

// ================= 人机决策 =================
/*
 * 人机策略（服务器代打）：
 *  1. 先按自己的牌力评估强度（0~1），牌力够强才「看牌」，因为看牌后扔的彩豆翻倍；
 *  2. 需要补齐的彩豆越多、牌力越弱，弃牌概率越高；
 *  3. 牌力强时主动加颗，弱牌只跟颗。
 * 每次决策都会叠加随机性，避免多个人机行为完全一样。
 */
function botStrength(room, p) {
  const ev = evaluateBest(p.hand, room.wildCard);
  const n = Math.max(1, p.hand.length);
  const avg = ev.score / n;                 // 每张牌的平均分值，约 2~15
  // 以「随机牌均值 8.1」为中心的 S 曲线，普通牌约 0.34，好牌可达 0.6+
  const norm = 1 / (1 + Math.exp(-(avg - 8.1) / 1.3));
  let s = (ev.category / 5) * 0.45 + norm * 0.55;
  return Math.max(0, Math.min(1, s));
}

function decideBotAction(room, p) {
  let strength = botStrength(room, p);
  strength = Math.max(0, Math.min(1, strength + (Math.random() - 0.5) * 0.18));

  // 是否看牌：牌力中等以上才看（看牌后彩豆翻倍）
  if (!p.hasLooked) {
    const wantLook = strength >= 0.44 ||
      (p.hand.length >= 5 && strength >= 0.4) ||
      Math.random() < 0.12;
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

  // 弃牌判断：牌力弱 + 要补的彩豆占余额比例高 → 倾向弃牌
  if (!canRaise && cost > 0) {
    const pressure = Math.min(1, cost / Math.max(1, p.balance * 0.12));
    const foldChance = Math.max(0, (0.34 - strength) * 1.3 + pressure * 0.25);
    if (Math.random() < foldChance) return { type: 'fold' };
  }

  // 加颗判断
  let raise = 0;
  if (canRaise) {
    if (strength > 0.56) raise = RAISE_AMOUNT * (1 + randInt(2));
    else if (strength > 0.42 && Math.random() < 0.45) raise = RAISE_AMOUNT;
  } else if (strength > 0.6 && Math.random() < 0.35) {
    raise = RAISE_AMOUNT; // 强牌偶尔反加
  }
  return { type: 'call', raise };
}

// ================= 游戏流程 =================
function awaitAction(room, seat) {
  const player = room.players[seat];
  // 人机：服务器直接代打，先停顿一下模拟思考
  if (player && player.isBot) {
    return (async () => {
      await sleep(600 + randInt(900));
      if (!room.players[seat] || room.players[seat] !== player) return { type: 'fold' };
      return decideBotAction(room, player);
    })();
  }
  return new Promise((resolve) => {
    if (room.awaitTimer) clearTimeout(room.awaitTimer);
    room.awaitingAction = { seat, resolve };
    room.awaitTimer = setTimeout(() => {
      if (room.awaitingAction && room.awaitingAction.seat === seat) {
        room.awaitingAction = null;
        setMessage(room, `${room.players[seat].name} 长时间未操作，自动弃牌。`);
        resolve({ type: 'fold' });
      }
    }, 90000);
  });
}

async function applyAction(room, player, action) {
  if (action.type === 'fold') {
    player.folded = true;
    setMessage(room, `${player.name} 弃牌了。`);
    return;
  }

  // 看牌倍率：若所有未弃牌玩家都已看牌则回到 1 倍（全员看牌则豆数相同）；
  // 只有「部分看牌部分没看牌」时，看牌方才翻倍。
  const allActiveLooked = seated(room).filter(p => !p.folded).every(p => p.hasLooked);
  const lookMultiplier = (player.hasLooked && !allActiveLooked) ? 2 : 1;

  // player.bet / room.currentBet 存储「基础金额」（未看牌的金额），
  // 实际扣除 = 基础差额 × lookMultiplier
  let totalBet;
  if (room.currentBet === 0) {
    const floor = Math.max(MIN_BET, room.prevRoundBet);
    totalBet = floor + (action.raise || 0);
  } else {
    totalBet = room.currentBet + (action.raise || 0);
  }
  let basePay = totalBet - player.bet;
  let effectivePay = basePay * lookMultiplier;

  // 余额不足时按实际支付能力折算（但不修改基础金额，只扣到余额归零）
  if (effectivePay > player.balance) {
    if (player.balance > 0) {
      // 余额只能覆盖部分实际支付：按基础差额等比例缩减
      const maxBasePay = Math.floor(player.balance / lookMultiplier);
      basePay = Math.max(0, maxBasePay);
      effectivePay = basePay * lookMultiplier;
      totalBet = player.bet + basePay;
    } else {
      player.folded = true;
      setMessage(room, `${player.name} 余额不足，弃牌。`);
      return;
    }
  }

  player.balance -= effectivePay;
  player.bet = totalBet; // 仍以基础金额记录
  if (totalBet > room.currentBet) room.currentBet = totalBet;
  room.pot += effectivePay; // 底池按实际支付累加

  // 记录「每一轮扔豆数量」
  const roundMap = { bet1: 1, bet2: 2, bet3: 3, bet4: 4, bet5: 5 };
  const rn = roundMap[room.phase] || 0;
  if (rn > 0) {
    if (!player.betHistory) player.betHistory = [0, 0, 0, 0, 0];
    if (!room.roundBets) room.roundBets = [0, 0, 0, 0, 0];
    player.betHistory[rn - 1] += effectivePay;
    room.roundBets[rn - 1] += effectivePay;
  }

  // 消息统一展示实际支付金额
  const hint = lookMultiplier > 1 ? `（已看牌×${lookMultiplier}，实际扔 ${effectivePay} 颗）` : '';

  if ((action.raise || 0) > 0) {
    setMessage(room, `${player.name} 加颗到 ${totalBet} 颗${hint}（本局累计 ${player.bet} 颗）。`);
  } else if (room.currentBet > 0 && player.bet === room.currentBet) {
    setMessage(room, `${player.name} 跟颗了 ${effectivePay} 颗${hint}（本局累计 ${player.bet} 颗）。`);
  } else {
    setMessage(room, `${player.name} 扔豆 ${effectivePay} 颗${hint}。`);
  }
}

function dealToAll(room, count) {
  for (let r = 0; r < count; r++) {
    for (const p of room.players) {
      if (!p) continue;
      if (room.deck.length === 0) return;
      p.hand.push(room.deck.pop());
    }
  }
}

// 跳过空座位，支持 2~4 人
function nextSeat(room, from) {
  for (let i = 1; i <= MAX_SEATS; i++) {
    const s = (from + i) % MAX_SEATS;
    if (room.players[s]) return s;
  }
  return from;
}

async function runBettingRound(room, cardIndex, smallestFirst) {
  let turn = getBetLeaderSeat(room, cardIndex, smallestFirst);
  room.turn = turn;
  const acted = new Set(); // 跟踪本轮已行动的座位，保证所有人都轮过一次后才检查退出
  while (true) {
    const active = seated(room).filter(p => !p.folded);
    if (active.length <= 1) break;

    const p = room.players[turn];
    if (p && !p.folded && !(room.currentBet > 0 && p.bet === room.currentBet)) {
      room.turn = turn;
      room.waitingFor = turn;
      broadcast(room);
      const action = await awaitAction(room, turn);
      if (room.awaitTimer) clearTimeout(room.awaitTimer);
      room.waitingFor = -1;
      await applyAction(room, p, action);
      acted.add(turn);
      broadcast(room);
      await sleep(450);
    }
    // 所有未弃牌玩家都至少行动过一次后，再检查全匹配退出
    const allActed = active.every(p => acted.has(p.id));
    if (allActed && allMatchedOrFolded(room)) break;
    turn = nextSeat(room, turn);
  }
  room.prevRoundBet = room.currentBet;
  room.currentBet = 0;
  for (const p of room.players) if (p) p.bet = 0;
  room.turn = -1;
  room.waitingFor = -1;
  broadcast(room);
}

async function endGame(room) {
  const active = seated(room).filter(p => !p.folded);
  let best = active[0];
  for (const p of active.slice(1)) {
    if (compareHands(p, best, room.wildCard) > 0) best = p;
  }
  const bestEv = evaluateBest(best.hand, room.wildCard);

  room.phase = 'showdown';
  room.winnerSeat = best.id;
  room.message = active.length === 1
    ? `${best.name} 赢！其他人都弃牌了`
    : `比大小！${best.name} 以 ${bestEv.desc}（${bestEv.score} 颗）胜出`;
  broadcast(room);
  await sleep(5000);

  const settledPot = room.pot;
  best.balance += room.pot;
  // 赢家每局扣除 10 颗（赢家税）
  const WINNER_TAX = 10;
  best.balance -= WINNER_TAX;
  for (const p of room.players) if (p) p.bet = 0;
  room.pot = 0;
  room.phase = 'result';
  room.gameRunning = false;
  room.winnerSeat = best.id;
  room.message = `${best.name} 赢得彩豆 ${settledPot} 颗（赢家扣 ${WINNER_TAX} 颗）！` +
    (active.length === 1 ? '（其他人全部弃牌）' : '');
  // 下一局需要重新准备（人机保持已准备）
  for (const p of room.players) if (p && !p.isBot) p.ready = false;
  broadcast(room);
}

async function startGame(room) {
  const ps = seated(room);
  if (room.gameRunning) return;
  if (ps.length < MIN_PLAYERS || ps.length > MAX_SEATS) return;
  if (!ps.every(p => p.ready)) return;

  room.gameRunning = true;
  room.deck = createDeck();
  room.pot = 0;
  room.currentBet = 0;
  room.prevRoundBet = 0;
  room.winnerSeat = -1;

  for (const p of ps) {
    p.balance = START_BALANCE;
    p.hand = [];
    p.bet = 0;
    p.betHistory = [0, 0, 0, 0, 0]; // 每一轮实际扔豆数量（第3~7轮）
    p.folded = false;
    p.hasLooked = false;
  }
  room.roundBets = [0, 0, 0, 0, 0]; // 每一轮全员扔豆总额
  room.roundNo = 0;

  if (room.deck.length > 0) room.wildCard = room.deck.pop();
  for (const p of ps) { p.balance -= ANTE; room.pot += ANTE; }

  dealToAll(room, 2);
  dealToAll(room, 1);
  room.phase = 'bet1';
  setMessage(room, `开局！${ps.length} 人对局，每人 ${START_BALANCE} 颗、底注 ${ANTE} 颗；癞子牌点数 ${room.wildCard.rank} 为百搭。第 3 张明牌最大者先说话。`);
  broadcast(room);

  await runBettingRound(room, 2, false);
  if (checkSingleActive(room)) { await endGame(room); return; }

  room.phase = 'deal4';
  dealToAll(room, 1);
  room.phase = 'bet2';
  setMessage(room, '第 4 张明牌已发，第 4 张明牌分值最大者先扔豆。');
  broadcast(room);
  await runBettingRound(room, 3, false);
  if (checkSingleActive(room)) { await endGame(room); return; }

  room.phase = 'deal5';
  dealToAll(room, 1);
  room.phase = 'bet3';
  setMessage(room, '第 5 张明牌已发，结束摸牌。第 5 张明牌最大者先扔豆。');
  broadcast(room);
  await runBettingRound(room, 4, false);
  if (checkSingleActive(room)) { await endGame(room); return; }

  room.phase = 'bet4';
  setMessage(room, '第 6 轮扔豆：以第 5 张明牌分值比较，分值最小者先扔豆。');
  broadcast(room);
  await runBettingRound(room, 4, true);
  if (checkSingleActive(room)) { await endGame(room); return; }

  room.phase = 'bet5';
  setMessage(room, '第 7 轮扔豆：以第 5 张明牌分值比较，分值最小者先扔豆。');
  broadcast(room);
  await runBettingRound(room, 4, true);
  if (checkSingleActive(room)) { await endGame(room); return; }

  room.phase = 'reveal';
  room.turn = -1;
  setMessage(room, '亮牌！准备比大小…');
  broadcast(room);
  await sleep(5000);
  await endGame(room);
}

// ================= HTTP / SSE =================
function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { resolve({}); }
    });
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
    fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    // 关键：实时文件关闭浏览器缓存，确保客户端永远拿到最新版（否则改了 game.js 仍显示旧逻辑）
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.end(buf);
  });
}

function phoneOf(reqToken) {
  return sessions.get(String(reqToken || '')) || null;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const pathname = u.pathname;

  if (req.method === 'GET' && !pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  if (pathname === '/api/info' && req.method === 'GET') {
    return sendJson(res, 200, { lanIp: getLanIp(), port: PORT, minPlayers: MIN_PLAYERS, maxSeats: MAX_SEATS });
  }

  // ---------- 注册 ----------
  if (pathname === '/api/register' && req.method === 'POST') {
    const b = await readBody(req);
    const phone = String(b.phone || '').trim();
    const password = String(b.password || '');
    const nickname = String(b.nickname || '').trim().slice(0, 12);
    if (!validatePhone(phone)) return sendJson(res, 400, { error: '请输入正确的 11 位手机号' });
    if (password.length < 6) return sendJson(res, 400, { error: '密码至少 6 位' });
    if (!nickname) return sendJson(res, 400, { error: '请输入昵称' });
    if (accounts[phone]) return sendJson(res, 400, { error: '该手机号已注册，请直接登录' });

    const salt = crypto.randomBytes(16).toString('hex');
    const code = genPlayerCode();
    accounts[phone] = {
      phone, code, nickname, salt,
      hash: hashPassword(password, salt),
      createdAt: new Date().toISOString()
    };
    saveAccounts();
    const token = newToken();
    sessions.set(token, phone);
    console.log(`[注册] ${phone} 编码 ${code} 昵称 ${nickname}`);
    return sendJson(res, 200, { ok: true, token, ...accountPublic(accounts[phone]) });
  }

  // ---------- 登录 ----------
  if (pathname === '/api/login' && req.method === 'POST') {
    const b = await readBody(req);
    const phone = String(b.phone || '').trim();
    const password = String(b.password || '');
    if (!validatePhone(phone)) return sendJson(res, 400, { error: '请输入正确的 11 位手机号' });
    const acc = accounts[phone];
    if (!acc) return sendJson(res, 404, { error: '该手机号未注册' });
    if (hashPassword(password, acc.salt) !== acc.hash) return sendJson(res, 401, { error: '密码错误' });
    const token = newToken();
    sessions.set(token, phone);
    return sendJson(res, 200, { ok: true, token, ...accountPublic(acc) });
  }

  // ---------- 会话校验 ----------
  if (pathname === '/api/me') {
    const token = req.method === 'GET' ? u.searchParams.get('token') : (await readBody(req)).token;
    const phone = phoneOf(token);
    if (!phone || !accounts[phone]) return sendJson(res, 401, { error: '登录已失效，请重新登录' });
    return sendJson(res, 200, { ok: true, token, ...accountPublic(accounts[phone]) });
  }

  // ---------- 创建房间 ----------
  if (pathname === '/api/create' && req.method === 'POST') {
    const b = await readBody(req);
    const phone = phoneOf(b.token);
    if (!phone || !accounts[phone]) return sendJson(res, 401, { error: '请先登录' });
    const room = createRoom();
    const info = seatPlayer(room, accounts[phone]);
    return sendJson(res, 200, { ok: true, room: room.code, ...info, ...accountPublic(accounts[phone]) });
  }

  // ---------- 加入房间 ----------
  if (pathname === '/api/join' && req.method === 'POST') {
    const b = await readBody(req);
    const phone = phoneOf(b.token);
    if (!phone || !accounts[phone]) return sendJson(res, 401, { error: '请先登录' });
    const room = rooms.get(String(b.room || '').toUpperCase());
    if (!room) return sendJson(res, 404, { error: '房间不存在' });
    const acc = accounts[phone];

    // 已在别的房间且未开局：先腾出那个座位，避免一个账号占多个座位
    for (const r of rooms.values()) {
      if (r === room) continue;
      const idx = r.players.findIndex(p => p && p.phone === phone);
      if (idx >= 0) {
        if (r.gameRunning) return sendJson(res, 400, { error: '你正在另一个房间游戏中，请先离开' });
        removePlayer(r, idx);
        broadcast(r);
      }
    }

    const info = seatPlayer(room, acc);
    if (!info) return sendJson(res, 400, { error: `房间已满（最多 ${MAX_SEATS} 人）` });
    broadcast(room);
    return sendJson(res, 200, { ok: true, room: room.code, ...info, ...accountPublic(acc) });
  }

  if (pathname === '/api/state' && req.method === 'GET') {
    const room = rooms.get((u.searchParams.get('room') || '').toUpperCase());
    const seat = parseInt(u.searchParams.get('seat') || '-1', 10);
    if (!room || !room.players[seat]) return sendJson(res, 404, { error: '无效座位' });
    return sendJson(res, 200, buildView(room, seat));
  }

  if (pathname === '/api/stream' && req.method === 'GET') {
    const room = rooms.get((u.searchParams.get('room') || '').toUpperCase());
    const seat = parseInt(u.searchParams.get('seat') || '-1', 10);
    const seatToken = u.searchParams.get('seatToken') || '';
    if (!room || !room.players[seat] || room.players[seat].seatToken !== seatToken) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write('retry: 2000\n\n');
    const player = room.players[seat];
    player.sse = res;
    player.connected = true;
    broadcast(room);

    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (e) {} }, 25000);
    req.on('close', () => {
      clearInterval(hb);
      if (player.sse === res) { player.sse = null; player.connected = false; }
      broadcast(room);
    });
    return;
  }

  if (pathname === '/api/action' && req.method === 'POST') {
    const b = await readBody(req);
    const room = rooms.get((b.room || '').toUpperCase());
    const rawSeat = (b.seat === undefined || b.seat === null) ? '-1' : String(b.seat);
    const seat = parseInt(rawSeat, 10);
    if (!room || !room.players[seat] || room.players[seat].seatToken !== b.seatToken) {
      return sendJson(res, 403, { error: '座位身份已失效，请重新进入房间' });
    }
    const player = room.players[seat];
    const action = b.action || {};

    if (action.type === 'ready' || action.type === 'unready') {
      if (!room.gameRunning && (room.phase === 'lobby' || room.phase === 'result')) {
        player.ready = (action.type === 'ready');
        broadcast(room);
      }
      return sendJson(res, 200, { ok: true });
    }

    if (action.type === 'leave') {
      if (!room.gameRunning) {
        removePlayer(room, seat);
        broadcast(room);
      }
      return sendJson(res, 200, { ok: true });
    }

    // ---------- 人机 ----------
    // 房间内任何已入座的真人玩家都可以添加 / 移除人机，方便随时凑人开局
    if (action.type === 'addBot' || action.type === 'fillBot' || action.type === 'removeBot') {
      const me = room.players[seat];
      if (!me || me.isBot) return sendJson(res, 403, { error: '无效座位' });
      if (room.gameRunning || (room.phase !== 'lobby' && room.phase !== 'result')) {
        return sendJson(res, 400, { error: '游戏中无法调整人机' });
      }
      if (action.type === 'addBot') {
        const s = addBot(room);
        if (s < 0) return sendJson(res, 400, { error: '座位已满' });
        setMessage(room, `${room.players[s].name} 加入房间（人机）。`);
      } else if (action.type === 'fillBot') {
        const n = fillBots(room);
        if (n === 0) return sendJson(res, 400, { error: '座位已满，没有空位了' });
        setMessage(room, `已补入 ${n} 个人机，凑满 ${seated(room).length} 个座位。`);
      } else {
        const n = removeBots(room);
        if (n === 0) return sendJson(res, 400, { error: '房间里没有人机' });
        setMessage(room, `已移除 ${n} 个人机。`);
      }
      broadcast(room);
      return sendJson(res, 200, { ok: true });
    }

    if (action.type === 'start') {
      const ps = seated(room);
      if (seat === room.hostSeat && !room.gameRunning && ps.length >= MIN_PLAYERS && ps.every(p => p.ready)) {
        console.log(`[房间 ${room.code}] 开局，${ps.length} 人`);
        startGame(room).catch(e => console.error('[startGame 错误]', e));
      }
      return sendJson(res, 200, { ok: true });
    }

    if (action.type === 'look') {
      if (room.phase.startsWith('bet') && !player.hasLooked) {
        player.hasLooked = true;
        broadcast(room);
      }
      return sendJson(res, 200, { ok: true });
    }

    if (action.type === 'call' || action.type === 'fold') {
      if (room.awaitingAction && room.awaitingAction.seat === seat) {
        const resolve = room.awaitingAction.resolve;
        room.awaitingAction = null;
        if (room.awaitTimer) clearTimeout(room.awaitTimer);
        resolve(action);
      }
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 400, { error: '未知动作' });
  }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLanIp();
  console.log('==================================================');
  console.log('  扑克牌联网服务器已启动');
  console.log(`  本机访问:   http://localhost:${PORT}`);
  console.log(`  局域网地址: http://${ip}:${PORT}`);
  console.log(`  支持 ${MIN_PLAYERS}~${MAX_SEATS} 人，全部准备后房主开始`);
  console.log('==================================================');
});
