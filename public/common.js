// 공용: 역할 정보, 실시간 연결, 유틸
const ROLE_INFO = {
  jesus: { name: '예수님', emoji: '✝️', color: '#d4a017', team: '예수님 팀',
    goal: '바리새인과 배신자를 모두 게임에서 제외시키면 승리합니다. 당신의 정체는 모두에게 공개되어 있고, 채팅방에서도 실명으로 보여요.',
    power: () => '능력: 밤에 "오늘 밤 살인 무효화"를 쓰면 그날 밤 바리새인·배신자의 살인이 모두 무효가 돼요. 아침 투표에서 당신의 표는 2표이고, 아침 투표로는 죽지 않아요.' },
  disciple: { name: '제자', emoji: '🕊️', color: '#2f9e6b', team: '예수님 팀',
    goal: '예수님을 도와 바리새인과 배신자를 모두 찾아내세요. 그들이 모두 제외되면 예수님과 함께 승리합니다.',
    power: s => s.disciple ? `밤 투표: 살릴 사람에게 투표하세요. ${slotRule('disciple', s.disciple)}` : '이번 게임에서는 제자의 밤 투표가 없어요.' },
  pharisee: { name: '바리새인', emoji: '📜', color: '#d64545', team: '바리새인 팀',
    goal: '예수님을 게임에서 제외시키면 승리합니다.',
    power: s => s.pharisee ? `밤 투표: 죽일 사람에게 투표하세요. ${slotRule('pharisee', s.pharisee)}` : '이번 게임에서는 바리새인의 밤 투표가 없어요.' },
  traitor: { name: '배신자', emoji: '🪙', color: '#7b5cd6', team: '배신자',
    goal: '바리새인과 제자가 모두 제외되어 예수님과 단둘이 남으면 승리합니다. 예수님이 먼저 제외되면 안 됩니다!',
    power: s => s.traitor ? `밤 투표: 죽일 사람에게 투표하세요. ${slotRule('traitor', s.traitor)}` : '이번 게임에서는 배신자의 밤 투표가 없어요.' },
};
// 밤 투표 규칙 문장 (인원 n명 기준)
function slotRule(kind, n) {
  const who = { disciple: '제자', pharisee: '바리새인', traitor: '배신자' }[kind];
  if (kind === 'disciple') return `${who} 표를 가장 많이 받은 ${n}명은 그날 밤 죽지 않아요. (${n === 1 ? '1등이 동률이면 1등 모두' : `${n}등이 동률이면 그 사람들은 빼고`})`;
  return `${who} 표를 가장 많이 받은 ${n}명이 그날 밤 죽어요. (${n}등이 동률이면 그 사람들끼리 재투표)`;
}
const WIN_INFO = {
  jesus: { text: '예수님과 제자들의 승리!', emoji: '✝️' },
  pharisee: { text: '바리새인의 승리!', emoji: '📜' },
  traitor: { text: '배신자의 승리!', emoji: '🪙' },
};

// ---- 서버 통신 ----
// 배포: POST /api/action 으로 요청하고, 1~2.5초마다 새 상태를 받아옵니다(폴링).
// 미리보기(?demo=1): 부모 창(preview.html)의 엔진에 postMessage로 요청합니다.
const DEMO = new URLSearchParams(location.search).has('demo');
let demoSeq = 0;
const demoWait = new Map();
if (DEMO) window.addEventListener('message', e => {
  const d = e.data;
  if (d && d.jgRes && demoWait.has(d.id)) { demoWait.get(d.id)(d.out); demoWait.delete(d.id); }
});
function request(msg) {
  if (DEMO) return new Promise(res => { const id = ++demoSeq; demoWait.set(id, res); window.parent.postMessage({ jgReq: true, id, msg }, '*'); });
  return fetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg) })
    .then(r => { if (!r.ok && r.status !== 500) throw new Error(r.status); return r.json(); });
}

