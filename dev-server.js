// 로컬 개발용 서버: Vercel과 똑같이 public/ 정적 파일 + /api/action, /api/qr
// 실행: npm install && npm start  →  http://localhost:3000
// (Upstash 환경변수가 없으면 메모리에 저장되며, 서버를 끄면 방이 사라집니다)
const http = require('http');
const fs = require('fs');
const path = require('path');
const action = require('./api/action.js');
const qr = require('./api/qr.js');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const REWRITES = { '/join': '/play.html', '/play': '/play.html', '/admin': '/admin.html', '/preview': '/preview.html', '/': '/index.html' };

// Vercel의 req/res 도우미 흉내
function wrapRes(res) {
  res.status = c => { res.statusCode = c; return res; };
  res.json = o => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(o)); };
  res.send = b => res.end(b);
  return res;
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/action') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 64 * 1024) req.destroy(); });
    req.on('end', () => { req.body = body; action(req, wrapRes(res)); });
    return;
  }
  if (url.pathname === '/api/health') return require('./api/health.js')(req, wrapRes(res));
  if (url.pathname === '/api/qr') { req.query = Object.fromEntries(url.searchParams); return qr(req, wrapRes(res)); }
  const p = REWRITES[url.pathname] || url.pathname;
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (e, data) => {
    if (e) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('페이지를 찾을 수 없어요'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`예수님 게임 (로컬): http://localhost:${PORT}   미리보기: http://localhost:${PORT}/preview`));
