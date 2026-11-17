// 저장소 선택: Upstash Redis 환경변수가 있으면 Redis, 없으면 메모리(로컬 개발용)
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

const hasRedis = !!(URL_ && TOKEN);
module.exports = { store: hasRedis ? redisStore() : memoryStore(), hasRedis };