function connect({ onOpen, onMessage, onStatus }) {
  let auth = null, v = -1, pid = null, fails = 0, lastHb = 0, pollT = null, interval = 2500, polling = false;
  function deliver(m) {
    if (m.t === 'created' || m.t === 'joined') { auth = { code: m.code, token: m.token, admin: m.t === 'created' }; v = -1; }
    if (m.t === 'state') {
      if (m.v < v) return; // 늦게 도착한 옛날 상태는 무시
      v = m.v; pid = m.me ? m.me.pid : null;
      interval = m.status === 'playing' && m.phase === 'night' ? 1200 : 2500;
    }
    if (m.t === 'same') return;
    if (m.t === 'kicked' || m.t === 'adminFail' || (m.t === 'joinFail' && auth && !auth.admin)) { auth = null; v = -1; }
    onMessage(m);
  }
  async function call(msg) {
    try {
      const out = await request(msg);
      fails = 0; onStatus && onStatus(true);
      out.forEach(deliver);
    } catch (e) {
      fails++; if (fails >= 2) onStatus && onStatus(false);
    }
  }
  function send(msg) {
    if (msg.t === 'admin') auth = { code: msg.code, token: msg.token, admin: true };
    else if (msg.t === 'join' && msg.token) auth = { code: msg.code, token: msg.token, admin: false };
    else if (msg.t === 'create' || msg.t === 'join') { auth = null; v = -1; }
    else if (auth) msg = { ...msg, auth };
    return call(msg).then(() => { if (msg.t !== 'poll') kick(); });
  }
  async function loop() {
    clearTimeout(pollT);
    if (auth && !polling) {
      polling = true;
      const hb = Date.now() - lastHb > 6000;
      if (hb) lastHb = Date.now();
      await call({ t: 'poll', auth, v: auth.admin ? null : v, pid, hb });
      polling = false;
    }
    pollT = setTimeout(loop, document.hidden ? 6000 : interval);
  }
  function kick() { clearTimeout(pollT); pollT = setTimeout(loop, interval); }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loop(); });
  setTimeout(() => { onStatus && onStatus(true); onOpen && onOpen(); loop(); }, 0);
  return { send };
}

const $ = id => document.getElementById(id);
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const memStore = {};
function store(key, val) {
  if (DEMO) { if (val === undefined) return memStore[key] ?? null; if (val === null) delete memStore[key]; else memStore[key] = val; return; }
  try { if (val === undefined) return JSON.parse(localStorage.getItem(key)); if (val === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(val)); } catch (e) { return null; } }
function roleTag(role) {
  const r = ROLE_INFO[role]; if (!r) return '<span class="muted">-</span>';
  return `<span class="tag" style="background:${r.color}22;color:${r.color};border:1px solid ${r.color}55">${r.emoji} ${r.name}</span>`;
}
function timeStr(ts) { const d = new Date(ts); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; }
let toastTimer;
function toast(msg) {
  let t = $('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
}
// 페이지 안에서 그리는 확인 창 (브라우저 confirm()은 일부 환경에서 막혀 있음)
function ask(message, okLabel = '확인', danger = false) {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'modal';
    wrap.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true"><p></p>
      <div class="row" style="justify-content:flex-end"><button class="small" data-a="no">취소</button>
      <button class="small ${danger ? 'danger' : 'primary'}" data-a="yes"></button></div></div>`;
    wrap.querySelector('p').textContent = message;
    wrap.querySelector('[data-a=yes]').textContent = okLabel;
    const done = v => { wrap.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = e => { if (e.key === 'Escape') done(false); };
    wrap.addEventListener('click', e => { if (e.target === wrap) done(false); });
    wrap.querySelector('[data-a=no]').onclick = () => done(false);
    wrap.querySelector('[data-a=yes]').onclick = () => done(true);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(wrap);
    wrap.querySelector('[data-a=yes]').focus();
  });
}
function joinUrl(code) { return DEMO ? `(배포 후 주소)/join?room=${code}` : `${location.origin}/join?room=${code}`; }
