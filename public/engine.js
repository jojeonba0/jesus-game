// 예수님 게임 엔진: 규칙 + 요청 처리.
// Vercel 함수(api/action.js)와 브라우저 미리보기(preview.html)가 같은 코드를 씁니다.
(function (root) {
  'use strict';

  const ROLES = {
    jesus: { name: '예수님', team: 'jesus' },
    disciple: { name: '제자', team: 'jesus' },
    pharisee: { name: '바리새인', team: 'pharisee' },
    traitor: { name: '배신자', team: 'traitor' },
  };
  const ALIASES = ['어린양', '비둘기', '올리브', '무화과', '포도나무', '겨자씨', '등불', '물고기', '빵', '항아리',
    '종려나무', '돌판', '지팡이', '두루마리', '샘물', '들꽃', '참새', '목자', '나귀', '백합', '향유', '그물', '반석', '별',
    '구름', '바람', '소금', '열매', '씨앗', '우물', '언덕', '나룻배', '감람산', '요단강', '광야', '등잔', '새벽', '이슬'];
  const CHAT_KEYS = ['jesus', 'pharisee', 'traitor'];
  const CHAT_NAMES = { jesus: '예수님과 제자들의 방', pharisee: '바리새인의 방', traitor: '배신자의 방' };
  const WIN_TEXT = { jesus: '예수님과 제자들의 승리!', pharisee: '바리새인의 승리!', traitor: '배신자의 승리!' };
  const MAX_PLAYERS = 40, MAX_CHAT = 300, ONLINE_MS = 12000;
  const NOCHANGE = '__nochange__';

  const C = (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.getRandomValues)
    ? globalThis.crypto : require('crypto').webcrypto;
  function randInt(n) { const a = new Uint32Array(1); C.getRandomValues(a); return a[0] % n; }
  function rid(n = 16) { const a = new Uint8Array(n); C.getRandomValues(a); return Array.from(a, b => b.toString(16).padStart(2, '0')).join(''); }
  const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  function newCode() { let s = ''; for (let i = 0; i < 4; i++) s += CODE_CHARS[randInt(CODE_CHARS.length)]; return s; }
  function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = randInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; }

  /* ---------------- 규칙 ---------------- */
  function createRoom(code) {
    return {
      code, adminToken: rid(), created: Date.now(),
      status: 'lobby', phase: 'day', round: 0, capacity: null, // 총 인원 (null = 제한 없음, 최대 40)
      traitorRooms: ['traitor'],
      players: [], // {pid, token, name, role, alive, aliases:{방: 익명}}
      chats: { jesus: [], pharisee: [], traitor: [] },
      vote: null, winner: null, log: [],
    };
  }
  function chatRoomsOf(room, p) {
    if (!p.role) return [];
    if (p.role === 'traitor') return CHAT_KEYS.filter(k => (room.traitorRooms || ['traitor']).includes(k));
    return [ROLES[p.role].team];
  }
  function activeChatKeys(room) { return CHAT_KEYS.filter(k => room.players.some(p => chatRoomsOf(room, p).includes(k))); }
  function addLog(room, text) { room.log.push({ ts: Date.now(), round: room.round, text }); if (room.log.length > 300) room.log.shift(); }
  function checkWinner(room) {
    const alive = room.players.filter(p => p.alive);
    const count = r => alive.filter(p => p.role === r).length;
    if (!count('jesus')) return 'pharisee';
    if (!count('pharisee') && !count('traitor')) return 'jesus';
    if (!count('pharisee') && !count('disciple') && count('traitor') > 0) return 'traitor';
    return null;
  }
  function afterElimination(room) {
    const w = checkWinner(room);
    if (w) { room.status = 'ended'; room.winner = w; room.vote = null; addLog(room, `🏁 ${WIN_TEXT[w]}`); }
  }

  /* ---------------- 화면용 데이터 ---------------- */
  const isOn = (seen, pid) => !!seen && Date.now() - (+seen[pid] || 0) < ONLINE_MS;
  function adminView(room, ver, seen) {
    const nameOf = pid => (room.players.find(p => p.pid === pid) || {}).name;
    return {
      t: 'state', as: 'admin', v: ver, code: room.code, status: room.status, phase: room.phase, round: room.round, capacity: room.capacity || null,
      traitorRooms: room.traitorRooms || ['traitor'], chatKeys: activeChatKeys(room), winner: room.winner,
      players: room.players.map(p => ({ pid: p.pid, name: p.name, role: p.role, alive: p.alive, aliases: p.aliases || {}, online: isOn(seen, p.pid) })),
      chats: Object.fromEntries(Object.entries(room.chats).map(([k, msgs]) => [k, msgs.map(m => ({ ...m, name: nameOf(m.pid) }))])),
      vote: room.vote && { open: room.vote.open, ballots: room.vote.ballots, result: room.vote.result },
      log: room.log,
    };
  }
  function playerView(room, p, ver, seen) {
    const ended = room.status === 'ended';
    const v = {
      t: 'state', as: 'player', v: ver, code: room.code, status: room.status, phase: room.phase, round: room.round, winner: room.winner, capacity: room.capacity || null,
      me: { pid: p.pid, name: p.name, role: p.role, alive: p.alive },
      players: room.players.map(x => ({
        pid: x.pid, name: x.name, alive: x.alive, online: isOn(seen, x.pid),
        role: ended || x.role === 'jesus' ? x.role : null, // 예수님만 공개
      })),
      chats: chatRoomsOf(room, p).map(k => ({
        key: k, name: CHAT_NAMES[k], myAlias: (p.aliases || {})[k] || null,
        msgs: room.chats[k].map(m => ({ alias: m.alias, text: m.text, ts: m.ts, mine: m.pid === p.pid, sys: m.sys })),
      })),
      vote: null,
    };
    if (room.vote) v.vote = { open: room.vote.open, myVote: room.vote.ballots[p.pid] || null, voted: Object.keys(room.vote.ballots).length, result: room.vote.result };
    return v;
  }

  /* ---------------- 행동 ---------------- */
  function joinNew(room, rawName) {
    const name = String(rawName || '').trim().slice(0, 20);
    if (!name) return { error: '이름을 입력해 주세요.' };
    if (room.status !== 'lobby') return { error: '이미 게임이 시작되었어요.' };
    const cap = Math.min(room.capacity || MAX_PLAYERS, MAX_PLAYERS);
    if (room.players.length >= cap) return { error: `인원이 가득 찼어요. (총 ${cap}명)` };
    if (room.players.some(x => x.name === name)) return { error: '같은 이름이 이미 있어요. 다른 이름을 써 주세요.' };
    const p = { pid: rid(6), token: rid(), name, role: null, alive: true, aliases: {} };
    room.players.push(p);
    return { p };
  }

  function playerAction(room, p, msg) {
    switch (msg.t) {
      case 'leave':
        if (room.status !== 'lobby') return '게임 중에는 나갈 수 없어요.';
        room.players = room.players.filter(x => x !== p);
        return null;
      case 'chat': {
        const text = String(msg.text || '').trim().slice(0, 300);
        if (!text) return NOCHANGE;
        if (room.status !== 'playing') return '게임 중에만 채팅할 수 있어요.';
        if (room.phase !== 'night') return '채팅은 밤에만 할 수 있어요. 낮에는 직접 대화하세요!';
        if (!p.alive) return '제외된 사람은 채팅할 수 없어요.';
        const keys = chatRoomsOf(room, p);
        const key = keys.includes(msg.room) ? msg.room : keys[0];
        if (!key) return NOCHANGE;
        room.chats[key].push({ pid: p.pid, alias: p.aliases[key], text, ts: Date.now() });
        if (room.chats[key].length > MAX_CHAT) room.chats[key].shift();
        return null;
      }
      case 'vote': {
        if (!room.vote || !room.vote.open) return '지금은 투표 시간이 아니에요.';
        if (!p.alive) return '제외된 사람은 투표할 수 없어요.';
        if (msg.target === null) delete room.vote.ballots[p.pid];
        else {
          const target = room.players.find(x => x.pid === msg.target && x.alive);
          if (!target) return NOCHANGE;
          room.vote.ballots[p.pid] = target.pid;
        }
        return null;
      }
      default: return NOCHANGE;
    }
  }

  function adminAction(room, msg) {
    switch (msg.t) {
      case 'capacity': {
        if (room.status !== 'lobby') return '총 인원은 대기실에서만 바꿀 수 있어요.';
        if (msg.capacity == null) { room.capacity = null; return null; }
        const n = Math.floor(+msg.capacity);
        if (!(n >= 3 && n <= MAX_PLAYERS)) return `총 인원은 3~${MAX_PLAYERS}명 사이로 정해 주세요.`;
        if (n < room.players.length) return `이미 ${room.players.length}명이 들어와 있어요. 먼저 내보낸 뒤 줄여 주세요.`;
        room.capacity = n;
        return null;
      }
      case 'kick':
        if (room.status !== 'lobby') return '게임 중에는 내보낼 수 없어요. 대신 제외하세요.';
        room.players = room.players.filter(x => x.pid !== msg.pid);
        return null;
      case 'start': {
        if (room.status === 'playing') return '이미 게임 중이에요.';
        const ps = room.players;
        if (ps.length < 3) return '최소 3명이 필요해요.';
        let assign = {};
        if (msg.mode === 'manual') {
          assign = msg.assign || {};
          if (ps.some(p => !ROLES[assign[p.pid]])) return '모든 참가자에게 역할을 정해 주세요.';
        } else {
          const c = msg.counts || {};
          const nPh = Math.max(0, c.pharisee | 0), nTr = Math.max(0, c.traitor | 0);
          if (1 + nPh + nTr > ps.length) return '역할 수가 인원보다 많아요.';
          const deck = ['jesus', ...Array(nPh).fill('pharisee'), ...Array(nTr).fill('traitor')];
          while (deck.length < ps.length) deck.push('disciple');
          shuffle(deck);
          ps.forEach((p, i) => { assign[p.pid] = deck[i]; });
        }
        const roles = ps.map(p => assign[p.pid]);
        if (roles.filter(r => r === 'jesus').length !== 1) return '예수님은 정확히 1명이어야 해요.';
        if (!roles.includes('pharisee')) return '바리새인이 최소 1명은 있어야 해요.';
        const tr = (Array.isArray(msg.traitorRooms) ? msg.traitorRooms : []).filter(k => CHAT_KEYS.includes(k));
        if (roles.includes('traitor') && !tr.length) return '배신자가 들어갈 채팅방을 하나 이상 골라 주세요.';
        room.traitorRooms = tr.length ? tr : ['traitor'];
        ps.forEach(p => { p.role = assign[p.pid]; p.alive = true; });
        // 방마다 다른 익명 이름 → 여러 방에 있는 배신자도 이름으로 들키지 않음
        const pool = shuffle(ALIASES.slice());
        let ai = 0;
        ps.forEach(p => {
          p.aliases = {};
          chatRoomsOf(room, p).forEach(k => { p.aliases[k] = ai < pool.length ? pool[ai] : `익명${ai + 1}`; ai++; });
        });
        room.status = 'playing'; room.phase = 'day'; room.round = 1; room.winner = null; room.vote = null;
        room.chats = { jesus: [], pharisee: [], traitor: [] };
        room.log = [];
        const jesus = ps.find(p => p.role === 'jesus');
        addLog(room, `게임 시작 (${ps.length}명, ${msg.mode === 'manual' ? '직접 배정' : '랜덤 배정'}) · 예수님: ${jesus.name}`);
        return null;
      }
      case 'phase': {
        if (room.status !== 'playing') return '게임 중이 아니에요.';
        const next = room.phase === 'day' ? 'night' : 'day';
        if (next === 'day') room.round++;
        room.phase = next;
        if (room.vote) room.vote.open = false;
        const sys = next === 'night' ? `🌙 ${room.round}번째 밤이 시작되었습니다.` : `☀️ ${room.round}번째 아침입니다. 채팅이 닫혔어요.`;
        for (const k of CHAT_KEYS) room.chats[k].push({ sys: true, text: sys, ts: Date.now() });
        addLog(room, next === 'night' ? `🌙 ${room.round}번째 밤` : `☀️ ${room.round}번째 아침`);
        return null;
      }
      case 'eliminate':
      case 'revive': {
        const p = room.players.find(x => x.pid === msg.pid);
        if (!p || room.status === 'lobby') return NOCHANGE;
        const alive = msg.t === 'revive';
        if (p.alive === alive) return NOCHANGE;
        p.alive = alive;
        addLog(room, `${p.name}(${ROLES[p.role].name}) ${alive ? '복귀' : '게임에서 제외'}`);
        if (!alive) afterElimination(room);
        else if (room.status === 'ended' && room.winner && !checkWinner(room)) { room.status = 'playing'; room.winner = null; }
        if (!alive && msg.clearVote) room.vote = null;
        return null;
      }
      case 'voteOpen':
        if (room.status !== 'playing') return '게임 중이 아니에요.';
        room.vote = { open: true, ballots: {}, result: null };
        addLog(room, '🗳️ 투표 시작');
        return null;
      case 'voteClose': {
        if (!room.vote || !room.vote.open) return NOCHANGE;
        room.vote.open = false;
        const tally = {};
        Object.values(room.vote.ballots).forEach(t => { tally[t] = (tally[t] || 0) + 1; });
        const rows = Object.entries(tally).map(([pid, n]) => ({ pid, name: (room.players.find(p => p.pid === pid) || {}).name, n })).sort((a, b) => b.n - a.n);
        const top = rows.filter(r => r.n === rows[0].n);
        room.vote.result = { rows, top: top.length === 1 ? top[0].pid : null, tie: top.length > 1 };
        addLog(room, `🗳️ 투표 마감: ${rows.map(r => `${r.name} ${r.n}표`).join(', ') || '표 없음'}`);
        return null;
      }
      case 'voteClear': room.vote = null; return null;
      case 'endGame':
        if (room.status !== 'playing') return NOCHANGE;
        room.status = 'ended'; room.winner = null; addLog(room, '운영자가 게임을 끝냈어요.');
        return null;
      case 'toLobby':
        room.status = 'lobby'; room.phase = 'day'; room.round = 0; room.winner = null; room.vote = null;
        room.players.forEach(p => { p.role = null; p.alive = true; p.aliases = {}; });
        room.chats = { jesus: [], pharisee: [], traitor: [] }; room.log = [];
        return null;
      default: return NOCHANGE;
    }
  }

  /* ---------------- 요청 처리 (저장소는 바꿔 끼울 수 있음) ----------------
     store: load(code)->{room,ver} · cas(code,room,oldVer,newVer)->bool · exists(code)
            ver(code, touchPid?)->number · touch(code,pid) · seen(code)->{pid:ts}            */
  function createHandler(store) {
    async function update(code, first, fn) {
      let { room, ver } = first;
      for (let i = 0; i < 40; i++) {
        if (i > 0) await new Promise(r => setTimeout(r, 10 + randInt(Math.min(200, 25 * i)))); // 충돌하면 잠깐 쉬었다 재시도
        if (!room) return { missing: true };
        const r = fn(room) || {};
        if (r.error) return { error: r.error, room: null };
        if (r.nochange) return { room, ver, result: r };
        if (await store.cas(code, room, ver, ver + 1)) return { room, ver: ver + 1, result: r };
        ({ room, ver } = await store.load(code)); // 동시에 다른 요청이 저장함 → 다시 시도
      }
      return { error: '사람이 많아 처리하지 못했어요. 다시 시도해 주세요.', room: null };
    }

    return async function handle(msg) {
      msg = msg || {};
      const t = msg.t;

      if (t === 'create') {
        for (let i = 0; i < 12; i++) {
          const code = newCode();
          if (await store.exists(code)) continue;
          const room = createRoom(code);
          if (await store.cas(code, room, 0, 1)) return [{ t: 'created', code, token: room.adminToken }, adminView(room, 1, {})];
        }
        return [{ t: 'error', msg: '방을 만들지 못했어요. 다시 시도해 주세요.' }];
      }

      const auth = msg.auth || { code: msg.code, token: msg.token };
      const code = String(auth.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
      const token = String(auth.token || '');
      if (!code) return [{ t: 'error', msg: '방 코드가 없어요.' }];

      // 참가자 폴링: 바뀐 게 없으면 버전만 확인 (저장소 호출 최소화)
      if (t === 'poll' && !auth.admin && msg.v != null) {
        const ver = await store.ver(code, msg.hb && msg.pid ? String(msg.pid) : null);
        if (ver === msg.v) return [{ t: 'same' }];
      }

      let { room, ver } = await store.load(code);
      if (!room) {
        if (t === 'admin' || auth.admin) return [{ t: 'adminFail' }];
        if (t === 'join') return [{ t: 'joinFail', msg: '방을 찾을 수 없어요. 코드를 확인해 주세요.' }];
        return [{ t: 'kicked', msg: '방이 사라졌어요.' }];
      }

      if (t === 'join' && !token) {
        const r = await update(code, { room, ver }, rm => { const j = joinNew(rm, msg.name); return j.error ? { error: j.error } : { p: j.p }; });
        if (r.missing) return [{ t: 'joinFail', msg: '방을 찾을 수 없어요.' }];
        if (r.error) return [{ t: 'joinFail', msg: r.error }];
        const p = r.result.p;
        await store.touch(code, p.pid);
        return [{ t: 'joined', code, token: p.token }, playerView(r.room, p, r.ver, await store.seen(code))];
      }

      const isAdmin = !!token && token === room.adminToken;
      const me = !isAdmin && token ? room.players.find(x => x.token === token) : null;
      if (t === 'admin' && !isAdmin) return [{ t: 'adminFail' }];
      if (!isAdmin && !me) {
        if (t === 'join') return [{ t: 'joinFail', msg: '다시 참가해 주세요.' }];
        return [{ t: 'kicked', msg: room.status === 'lobby' ? '대기실에서 나가졌어요.' : '이 방의 참가자가 아니에요.' }];
      }

      if (t === 'admin' || t === 'join' || t === 'poll') {
        if (me && (t === 'join' || msg.hb)) await store.touch(code, me.pid);
        const seen = await store.seen(code);
        return [isAdmin ? adminView(room, ver, seen) : playerView(room, me, ver, seen)];
      }

      const r = await update(code, { room, ver }, rm => {
        let res;
        if (isAdmin) res = adminAction(rm, msg);
        else {
          const actor = rm.players.find(x => x.token === token);
          if (!actor) return { error: '이 방의 참가자가 아니에요.' };
          res = playerAction(rm, actor, msg);
        }
        if (res === NOCHANGE) return { nochange: true };
        return res ? { error: res } : {};
      });
      if (r.missing) return [{ t: 'kicked', msg: '방이 사라졌어요.' }];
      const out = [];
      if (r.error) { out.push({ t: 'error', msg: r.error }); ({ room, ver } = await store.load(code)); }
      else ({ room, ver } = r);
      if (!room) return out;
      const seen = await store.seen(code);
      if (isAdmin) out.push(adminView(room, ver, seen));
      else {
        const p = room.players.find(x => x.token === token);
        out.push(p ? playerView(room, p, ver, seen) : { t: 'kicked', msg: '방에서 나왔어요.' });
      }
      return out;
    };
  }

  // 한 프로세스 안에서만 쓰는 저장소 (미리보기, 로컬 개발용)
  function memoryStore() {
    const rooms = new Map(), seenMap = new Map();
    return {
      async load(code) { const e = rooms.get(code); return e ? { room: JSON.parse(e.json), ver: e.ver } : { room: null, ver: 0 }; },
      async cas(code, room, oldVer, newVer) {
        const e = rooms.get(code);
        if ((e ? e.ver : 0) !== oldVer) return false;
        rooms.set(code, { json: JSON.stringify(room), ver: newVer });
        return true;
      },
      async exists(code) { return rooms.has(code); },
      async ver(code, touchPid) { if (touchPid) await this.touch(code, touchPid); const e = rooms.get(code); return e ? e.ver : 0; },
      async touch(code, pid) { if (!seenMap.has(code)) seenMap.set(code, {}); seenMap.get(code)[pid] = Date.now(); },
      async seen(code) { return { ...(seenMap.get(code) || {}) }; },
    };
  }

  const api = { createHandler, memoryStore, checkWinner, ROLES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JesusGame = api;
})(typeof self !== 'undefined' ? self : this);
