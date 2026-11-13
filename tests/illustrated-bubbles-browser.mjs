// Manual pixel diagnostic: node tests/illustrated-bubbles-browser.mjs
// Uses an isolated HEADLESS browser/profile; never attaches to a user's browser.
// Set BUBBLE_TEST_BROWSER to a Chromium executable outside Windows.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const viewportWidth = Number(process.env.BUBBLE_TEST_WIDTH || 1000);
assert.ok(Number.isInteger(viewportWidth) && viewportWidth >= 360 && viewportWidth <= 1600, 'BUBBLE_TEST_WIDTH must be 360..1600');
const output = path.join(root, '.tmp', `bubble-browser-diagnostic-${viewportWidth}`);
fs.mkdirSync(output, { recursive: true });
const profile = path.join(output, `profile-${Date.now()}`);
fs.mkdirSync(profile);
const browser = process.env.BUBBLE_TEST_BROWSER || path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe');
if (!fs.existsSync(browser)) throw new Error('Set BUBBLE_TEST_BROWSER to an installed Chromium executable');
const row = (i) => `<div class="row me"><div class="msg-col"><div class="msg-line"><div class="bubble" id="bubble-${i}">${['喝点水，歇一小会儿。','窗边有一朵小小的云。','把今天的烦恼先放一放。','晚风轻轻吹过窗台。<br>明天一起去看看花，好不好？'][i-1]}</div></div></div></div>`;
const html = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/panel.css"><link rel="stylesheet" href="/skins.css"><style>body{display:block;padding:24px;background:#faf6ef;color:#334b36}.chat{display:block;width:min(500px,100%);height:auto;overflow:visible}.stream{height:auto;overflow:visible}.row{margin:8px 0}.sample{position:absolute;left:580px;top:80px}.native{position:absolute;left:580px;top:260px;width:194px}.clock{position:absolute;left:580px;top:450px;width:40px;height:40px;background:green;animation:tick 1s linear infinite}@keyframes tick{50%{background:orange;transform:translateX(30px)}}@media(max-width:600px){.sample{left:24px;top:620px}}</style><div class="chat" data-me-skin="ill-croc"><div class="stream">${[1,2,3,4].map(row).join('')}</div></div><div class="sample skin-sample"><span class="skin-sample-bubble me" data-me-skin="ill-croc" id="sample">来啦</span></div><img class="native" src="/illustrated-bubbles/croc-motion.webp" id="native"><div class="clock"></div>`;
const allowed = new Set([...['croc', 'fox', 'berry', 'whale'].flatMap(s => [`${s}.png`, `${s}-still.png`, `${s}-motion.webp`]), 'whale-bubbles-still.png', 'whale-bubbles-motion.webp']);
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let file, type;
  if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(html); }
  if (url.pathname === '/panel.css') { file = 'panel.css'; type = 'text/css'; }
  if (url.pathname === '/skins.css') { file = 'bubble-skins.css'; type = 'text/css'; }
  if (url.pathname.startsWith('/illustrated-bubbles/')) {
    const name = url.pathname.slice('/illustrated-bubbles/'.length);
    if (allowed.has(name)) { file = `illustrated-bubbles/${name}`; type = name.endsWith('.webp') ? 'image/webp' : 'image/png'; }
  }
  if (!file) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(fs.readFileSync(path.join(root, 'ui/assets', file)));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
