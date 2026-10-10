const $ = s => document.querySelector(s);
const h = (t, a = {}, ...k) => {
  const e = document.createElement(t);
  for (const [x, v] of Object.entries(a)) {
    if (v === null || v === undefined || v === false) continue;
    if (x.startsWith('on')) e.addEventListener(x.slice(2), v);
    else if (x === 'class') e.className = v;
    else e.setAttribute(x, v);
  }
  k.flat().forEach(c => e.append(c instanceof Node ? c : document.createTextNode(c ?? '')));
  return e;
};
const KEY = 'avc_history_v1', MAX = 25 * 1024 * 1024;
let mem = [];
const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch (e) { return mem; } };
const save = l => { mem = l; try { localStorage.setItem(KEY, JSON.stringify(l)); } catch (e) {} };
const fmt = b => b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : (b / 1048576).toFixed(1) + ' MB';

let view = 'home', cur = null, file = null, prep = null, err = {}, busy = '', confirmAll = false, urlVal = '', consent = false, ctl = null;
let svc = { providerConfigured: false, maxFrames: 3 };
fetch('/api/status').then(r => r.json()).then(s => { svc = s; render(); }).catch(() => {});

function clearPrep() {
  if (prep) prep.frames.forEach(f => URL.revokeObjectURL(f.url));
  prep = null; consent = false; busy = ''; err.send = '';
}
const go = (v, c) => { clearPrep(); view = v; cur = c || null; confirmAll = false; render(); scrollTo(0, 0); };

// ---------- validation (the server checks again) ----------
function validateFile(f) {
  if (!/\.(mp4|webm)$/i.test(f.name) || (f.type && !['video/mp4', 'video/webm'].includes(f.type))) return 'This file type is not supported. Choose an MP4 or WebM video.';
  if (f.size === 0) return 'This file is empty. Choose a different video.';
  if (f.size > MAX) return 'This video is ' + fmt(f.size) + '. The limit is 25 MB. Choose a shorter video.';
  return '';
}
function blockedHost(x) {
  x = x.toLowerCase();
  if (x.includes(':')) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(x)) { const [a, b] = x.split('.').map(Number); return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224; }
  return !x.includes('.') || /(^|\.)(localhost|local|internal|lan|home|corp)$/.test(x);
}
function validateUrl(s) {
  s = s.trim(); let u;
  try { u = new URL(s); } catch (e) { return { err: 'This is not a valid link. Paste the full address, starting with https://' }; }
  if (!['http:', 'https:'].includes(u.protocol)) return { err: 'Only http and https links are accepted.' };
  if (blockedHost(u.hostname)) return { err: 'This address points to a private or local network, so it is blocked for safety.' };
  return { u };
}

// ---------- real on-device work ----------
const readMeta = f => new Promise(res => {
  const u = URL.createObjectURL(f), v = document.createElement('video'); v.preload = 'metadata';
  const done = r => { URL.revokeObjectURL(u); res(r); };
  v.onloadedmetadata = () => done({ ok: true, d: v.duration, w: v.videoWidth, x: v.videoHeight });
  v.onerror = () => done({ ok: false }); setTimeout(() => done({ ok: false }), 8000); v.src = u;
});
async function extractFrames(f, n) {
  const u = URL.createObjectURL(f), v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = u;
  try {
    await new Promise((ok, no) => { v.onloadeddata = ok; v.onerror = () => no(new Error('decode')); setTimeout(() => no(new Error('timeout')), 10000); });
    const d = isFinite(v.duration) && v.duration > 0 ? v.duration : null, out = [];
    for (let i = 0; i < n; i++) {
      const t = d ? d * (i + 1) / (n + 1) : i + 0.5;
      await new Promise(ok => { v.onseeked = ok; v.currentTime = t; setTimeout(ok, 4000); });
      const sc = Math.min(1, 640 / (v.videoWidth || 640)), c = document.createElement('canvas');
      c.width = Math.round((v.videoWidth || 640) * sc); c.height = Math.round((v.videoHeight || 360) * sc);
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      const b = await new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.85));
      if (b) out.push({ blob: b, url: URL.createObjectURL(b) });
    }
    return out;
  } finally { URL.revokeObjectURL(u); }
}
function localChecks(f, m, frames) {
  const dur = m.ok ? (isFinite(m.d) ? m.d.toFixed(1) + ' seconds, ' : 'duration not reported, ') + m.w + '×' + m.x + ' pixels' : 'Your browser could not read this video.';
  return [
    { n: 'File type is MP4 or WebM', ok: true, d: f.name.split('.').pop().toLowerCase() },
    { n: 'File size within the 25 MB limit', ok: true, d: fmt(f.size) },
    { n: 'Basic video details read on your device', ok: m.ok, d: dur },
    { n: 'Still frames taken on your device', ok: frames.length > 0, d: frames.length + ' frame(s)' }
  ];
}

