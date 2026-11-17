// 저장소 선택: Upstash Redis → Supabase(PostgreSQL) → 메모리(로컬 개발용) 순서로, 연결된 것을 씁니다
const { memoryStore } = require('../public/engine.js');

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const TTL = 60 * 60 * 24; // 방은 마지막 변경 후 하루 동안 유지

// 버전이 그대로일 때만 저장 (동시 요청 충돌 방지)
const CAS = `
local v = redis.call('GET', KEYS[2]) or '0'
if v ~= ARGV[2] then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[4])
redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[4])
return 1`;

function redisStore() {
  async function pipe(cmds) {
    const r = await fetch(URL_.replace(/\/$/, '') + '/pipeline', {
      method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmds),
    });
    if (!r.ok) throw new Error('Redis 오류 ' + r.status);
    const out = await r.json();
    return out.map(x => { if (x.error) throw new Error(x.error); return x.result; });
  }
  const K = c => ({ room: 'jg:room:' + c, ver: 'jg:ver:' + c, seen: 'jg:seen:' + c });
  return {
    async load(code) {
      const k = K(code);
      const [[json, ver]] = await pipe([['MGET', k.room, k.ver]]); // 한 명령으로 읽어야 방 내용과 버전이 어긋나지 않음
      return json ? { room: JSON.parse(json), ver: Number(ver || 0) } : { room: null, ver: 0 };
    },
    async cas(code, room, oldVer, newVer) {
      const k = K(code);
      const [ok] = await pipe([['EVAL', CAS, '2', k.room, k.ver, JSON.stringify(room), String(oldVer), String(newVer), String(TTL)]]);
      return ok === 1;
    },
    async exists(code) { const [n] = await pipe([['EXISTS', K(code).room]]); return n > 0; },
    async ver(code, touchPid) {
      const k = K(code);
      const cmds = [['GET', k.ver]];
      if (touchPid) cmds.push(['HSET', k.seen, touchPid, String(Date.now())], ['EXPIRE', k.seen, String(TTL)]);
      const [v] = await pipe(cmds);
      return Number(v || 0);
    },
    async touch(code, pid) { const k = K(code); await pipe([['HSET', k.seen, pid, String(Date.now())], ['EXPIRE', k.seen, String(TTL)]]); },
    async seen(code) {
      const [arr] = await pipe([['HGETALL', K(code).seen]]);
      const o = {};
      if (Array.isArray(arr)) for (let i = 0; i < arr.length; i += 2) o[arr[i]] = Number(arr[i + 1]);
      else if (arr) Object.assign(o, arr);
      return o;
    },
  };
}

// ---------------- Supabase (PostgreSQL) ----------------
// Vercel에서 Supabase를 연결하면 POSTGRES_URL이 자동으로 들어옵니다. 표는 처음 쓸 때 자동으로 만듭니다.
// 표는 API로 공개되지 않는 별도 스키마(jesus_game)에 두어, 다른 사람이 역할을 엿볼 수 없게 합니다.
const PG_URL = process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.POSTGRES_URL_NON_POOLING;

function postgresStore() {
  const { Pool } = require('pg');
  // sslmode를 주소에서 빼고 직접 지정 (Supabase 인증서 체인 때문에 sslmode=require가 연결을 막는 경우가 있음)
  const url = new URL(PG_URL);
  const local = /^(localhost|127\.0\.0\.1)$/.test(url.hostname) || url.searchParams.get('sslmode') === 'disable';
  ['sslmode', 'supa', 'pgbouncer'].forEach(k => url.searchParams.delete(k));
  const pool = new Pool({ connectionString: url.toString(), ssl: local ? false : { rejectUnauthorized: false }, max: 3, idleTimeoutMillis: 10000 });

  let ready = null;
  const init = () => ready || (ready = pool.query(`
    CREATE SCHEMA IF NOT EXISTS jesus_game;
    CREATE TABLE IF NOT EXISTS jesus_game.rooms (
      code text PRIMARY KEY,
      data jsonb NOT NULL,
      ver integer NOT NULL,
      seen jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE jesus_game.rooms ENABLE ROW LEVEL SECURITY;
  `).catch(e => { ready = null; throw e; }));
  const q = async (sql, args) => { await init(); return pool.query(sql, args); };
  const FRESH = `updated > now() - interval '1 day'`; // 하루 지난 방은 없는 것으로 봄

  return {
    async load(code) {
      const r = await q(`SELECT data, ver FROM jesus_game.rooms WHERE code = $1 AND ${FRESH}`, [code]);
      return r.rows[0] ? { room: r.rows[0].data, ver: r.rows[0].ver } : { room: null, ver: 0 };
    },
    async cas(code, room, oldVer, newVer) {
      if (oldVer === 0) {
        await q(`DELETE FROM jesus_game.rooms WHERE updated < now() - interval '1 day'`); // 오래된 방 정리
        const r = await q(`INSERT INTO jesus_game.rooms (code, data, ver) VALUES ($1, $2, $3) ON CONFLICT (code) DO NOTHING`, [code, JSON.stringify(room), newVer]);
        return r.rowCount === 1;
      }
      // 버전이 그대로일 때만 저장 (동시 요청 충돌 방지)
      const r = await q(`UPDATE jesus_game.rooms SET data = $2, ver = $3, updated = now() WHERE code = $1 AND ver = $4`, [code, JSON.stringify(room), newVer, oldVer]);
      return r.rowCount === 1;
    },
    async exists(code) {
      const r = await q(`SELECT 1 FROM jesus_game.rooms WHERE code = $1 AND ${FRESH}`, [code]);
      return r.rowCount > 0;
    },
    async ver(code, touchPid) {
      const r = touchPid
        ? await q(`UPDATE jesus_game.rooms SET seen = seen || jsonb_build_object($2::text, $3::bigint) WHERE code = $1 RETURNING ver`, [code, touchPid, Date.now()])
        : await q(`SELECT ver FROM jesus_game.rooms WHERE code = $1`, [code]);
      return r.rows[0] ? r.rows[0].ver : 0;
    },
    async touch(code, pid) {
      await q(`UPDATE jesus_game.rooms SET seen = seen || jsonb_build_object($2::text, $3::bigint) WHERE code = $1`, [code, pid, Date.now()]);
    },
    async seen(code) {
      const r = await q(`SELECT seen FROM jesus_game.rooms WHERE code = $1`, [code]);
      return r.rows[0] ? r.rows[0].seen : {};
    },
  };
}

const hasRedis = !!(URL_ && TOKEN);
const hasPostgres = !hasRedis && !!PG_URL;
const kind = hasRedis ? 'redis' : hasPostgres ? 'supabase' : 'memory';
module.exports = {
  store: hasRedis ? redisStore() : hasPostgres ? postgresStore() : memoryStore(),
  hasRedis, hasPostgres, kind, hasStore: hasRedis || hasPostgres,
};