let child, ws, watcher, readyTimer, session;
let nextId = 0;
const pending = new Map();
const listeners = new Map();
function call(method, params = {}, attached = true) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timeout });
    ws.send(JSON.stringify({ id, method, params, ...(attached && session ? { sessionId: session } : {}) }));
  });
}
function event(name) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { listeners.delete(name); reject(new Error(`Event timeout: ${name}`)); }, 10000);
    listeners.set(name, value => { clearTimeout(timeout); resolve(value); });
  });
}
try {
  const ready = new Promise((resolve, reject) => {
    readyTimer = setTimeout(() => reject(new Error('Headless browser did not publish a debug endpoint')), 30000);
    watcher = fs.watch(profile, (_event, filename) => {
      if (filename !== 'DevToolsActivePort') return;
      try {
        const [p, endpoint] = fs.readFileSync(path.join(profile, filename), 'utf8').trim().split(/\r?\n/);
        if (p && endpoint) { clearTimeout(readyTimer); watcher.close(); resolve(`ws://127.0.0.1:${p}${endpoint}`); }
      } catch { /* A file creation event may precede the completed write. */ }
    });
  });
  const stderr = fs.openSync(path.join(output, 'browser-stderr.log'), 'w');
  child = spawn(browser, ['--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-extensions', '--disable-background-networking', '--disable-component-update', 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', stderr] });
  fs.closeSync(stderr);
  const endpoint = await ready;
  ws = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  ws.addEventListener('message', e => {
    const message = JSON.parse(e.data);
    if (message.id && pending.has(message.id)) {
      const p = pending.get(message.id); pending.delete(message.id); clearTimeout(p.timeout);
      if (message.error) p.reject(new Error(JSON.stringify(message.error))); else p.resolve(message.result);
    } else if (message.method && listeners.has(message.method)) {
      const cb = listeners.get(message.method); listeners.delete(message.method); cb(message.params);
    }
  });
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' }, false);
  ({ sessionId: session } = await call('Target.attachToTarget', { targetId, flatten: true }, false));
  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: viewportWidth, height: 800, deviceScaleFactor: 1, mobile: false });
  const loaded = event('Page.loadEventFired');
  await call('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await loaded;
  const evaluate = async expression => (await call('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression })).result.value;
  const inspect = async () => JSON.parse(await evaluate(`JSON.stringify({reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches,hidden:document.hidden,elements:['bubble-1','bubble-4','sample'].map(id=>{const e=document.getElementById(id),s=getComputedStyle(e,'::after'),b=e.getBoundingClientRect();return{id,image:s.backgroundImage,paddingTop:getComputedStyle(e).paddingTop,paddingBottom:getComputedStyle(e).paddingBottom,box:[b.x,b.y,b.width,b.height]}})})`));
  async function capture(prefix, state) {
    const hashes = Object.fromEntries(state.elements.map(e => [e.id, []]));
    for (let i = 0; i < 3; i++) {
      await delay(350);
      for (const element of state.elements) {
        const [x,y,width,height] = element.box;
        const shot = await call('Page.captureScreenshot', { format: 'png', clip: {x:Math.max(0,Math.floor(x)-8), y:Math.max(0,Math.floor(y)-8), width:Math.ceil(width)+16, height:Math.ceil(height)+16, scale:1} });
        const data = Buffer.from(shot.data, 'base64');
        fs.writeFileSync(path.join(output, `${prefix}-${element.id}-${i}.png`), data);
        hashes[element.id].push(createHash('sha256').update(data).digest('hex'));
      }
    }
    return Object.fromEntries(Object.entries(hashes).map(([id,h])=>[id,new Set(h).size]));
  }
  const report = { viewportWidth, browser:await evaluate('navigator.userAgent'), normal:[], reduced:[] };
  // Control the test browser's media feature only; never changes Windows settings.
  await call('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  for (const side of ['me','ta']) for (const stem of ['croc','fox','berry','whale']) {
    await evaluate(`(async()=>{const sample=document.getElementById('sample');for(const e of [document.querySelector('.chat'),sample]){e.removeAttribute('data-me-skin');e.removeAttribute('data-ta-skin');e.setAttribute('data-${side}-skin','ill-${stem}')}sample.className='skin-sample-bubble ${side}';for(const e of document.querySelectorAll('.row'))e.className='row ${side}';const img=document.getElementById('native');img.src='/illustrated-bubbles/${stem}-motion.webp';await img.decode();return true})()`);
    const state = await inspect();
    if (stem === 'whale') {
      for (const e of state.elements) {
        assert.ok(e.image.includes('whale-bubbles-motion.webp'), `${side}/${e.id}: missing detail layer`);
        assert.ok(Math.abs(parseFloat(e.paddingTop) - (e.id === 'sample' ? 14.04 : 27.06)) < .1, `${side}/${e.id}: unexpected whale inset ${e.paddingTop}`);
      }
    }
    for (const e of state.elements) assert.ok(e.image.includes(`${stem}-motion.webp`), `${side}/${stem}/${e.id}: expected animation source`);
    const distinctFrames = await capture(`${side}-${stem}`, state);
    report.normal.push({side,stem,...state,distinctFrames});
    for (const [id,count] of Object.entries(distinctFrames)) assert.ok(count > 1, `${side}/${stem}/${id}: screenshots did not change`);
  }
  // The tail/head and lower-right bubbles must be separate painted regions.
  // Observe a full cycle so a deliberately quiet phase cannot masquerade as failure.
  const whale = (await inspect()).elements.find(e => e.id === 'bubble-4');
  const detailHashes = new Set();
  for (let i = 0; i < 6; i++) {
    await delay(1400);
    const [x,y,width,height] = whale.box;
    const shot = await call('Page.captureScreenshot', {format:'png',clip:{x:x+width-30,y:y+height-30,width:36,height:36,scale:1}});
    const bytes = Buffer.from(shot.data, 'base64');
    fs.writeFileSync(path.join(output, `whale-details-${i}.png`), bytes);
    detailHashes.add(createHash('sha256').update(bytes).digest('hex'));
  }
  report.detailFrames = detailHashes.size;
  assert.ok(report.detailFrames > 1, 'Whale detail layer did not visibly paint changing pixels');
  await call('Emulation.setEmulatedMedia', {features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  const state = await inspect();
  assert.equal(state.reducedMotion, true);
  for (const e of state.elements) assert.ok(e.image.includes('whale-still.png'), `${e.id}: reduced motion must use still image`);
  const distinctFrames = await capture('reduced', state);
  report.reduced.push({...state,distinctFrames});
  for (const [id,count] of Object.entries(distinctFrames)) assert.equal(count, 1, `${id}: reduced motion must remain static`);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({viewportWidth,browser:report.browser,normal:report.normal.map(({side,stem,distinctFrames})=>({side,stem,distinctFrames})),detailFrames:report.detailFrames,reduced:distinctFrames}, null, 2));
  console.log(`Screenshots saved under ${path.relative(root, output)}`);
} finally {
  clearTimeout(readyTimer); watcher?.close();
  if (ws?.readyState === WebSocket.OPEN) { try { await call('Browser.close', {}, false); } catch {} ws.close(); }
  child?.kill(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
