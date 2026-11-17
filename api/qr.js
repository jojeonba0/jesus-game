// 참가 링크 QR 코드 이미지 (GET /api/qr?text=...)
const QRCode = require('qrcode');

module.exports = async (req, res) => {
  const text = String((req.query && req.query.text) || '').slice(0, 300);
  if (!text) return res.status(400).end();
  try {
    const svg = await QRCode.toString(text, { type: 'svg', margin: 1, width: 240 });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.status(200).send(svg);
  } catch (e) { res.status(400).end(); }
};
