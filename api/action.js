// 모든 게임 요청을 처리하는 Vercel 함수 (POST /api/action)
const { createHandler } = require('../public/engine.js');
const { store, hasRedis } = require('../lib/store.js');
const handle = createHandler(store);

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json([{ t: 'error', msg: 'POST만 가능해요.' }]);
  if (!hasRedis && process.env.VERCEL) {
    return res.status(200).json([{ t: 'error', msg: '서버 저장소(Upstash Redis)가 연결되지 않았어요. Vercel 프로젝트의 Storage에서 Upstash Redis를 연결해 주세요.' }]);
  }
  let body = req.body;
  try { if (typeof body === 'string') body = JSON.parse(body); } catch (e) { body = {}; }
  try {
    res.status(200).json(await handle(body || {}));
  } catch (e) {
    console.error(e);
    res.status(500).json([{ t: 'error', msg: '서버 오류가 발생했어요. 잠시 후 다시 시도해 주세요.' }]);
  }
};
