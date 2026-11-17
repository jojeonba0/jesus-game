// 연결 상태 확인 (GET /api/health) — 브라우저로 열어서 저장소가 잘 연결됐는지 봅니다
const { store, kind, hasStore } = require('../lib/store.js');
const NAMES = { redis: 'Upstash Redis', supabase: 'Supabase', memory: '없음 (임시 메모리)' };

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const out = { 저장소: NAMES[kind] };
  try {
    await store.exists('TEST');
    out.상태 = hasStore ? '✅ 정상 연결됨' : '⚠️ 저장소가 연결되지 않았어요';
    res.status(hasStore || !process.env.VERCEL ? 200 : 503);
  } catch (e) {
    out.상태 = '❌ 저장소에 연결할 수 없어요';
    out.오류 = String(e.message || e).slice(0, 300);
    res.status(500);
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(out, null, 2));
};