// ---------- actions ----------
function finish(s) {
  s.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6); s.ts = Date.now();
  save([s, ...load()].slice(0, 50)); file = null; urlVal = ''; go('result', s);
}
async function prepare() {
  busy = 'prep'; render();
  const m = await readMeta(file); let frames = [];
  try { frames = await extractFrames(file, svc.maxFrames); } catch (e) {}
  prep = { m, frames }; busy = ''; render();
}
const saveLocal = () => finish({ type: 'file', label: file.name, checks: localChecks(file, prep.m, prep.frames) });
async function send() {
  busy = 'send'; err.send = ''; ctl = new AbortController(); render();
  try {
    const fd = new FormData(); prep.frames.forEach((f, i) => fd.append('frames', f.blob, 'frame' + i + '.jpg'));
    const r = await fetch('/api/analyze', { method: 'POST', body: fd, signal: ctl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { err.send = j.message || 'The analysis could not be completed. Nothing was saved.'; busy = ''; render(); return; }
    finish({ type: 'file', label: file.name, checks: localChecks(file, prep.m, prep.frames), provider: j });
  } catch (e) {
    err.send = e.name === 'AbortError' ? 'Cancelled. Nothing was saved.' : 'Could not reach the server. Check your connection and try again.';
    busy = ''; render();
  }
}
function runUrl() {
  urlVal = $('#url').value; const v = validateUrl(urlVal);
  if (v.err) { err.url = v.err; render(); return; }
  err.url = '';
  finish({ type: 'url', label: v.u.hostname, checks: [
    { n: 'Link format is valid', ok: true, d: v.u.protocol.replace(':', '') + ' link' },
    { n: 'Address is not local or private (browser check only)', ok: true, d: 'The server never opens user links, so nothing is fetched.' },
    { n: 'Video opened or downloaded', ok: false, d: 'Not done. To check a video, upload the file or a screen recording of it.' }
  ] });
}

// ---------- pieces ----------
const logo = () => { const d = document.createElement('div'); d.innerHTML = '<svg width="56" height="56" viewBox="0 0 64 64" role="img" aria-label="AI Video Checker logo"><path d="M32 4 56 13v17c0 15-10 26-24 30C18 56 8 45 8 30V13z" fill="#2F6BFF"/><path d="M26 22v20l17-10z" fill="#fff"/><circle cx="46" cy="44" r="10" fill="#0B1B3A" stroke="#fff" stroke-width="3"/><path d="m41.5 44 3.2 3.2 5.3-6" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>'; return d; };
const notice = () => h('div', { class: 'note', role: 'note' }, h('b', {}, 'Prototype: '), svc.providerConfigured ? 'Checks a few still frames of your video with an outside service. It cannot confirm a whole video is real or fake.' : 'No analysis service is connected on this server yet, so results will say "Check unavailable".');
const when = t => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
function list(items, del) {
  return h('ul', { class: 'l' }, items.map(s => h('li', { class: 'row' },
    h('button', { class: 'open', onclick: () => go('result', s) }, s.label, h('small', {}, (s.type === 'file' ? 'Uploaded file' : 'Link') + ' · ' + when(s.ts) + (s.provider ? ' · Frame check' : ' · Analysis unavailable'))),
    del ? h('button', { class: 'btn d', 'aria-label': 'Delete scan ' + s.label, onclick: () => { save(load().filter(x => x.id !== s.id)); render(); } }, 'Delete') : null)));
}
const PL = { FAKE: ['fl', 'Flagged by provider'], SUSPICIOUS: ['pr', 'Uncertain'], AUTHENTIC: ['ok', 'No signs in this frame'], NOT_APPLICABLE: ['un', 'Check unavailable'], UNABLE_TO_EVALUATE: ['un', 'Check unavailable'], TIMED_OUT: ['un', 'Check unavailable'] };

function aiSection(s) {
  if (!s.provider) return secBox('AI-generation indicators', 'un', 'Check unavailable', 'Signs of AI-generated visuals or synthetic faces. No analysis was run for this scan.');
  const fr = s.provider.frames, n = fr.length, c = k => fr.filter(f => f.status === k).length;
  let cls = 'un', lab = 'Check unavailable';
  if (c('FAKE')) { cls = 'fl'; lab = 'Flagged in ' + c('FAKE') + ' of ' + n + ' frames'; }
  else if (c('SUSPICIOUS')) { cls = 'pr'; lab = 'Uncertain'; }
  else if (c('AUTHENTIC') === n) { cls = 'ok'; lab = 'No signs in the ' + n + ' sampled frames'; }
  else if (c('AUTHENTIC')) { cls = 'pr'; lab = 'Partly checked'; }
  const box = secBox('AI-generation indicators', cls, lab, 'Result from ' + s.provider.provider + ' on ' + n + ' still frame(s). Frames are single pictures, so this is a hint, not a verdict on the whole video.');
  fr.forEach(f => { const p = PL[f.status] || PL.UNABLE_TO_EVALUATE; box.append(h('div', { class: 'chk' }, h('b', { 'aria-hidden': 'true' }, f.index + '.'), h('span', {}, 'Frame ' + f.index + ': ' + p[1] + (f.score != null ? ' (score ' + f.score + ' of 100, higher means more likely manipulated)' : '') + (f.reason ? '. Note: ' + f.reason : '')))); });
  return box;
}
function secBox(t, cls, lab, d, extra) {
  return h('div', { class: 'card' }, h('h3', {}, t), h('span', { class: 'chip ' + cls }, lab), h('p', {}, d), extra ? h('p', {}, extra) : null);
}

// ---------- screens ----------
const V = {
  home() {
    const l = load().slice(0, 3);
    return h('section', {}, logo(), h('h1', {}, 'Check Before You Trust'),
      h('p', { class: 'lead' }, 'Investigate a suspicious video from Instagram, YouTube, Facebook or WhatsApp before you share it.'),
      h('div', { class: 'btns' }, h('button', { class: 'btn p', onclick: () => go('check') }, 'Check a video'), h('button', { class: 'btn g', onclick: () => { go('check'); setTimeout(() => $('#url') && $('#url').focus(), 50); } }, 'Paste video URL')),
      notice(), h('h2', {}, 'Recent scans'), l.length ? list(l, false) : h('p', { class: 'dim' }, 'No scans yet. Your checks will appear here.'));
  },
  check() {
    const fi = h('input', { type: 'file', id: 'f', class: 'hid', accept: 'video/mp4,video/webm,.mp4,.webm', onchange: e => { const f = e.target.files[0]; if (!f) return; clearPrep(); err.file = validateFile(f); file = err.file ? null : f; render(); } });
    let body;
    if (!file) body = h('button', { class: 'btn p', style: 'width:100%;margin-top:8px', onclick: () => fi.click() }, 'Choose a video');
    else if (busy === 'prep') body = h('div', {}, h('p', {}, h('b', {}, file.name), ' (' + fmt(file.size) + ')'), h('p', { role: 'status' }, h('span', { class: 'spin' }), 'Reading the video on your device…'));
    else if (!prep) body = h('div', {}, h('p', {}, h('b', {}, file.name), ' (' + fmt(file.size) + ')'), h('div', { class: 'btns' },
      h('button', { class: 'btn p', onclick: prepare }, 'Prepare check'), h('button', { class: 'btn s', onclick: () => fi.click() }, 'Replace video'), h('button', { class: 'btn s', onclick: () => { file = null; render(); } }, 'Remove video')));
    else {
      const ok = svc.providerConfigured && prep.frames.length > 0;
      body = h('div', {}, h('p', {}, h('b', {}, file.name), ' (' + fmt(file.size) + ')'),
        prep.frames.length ? h('div', { class: 'thumbs' }, prep.frames.map((f, i) => h('img', { src: f.url, alt: 'Frame ' + (i + 1) + ' taken from your video' }))) : h('p', { class: 'err' }, 'No frames could be taken from this video on your device.'),
        busy === 'send' ? h('div', {}, h('p', { role: 'status' }, h('span', { class: 'spin' }), 'Sending frames and waiting for the analysis. This can take up to a minute.'), h('button', { class: 'btn s', onclick: () => ctl && ctl.abort() }, 'Cancel')) : h('div', {},
          !svc.providerConfigured ? h('p', {}, 'No analysis service is connected on this server, so you can only save the local check.') : null,
          h('label', { class: 'agree' }, h('input', { type: 'checkbox', checked: consent ? '' : null, onchange: e => { consent = e.target.checked; render(); } }), h('span', {}, 'I understand these ' + prep.frames.length + ' still frames will be sent to Reality Defender, an outside company, for analysis. I will not send private or sensitive videos.')),
          h('div', { class: 'btns' },
            h('button', { class: 'btn p', disabled: ok && consent ? null : '', onclick: send }, 'Send frames for analysis'),
            h('button', { class: 'btn s', onclick: saveLocal }, 'Save local check only'),
            h('button', { class: 'btn s', onclick: () => { clearPrep(); file = null; render(); } }, 'Start over'))));
    }
    const up = h('div', { class: 'card' }, h('h3', {}, 'Upload a video'), h('p', {}, 'MP4 or WebM, up to 25 MB. For Instagram or YouTube videos, screen-record them first and upload the recording.'), fi, body,
      err.file ? h('p', { class: 'err', role: 'alert' }, err.file) : null, err.send ? h('p', { class: 'err', role: 'alert' }, err.send) : null);
    const ui = h('input', { type: 'url', id: 'url', inputmode: 'url', placeholder: 'https://…', 'aria-label': 'Video link', value: urlVal });
    const ur = h('div', { class: 'card' }, h('h3', {}, 'Paste a video link'), h('p', {}, 'Links are only checked for correct format. The video is not opened, downloaded or analyzed.'), ui,
      err.url ? h('p', { class: 'err', role: 'alert' }, err.url) : null, h('button', { class: 'btn p', style: 'width:100%', onclick: runUrl }, 'Check link'));
    return h('section', {}, h('h1', {}, 'Check a video'), notice(), up, ur);
  },
  result() {
    const s = cur, social = s.type === 'url' && /(instagram|youtube|youtu\.be|facebook|fb\.watch|tiktok|twitter|x\.com)/i.test(s.label);
    const pr = s.provider;
    const flagged = pr && pr.frames.some(f => f.status === 'FAKE');
    return h('section', {}, h('h1', {}, 'Scan result'), h('p', { class: 'dim' }, s.label + ' · ' + when(s.ts)),
      h('div', { class: 'note', role: 'status' }, pr ? h('span', {}, h('b', {}, 'Prototype: Frame-based result. '), 'From ' + pr.frames.length + ' still frame(s), not the full video.') : h('span', {}, h('b', {}, 'Prototype: Analysis unavailable. '), 'No AI or manipulation analysis was run.')),
      h('div', { class: 'card' }, h('h3', {}, 'Checks that actually ran'), s.checks.map(c => h('div', { class: 'chk' }, h('b', { 'aria-hidden': 'true' }, c.ok ? '✓' : '✕'), h('span', {}, h('b', { style: 'width:auto' }, c.n + (c.ok ? ' (done)' : ' (not done)')), h('br'), c.d))),
        pr ? h('div', { class: 'chk' }, h('b', { 'aria-hidden': 'true' }, '✓'), h('span', {}, h('b', { style: 'width:auto' }, 'Still frames analyzed by ' + pr.provider + ' (done)'))) : null),
      aiSection(s),
      secBox('Manipulation indicators', 'un', 'Check unavailable', 'Editing, audio changes and motion problems. Only still frames were analyzed, so these were not checked.'),
      secBox('Source verification', 'un', 'Check unavailable', 'Original publisher and provenance. Not checked.', social ? 'This link is from a platform that restricts direct access to videos.' : null),
      secBox('Potentially misleading claims', 'un', 'Check unavailable', 'Claims that need independent fact-checking. Not checked. A claim that is unverified is not the same as a claim that is false.'),
      h('div', { class: 'card' }, h('h3', {}, 'Overall assessment'),
        h('p', {}, pr ? (flagged ? 'The outside service flagged at least one sampled frame. Treat this as a warning sign, not proof.' : 'The outside service did not flag the sampled frames, or could not judge some of them. This does not prove the video is authentic.') : 'This prototype cannot say whether this video is real, AI-generated or edited. Not finding warning signs would not prove a video is authentic.'),
        h('p', {}, 'Next steps: find the original poster, search for the same clip from trusted news or fact-check sites, and wait to share until you can confirm it.')),
      h('div', { class: 'btns' }, h('button', { class: 'btn p', onclick: () => go('check') }, 'Check another video'), h('button', { class: 'btn g', onclick: () => go('history') }, 'Scan history')));
  },
  history() {
    const l = load();
    return h('section', {}, h('h1', {}, 'Scan history'),
      l.length ? h('div', {}, list(l, true),
        confirmAll ? h('div', { class: 'card', role: 'alertdialog' }, h('h3', {}, 'Delete all history?'), h('p', {}, 'This only removes the list saved in this browser. It does not delete copies you shared elsewhere or anything an outside service already received.'),
          h('div', { class: 'btns' }, h('button', { class: 'btn d', onclick: () => { save([]); confirmAll = false; render(); } }, 'Delete all'), h('button', { class: 'btn s', onclick: () => { confirmAll = false; render(); } }, 'Cancel')))
          : h('button', { class: 'btn g', onclick: () => { confirmAll = true; render(); } }, 'Delete all history'))
        : h('div', { class: 'card' }, h('h3', {}, 'Nothing here yet'), h('p', {}, 'Run a check and it will be listed here.'), h('button', { class: 'btn p', style: 'margin-top:8px', onclick: () => go('check') }, 'Check a video')));
  },
  privacy() {
    const q = (t, a) => h('div', { class: 'card' }, h('h3', {}, t), h('p', {}, a));
    return h('section', {}, h('h1', {}, 'Privacy'),
      q('What is processed', 'Your video is opened inside your browser to read its type, size and length and to take a few still pictures from it. Links are only checked for correct format.'),
      q('Is anything sent to an outside company?', 'Only if you tick the box and press "Send frames for analysis". Then a few still frames (not the whole video, and no sound) go through this site\'s server to Reality Defender. The server keeps them in memory only while they are sent and does not save them. Reality Defender keeps them under its own rules, so read its privacy terms.'),
      q('What is saved on this device', 'Only a short record per scan: file name or link address, time, which checks ran, and the provider\'s status and score for each frame. Videos and frames are never saved.'),
      q('How to delete it', 'Open Scan history to delete one scan or all of them. This does not remove anything an outside service already received.'),
      q('Please avoid sensitive videos', 'Do not send private videos, videos of children, or anything you would not want an outside company to receive.'),
      q('If a check fails', 'You will see a plain message and nothing is saved.'));
  }
};
function render() {
  $('#view').replaceChildren(V[view]());
  const a = view === 'check' || view === 'result' ? 'home' : view;
  document.querySelectorAll('nav button').forEach(b => b.setAttribute('aria-current', b.dataset.v === a ? 'page' : 'false'));
}
document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => go(b.dataset.v)));
render();
