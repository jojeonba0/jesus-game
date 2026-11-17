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
  const NIGHT_VOTERS = ['disciple', 'pharisee', 'traitor']; // 밤에 투표하는 역할 (예수님은 능력 사용)
  function createRoom(code) {
    return {
      code, adminToken: rid(), created: Date.now(),
      status: 'lobby', phase: 'day', round: 0, capacity: null, // 총 인원 (null = 제한 없음, 최대 40)
      traitorRooms: ['traitor'],
      jesusPowers: 1, jesusUsed: 0, // 예수님 능력(밤 살인 무효화) 사용 가능 횟수, 0 = 매일 밤
      players: [], // {pid, token, name, role, alive, aliases:{방: 익명N}}
      chats: { jesus: [], pharisee: [], traitor: [] },
      dayVote: null, night: null, announce: null, winner: null, log: [],
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
    if (w) {
      room.status = 'ended'; room.winner = w; room.dayVote = null; room.night = null;
      addLog(room, `🏁 ${WIN_TEXT[w]}`);
    }
  }
  const byPid = (room, pid) => room.players.find(p => p.pid === pid);
  const nameOf = (room, pid) => (byPid(room, pid) || {}).name || '?';
  const namesOf = (room, pids) => pids.map(pid => nameOf(room, pid)).join(', ');
  const powersLeft = room => room.jesusPowers === 0 ? null : Math.max(0, room.jesusPowers - room.jesusUsed); // null = 무제한

  // 살아 있는 사람이 살아 있는 사람에게 던진 표만 셈
  function tallyOf(room, ballots, weight) {
    const t = {};
    for (const [voter, target] of Object.entries(ballots || {})) {
      const v = byPid(room, voter), tg = byPid(room, target);
      if (!v || !v.alive || !tg || !tg.alive) continue;
      t[target] = (t[target] || 0) + (weight ? weight(v) : 1);
    }
    return t;
  }
  // 득표수가 같은 사람끼리 묶어 많은 순으로 (0표 제외)
  function groupsOf(tally) {
    const byN = {};
    Object.entries(tally).forEach(([pid, n]) => { if (n > 0) (byN[n] = byN[n] || []).push(pid); });
    return Object.keys(byN).map(Number).sort((a, b) => b - a).map(n => ({ n, pids: byN[n] }));
  }
  // 제자: 상위 2명 보호. 2등이 여러 명이면 1등만 보호 (1등이 여러 명이면 1등 모두)
  function pickProtect(tally) {
    const g = groupsOf(tally);
    if (!g.length) return [];
    if (g[0].pids.length >= 2) return g[0].pids.slice();
    return g[0].pids.concat(g[1] && g[1].pids.length === 1 ? g[1].pids : []);
  }
  // 바리새인(2명)·배신자(1명): 상위 slots명 사망. 자리를 넘치는 동률이 생기면 그 사람들끼리 재투표
  function pickKill(tally, slots) {
    const chosen = [];
    for (const grp of groupsOf(tally)) {
      const left = slots - chosen.length;
      if (left <= 0) break;
      if (grp.pids.length <= left) chosen.push(...grp.pids);
      else return { chosen, runoff: { candidates: grp.pids.slice(), slots: left } };
    }
    return { chosen, runoff: null };
  }
  const KILL_SLOTS = { pharisee: 2, traitor: 1 };
  const RUNOFF = '__runoff__';
  const TEAM_NAME = { disciple: '제자', pharisee: '바리새인', traitor: '배신자' };

  function newNight() {
    return { open: true, ballots: { disciple: {}, pharisee: {}, traitor: {} }, jesusCancel: false,
      result: null, runoff: { pharisee: null, traitor: null } };
  }
  function closeNightVote(room) {
    const n = room.night;
    if (!n || !n.open) return;
    n.open = false;
    const protect = pickProtect(tallyOf(room, n.ballots.disciple));
    n.result = { protect, kills: { pharisee: [], traitor: [] } };
    for (const team of ['pharisee', 'traitor']) {
      const r = pickKill(tallyOf(room, n.ballots[team]), KILL_SLOTS[team]);
      n.result.kills[team] = r.chosen;
      n.runoff[team] = r.runoff ? { ...r.runoff, ballots: {} } : null;
      if (r.runoff) addLog(room, `🔁 ${TEAM_NAME[team]} 재투표: ${namesOf(room, r.runoff.candidates)} 중 ${r.runoff.slots}명`);
    }
    addLog(room, `🌙 밤 투표 마감 · 제자 보호: ${namesOf(room, protect) || '없음'} · 바리새인 지목: ${namesOf(room, n.result.kills.pharisee) || '없음'} · 배신자 지목: ${namesOf(room, n.result.kills.traitor) || '없음'}`);
  }
  function closeRunoffs(room, random) {
    const n = room.night;
    if (!n || n.open) return '아직 밤 투표가 진행 중이에요.';
    let any = false;
    for (const team of ['pharisee', 'traitor']) {
      const r = n.runoff[team];
      if (!r) continue;
      any = true;
      let res;
      if (random) res = { chosen: shuffle(r.candidates.slice()).slice(0, r.slots), runoff: null };
      else {
        const t = tallyOf(room, r.ballots);
        Object.keys(t).forEach(pid => { if (!r.candidates.includes(pid)) delete t[pid]; });
        res = pickKill(t, r.slots);
      }
      n.result.kills[team].push(...res.chosen);
      n.runoff[team] = res.runoff ? { ...res.runoff, ballots: {} } : null;
      addLog(room, res.runoff
        ? `🔁 ${TEAM_NAME[team]} 재투표도 동률 → 다시 재투표: ${namesOf(room, res.runoff.candidates)}`
        : `🔁 ${TEAM_NAME[team]} 재투표 결과${random ? ' (무작위)' : ''}: ${namesOf(room, res.chosen) || '표 없음'}`);
    }
    return any ? null : NOCHANGE;
  }
  // 밤 결과 적용 (아침으로 넘어갈 때)
  function resolveNight(room) {
    const n = room.night;
    if (!n) return null;
    closeNightVote(room);
    if (n.runoff.pharisee || n.runoff.traitor) return RUNOFF; // 재투표가 남음 → 밤 유지
    const kills = [...new Set([...n.result.kills.pharisee, ...n.result.kills.traitor])];
    const jesus = room.players.find(p => p.role === 'jesus' && p.alive);
    let deaths = [];
    if (n.jesusCancel && jesus) {
      room.jesusUsed++;
      addLog(room, `✝️ 예수님 능력 사용: 오늘 밤 살인 무효 (원래 지목: ${namesOf(room, kills) || '없음'})`);
    } else {
      deaths = kills.filter(pid => !n.result.protect.includes(pid) && (byPid(room, pid) || {}).alive);
      const saved = kills.filter(pid => n.result.protect.includes(pid));
      if (saved.length) addLog(room, `🕊️ 제자들의 보호로 생존: ${namesOf(room, saved)}`);
    }
    deaths.forEach(pid => { const p = byPid(room, pid); p.alive = false; addLog(room, `💀 밤에 사망: ${p.name}(${ROLES[p.role].name})`); });
    room.announce = { round: room.round + 1, text: deaths.length ? `지난밤 ${namesOf(room, deaths)}님이 죽었습니다.` : '지난밤에는 아무도 죽지 않았습니다.' };
    room.night = null;
    afterElimination(room);
    return null;
  }

  // 아침 투표: 과반수를 얻은 1명만 사망. 예수님 표는 2표, 예수님은 아침 투표로 죽지 않음
  const dayWeight = p => (p.role === 'jesus' ? 2 : 1);
  function closeDayVote(room) {
    const dv = room.dayVote;
    if (!dv || !dv.open) return NOCHANGE;
    dv.open = false;
    const total = room.players.filter(p => p.alive).reduce((a, p) => a + dayWeight(p), 0);
    const threshold = Math.floor(total / 2) + 1;
    const tally = tallyOf(room, dv.ballots, dayWeight);
    const rows = Object.entries(tally).map(([pid, n]) => ({ pid, name: nameOf(room, pid), n })).sort((a, b) => b.n - a.n);
    const top = rows[0];
    let eliminated = null, reason = 'none';
    if (top && top.n >= threshold) {
      if (byPid(room, top.pid).role === 'jesus') reason = 'jesus';
      else { eliminated = top.pid; reason = 'majority'; }
    }
    dv.result = { rows, total, threshold, eliminated, reason };
    addLog(room, `🗳️ 아침 투표 마감 (과반수 ${threshold}표): ${rows.map(r => `${r.name} ${r.n}표`).join(', ') || '표 없음'}`);
    if (eliminated) {
      const p = byPid(room, eliminated);
      p.alive = false;
      addLog(room, `⚖️ 아침 투표로 사망: ${p.name}(${ROLES[p.role].name})`);
      afterElimination(room);
    } else addLog(room, reason === 'jesus' ? '⚖️ 예수님은 아침 투표로 죽지 않아요 → 사망자 없음' : '⚖️ 과반수를 넘긴 사람이 없어 사망자 없음');
    return null;
  }

  /* ---------------- 화면용 데이터 ---------------- */
  const isOn = (seen, pid) => !!seen && Date.now() - (+seen[pid] || 0) < ONLINE_MS;
  function adminView(room, ver, seen) {
    return {
      t: 'state', as: 'admin', v: ver, code: room.code, status: room.status, phase: room.phase, round: room.round, capacity: room.capacity || null,
      traitorRooms: room.traitorRooms || ['traitor'], chatKeys: activeChatKeys(room), winner: room.winner,
      jesusPowers: room.jesusPowers, jesusUsed: room.jesusUsed, powersLeft: powersLeft(room),
      players: room.players.map(p => ({ pid: p.pid, name: p.name, role: p.role, alive: p.alive, aliases: p.aliases || {}, online: isOn(seen, p.pid) })),
      chats: Object.fromEntries(Object.entries(room.chats).map(([k, msgs]) => [k, msgs.map(m => ({ ...m, name: nameOf(room, m.pid) }))])),
      dayVote: room.dayVote, night: room.night, announce: room.announce,
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
        msgs: room.chats[k].map(m => ({ alias: m.alias, text: m.text, ts: m.ts, mine: m.pid === p.pid, sys: m.sys, jesus: m.jesus })),
      })),
      announce: room.announce, dayVote: null, nightVote: null,
    };
    const dv = room.dayVote;
    if (dv && room.status === 'playing') {
      v.dayVote = { open: dv.open, myVote: dv.ballots[p.pid] || null, voted: Object.keys(dv.ballots).length, myWeight: dayWeight(p), result: dv.result };
    }
    const n = room.night;
    if (n && room.status === 'playing' && p.alive) {
      if (p.role === 'jesus') {
        v.nightVote = { kind: 'jesus', cancel: n.jesusCancel, powersLeft: powersLeft(room), jesusPowers: room.jesusPowers };
      } else if (NIGHT_VOTERS.includes(p.role)) {
        const team = p.role, r = team !== 'disciple' ? n.runoff[team] : null;
        const tally = list => Object.entries(list).map(([pid, c]) => ({ pid, n: c })).sort((a, b) => b.n - a.n);
        if (n.open) v.nightVote = { kind: team, stage: 'vote', myVote: n.ballots[team][p.pid] || null, tally: tally(tallyOf(room, n.ballots[team])) };
        else if (r) v.nightVote = { kind: team, stage: 'runoff', candidates: r.candidates, slots: r.slots, myVote: r.ballots[p.pid] || null, tally: tally(tallyOf(room, r.ballots)) };
        else v.nightVote = { kind: team, stage: 'closed' };
      }
    }
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
        room.chats[key].push({ pid: p.pid, alias: p.aliases[key], jesus: p.role === 'jesus' || undefined, text, ts: Date.now() });
        if (room.chats[key].length > MAX_CHAT) room.chats[key].shift();
        return null;
      }
      case 'vote': { // 아침 투표
        const dv = room.dayVote;
        if (room.status !== 'playing' || !dv || !dv.open) return '지금은 아침 투표 시간이 아니에요.';
        if (!p.alive) return '제외된 사람은 투표할 수 없어요.';
        if (msg.target == null) { delete dv.ballots[p.pid]; return null; }
        const target = byPid(room, msg.target);
        if (!target || !target.alive) return NOCHANGE;
        dv.ballots[p.pid] = target.pid;
        return null;
      }
      case 'nightVote': {
        const n = room.night;
        if (room.status !== 'playing' || !n) return '지금은 밤 투표 시간이 아니에요.';
        if (!p.alive) return '제외된 사람은 투표할 수 없어요.';
        if (!NIGHT_VOTERS.includes(p.role)) return NOCHANGE;
        let box, allowed = null;
        if (n.open) box = n.ballots[p.role];
        else if (p.role !== 'disciple' && n.runoff[p.role]) { box = n.runoff[p.role].ballots; allowed = n.runoff[p.role].candidates; }
        else return '밤 투표가 끝났어요.';
        if (msg.target == null) { delete box[p.pid]; return null; }
        const target = byPid(room, msg.target);
        if (!target || !target.alive || (allowed && !allowed.includes(target.pid))) return NOCHANGE;
        box[p.pid] = target.pid;
        return null;
      }
      case 'jesusCancel': {
        const n = room.night;
        if (p.role !== 'jesus' || !p.alive) return NOCHANGE;
        if (room.status !== 'playing' || !n) return '능력은 밤에만 쓸 수 있어요.';
        if (msg.on && powersLeft(room) === 0) return '능력을 모두 사용했어요.';
        n.jesusCancel = !!msg.on;
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
        const jp = Math.floor(+msg.jesusPowers);
        room.jesusPowers = jp >= 0 && jp <= 10 ? jp : 1;
        room.jesusUsed = 0;
        ps.forEach(p => { p.role = assign[p.pid]; p.alive = true; p.aliases = {}; });
        // 채팅 이름: 방마다 '익명+번호'를 무작위로. 예수님만 실명.
        for (const k of CHAT_KEYS) {
          const members = ps.filter(p => chatRoomsOf(room, p).includes(k));
          const others = members.filter(p => p.role !== 'jesus');
          const nums = shuffle(others.map((_, i) => i + 1));
          others.forEach((p, i) => { p.aliases[k] = `익명${nums[i]}`; });
          members.filter(p => p.role === 'jesus').forEach(p => { p.aliases[k] = `✝️ 예수님 (${p.name})`; });
        }
        room.status = 'playing'; room.phase = 'day'; room.round = 1; room.winner = null;
        room.dayVote = null; room.night = null; room.announce = null;
        room.chats = { jesus: [], pharisee: [], traitor: [] };
        room.log = [];
        const jesus = ps.find(p => p.role === 'jesus');
        addLog(room, `게임 시작 (${ps.length}명, ${msg.mode === 'manual' ? '직접 배정' : '랜덤 배정'}) · 예수님: ${jesus.name} · 능력 ${room.jesusPowers === 0 ? '매일 밤' : room.jesusPowers + '번'}`);
        return null;
      }
      case 'phase': {
        if (room.status !== 'playing') return '게임 중이 아니에요.';
        if (room.phase === 'day') {
          if (room.dayVote && room.dayVote.open) return '아침 투표를 먼저 마감해 주세요.';
          room.phase = 'night'; room.dayVote = null; room.night = newNight();
          for (const k of CHAT_KEYS) room.chats[k].push({ sys: true, text: `🌙 ${room.round}번째 밤이 시작되었습니다. 밤 투표도 열렸어요.`, ts: Date.now() });
          addLog(room, `🌙 ${room.round}번째 밤 (밤 투표 시작)`);
        } else {
          const e = resolveNight(room);
          if (e === RUNOFF) return null; // 투표 마감은 저장하고, 재투표가 끝날 때까지 밤 유지
          if (e) return e;
          if (room.status !== 'playing') return null; // 밤 결과로 게임이 끝남
          room.round++; room.phase = 'day';
          for (const k of CHAT_KEYS) room.chats[k].push({ sys: true, text: `☀️ ${room.round}번째 아침입니다. ${room.announce.text} 채팅이 닫혔어요.`, ts: Date.now() });
          addLog(room, `☀️ ${room.round}번째 아침 · ${room.announce.text}`);
        }
        return null;
      }
      case 'nightClose':
        if (!room.night || !room.night.open) return NOCHANGE;
        closeNightVote(room);
        return null;
      case 'runoffClose': return closeRunoffs(room, false);
      case 'runoffRandom': return closeRunoffs(room, true);
      case 'dayVoteOpen':
        if (room.status !== 'playing' || room.phase !== 'day') return '아침 투표는 낮에만 할 수 있어요.';
        room.dayVote = { open: true, ballots: {}, result: null };
        addLog(room, '🗳️ 아침 투표 시작');
        return null;
      case 'dayVoteClose': return closeDayVote(room);
      case 'dayVoteCancel': room.dayVote = null; return null;
      case 'eliminate':
      case 'revive': {
        const p = byPid(room, msg.pid);
        if (!p || room.status === 'lobby') return NOCHANGE;
        const alive = msg.t === 'revive';
        if (p.alive === alive) return NOCHANGE;
        p.alive = alive;
        addLog(room, `${p.name}(${ROLES[p.role].name}) ${alive ? '복귀' : '운영자가 제외'}`);
        if (!alive) afterElimination(room);
        else if (room.status === 'ended' && room.winner && !checkWinner(room)) { room.status = 'playing'; room.winner = null; }
        return null;
      }
      case 'endGame':
        if (room.status !== 'playing') return NOCHANGE;
        room.status = 'ended'; room.winner = null; room.night = null; room.dayVote = null;
        addLog(room, '운영자가 게임을 끝냈어요.');
        return null;
      case 'toLobby':
        room.status = 'lobby'; room.phase = 'day'; room.round = 0; room.winner = null;
        room.dayVote = null; room.night = null; room.announce = null; room.jesusUsed = 0;
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

  const api = { createHandler, memoryStore, checkWinner, ROLES, _test: { pickProtect, pickKill, groupsOf } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JesusGame = api;
})(typeof self !== 'undefined' ? self : this);
