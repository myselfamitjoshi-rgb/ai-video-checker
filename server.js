// AI Video Checker backend (prototype).
// - Serves the web page from /public
// - Receives a few still frames (JPEG) from the page
// - Sends them to Reality Defender using a key kept ONLY on the server
// - Returns the provider's real results, or an honest error. Never invented results.
// Frames are kept in memory only (no temp files), so nothing needs cleaning up on disk.

const express = require('express');
const multer = require('multer');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const KEY = process.env.RD_API_KEY || '';
const BASE = process.env.RD_API_BASE || 'https://api.prd.realitydefender.xyz';
// Every frame counts as one detection on the free plan (50 per month), so keep this low.
const MAX_FRAMES = Math.max(1, Math.min(parseInt(process.env.MAX_FRAMES || '3', 10) || 3, 5));
const MAX_FRAME_BYTES = 2 * 1024 * 1024;

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ['https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  })
);

const fail = (code, message, http = 502) => Object.assign(new Error(message), { code, http });

// ---- Reality Defender helpers -------------------------------------------------
async function rd(p, options = {}) {
  let res;
  try {
    res = await fetch(BASE + p, {
      ...options,
      headers: { 'X-API-KEY': KEY, 'Content-Type': 'application/json', ...(options.headers || {}) },
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    throw fail('provider_unreachable', 'The analysis service did not respond in time. Try again later.', 504);
  }
  if (res.status === 401 || res.status === 403)
    throw fail('provider_auth', 'The analysis service rejected the server key. The site owner needs to check it.', 502);
  if (res.status === 429)
    throw fail('provider_rate_limited', 'The free monthly limit for the analysis service may be used up. Try again later.', 429);
  if (res.status === 404) throw fail('not_ready', 'Result not ready yet.', 404);
  if (!res.ok) throw fail('provider_error', 'The analysis service returned an error.', 502);
  return res.json();
}

async function uploadFrame(buffer, name) {
  const j = await rd('/api/files/aws-presigned', { method: 'POST', body: JSON.stringify({ fileName: name }) });
  const signedUrl = j && j.response && j.response.signedUrl;
  const requestId = j && (j.requestId || (j.response && j.response.requestId) || j.mediaId);
  if (!signedUrl || !requestId)
    throw fail('provider_unexpected', 'The analysis service answered in an unexpected way. Nothing was analyzed.', 502);
  let put;
  try {
    put = await fetch(signedUrl, { method: 'PUT', body: buffer, signal: AbortSignal.timeout(30000) });
  } catch (e) {
    throw fail('provider_unreachable', 'Sending the frame to the analysis service failed.', 504);
  }
  if (!put.ok) throw fail('provider_upload', 'Sending the frame to the analysis service failed.', 502);
  return requestId;
}

const FINAL = ['AUTHENTIC', 'FAKE', 'SUSPICIOUS', 'NOT_APPLICABLE', 'UNABLE_TO_EVALUATE'];
async function waitForResult(requestId) {
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    try {
      const j = await rd('/api/media/users/' + encodeURIComponent(requestId), { method: 'GET' });
      if (j && FINAL.includes(j.overallStatus)) return j;
    } catch (e) {
      if (e.code !== 'not_ready') throw e;
    }
  }
  return null; // still not finished after about 60 seconds
}

function summarize(index, j) {
  if (!j) return { index, status: 'TIMED_OUT', score: null, reason: 'The analysis took too long.' };
  const meta = (j.resultsSummary && j.resultsSummary.metadata) || {};
  const reasons = Array.isArray(meta.reasons) && meta.reasons[0] ? meta.reasons[0].message : null;
  const err = j.resultsSummary && j.resultsSummary.error ? j.resultsSummary.error.message : null;
  return {
    index,
    status: j.overallStatus,
    score: typeof meta.finalScore === 'number' ? Math.round(meta.finalScore) : null,
    reason: reasons || err || null,
  };
}

// ---- API ---------------------------------------------------------------------
app.get('/api/status', (req, res) => {
  res.json({ providerConfigured: Boolean(KEY), maxFrames: MAX_FRAMES, maxFrameBytes: MAX_FRAME_BYTES });
});

const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many checks in a short time. Wait a minute and try again.' },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FRAME_BYTES, files: MAX_FRAMES, fields: 0 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype === 'image/jpeg'),
});

app.post('/api/analyze', limiter, (req, res, next) => {
  req.setTimeout(120000);
  upload.array('frames', MAX_FRAMES)(req, res, (e) => {
    if (e) return res.status(400).json({ message: 'The frames were not accepted. Use up to ' + MAX_FRAMES + ' small JPEG images.' });
    next();
  });
}, async (req, res, next) => {
  try {
    if (!KEY)
      return res.status(503).json({ message: 'No analysis service is set up on this server yet, so nothing was analyzed.' });
    const files = req.files || [];
    if (files.length < 1) return res.status(400).json({ message: 'No valid frames were received.' });
    // Real JPEG files start with the bytes FF D8 FF. The browser's MIME type alone is not trusted.
    if (!files.every((f) => f.buffer.length > 3 && f.buffer[0] === 0xff && f.buffer[1] === 0xd8 && f.buffer[2] === 0xff))
      return res.status(400).json({ message: 'One of the files is not a real JPEG image.' });

    const ids = [];
    for (let i = 0; i < files.length; i++) ids.push(await uploadFrame(files[i].buffer, 'frame-' + (i + 1) + '.jpg'));
    const results = await Promise.all(ids.map((id) => waitForResult(id)));

    res.json({
      scanId: crypto.randomUUID(),
      scannedAt: new Date().toISOString(),
      provider: 'Reality Defender',
      kind: 'still-frames',
      framesSubmitted: files.length,
      frames: results.map((j, i) => summarize(i + 1, j)),
      notRun: ['Full-video motion analysis', 'Audio analysis', 'Source and provenance checks', 'Claim fact-checking'],
    });
  } catch (e) {
    next(e);
  }
});

// ---- Static page and safe errors ---------------------------------------------
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));

app.use((e, req, res, next) => {
  // Never send stack traces, paths or keys to the browser.
  console.error('[error]', e && e.code ? e.code : 'unexpected');
  res.status(e && e.http ? e.http : 500).json({ message: e && e.http ? e.message : 'Something went wrong. Nothing was saved.' });
});

app.listen(PORT, () => console.log('AI Video Checker running on port ' + PORT + (KEY ? '' : ' (no analysis key set)')));
