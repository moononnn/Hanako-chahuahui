// Isolated headless rendering. Never attaches to a user's browser or app data.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const root = fileURLToPath(new URL('../', import.meta.url));
const width = Number(process.env.BUBBLE_TEST_WIDTH || 1000);
const out = path.join(root, '.tmp', `gallery-browser-${width}`);
fs.mkdirSync(out, { recursive:true });
const profile = path.join(out, `profile-${Date.now()}`); fs.mkdirSync(profile);
const stems=['rabbit','capybara','jellyfish','chick','cloud','letter','pixel','aquarium'];
const names=['桃桃垂耳兔','奶茶水豚','月光水母','黄油小鸡','晴空云糖','折角情书','像素心跳','海盐水族箱'];
const text='今晚先把烦恼放一放，明天再一起看看新开的花。慢慢走，不着急，这段长一点的话也应当自然换行。';
const section=(stem,i)=>`<section><h2>${names[i]}</h2>${['ta','me'].map(side=>`<div class="chat" data-${side}-skin="art-${stem}"><div class="row ${side}"><div class="msg-col"><div class="msg-line"><div class="bubble ill-tight" id="${stem}-${side}-short">晚安</div></div></div></div><div class="row ${side}"><div class="msg-col"><div class="msg-line"><div class="bubble" id="${stem}-${side}-long">${text}</div></div></div></div></div>`).join('')}<div class="skin-sample"><span class="skin-sample-bubble ta" data-ta-skin="art-${stem}" id="${stem}-sample">来啦</span></div></section>`;
const mobileSource=fs.readFileSync(path.join(root,'ui/mobile.html'),'utf8');
const phoneMediaCss=(mobileSource.replace(/\/\*[\s\S]*?\*\//g,'').match(/#chat[^{}]*\.bubble\.ch-media[^{]*\{[^{}]*\}/g)||[]).join('\n');
assert.ok(phoneMediaCss.includes('--art-photo-right'),'Phone photo override missing');
const html=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/panel.css"><link rel="stylesheet" href="/assets/bubble-skins.css"><link rel="stylesheet" href="/assets/bubble-gallery.css"><style>${phoneMediaCss}</style><style>html{height:auto;overflow:auto}body{display:block;height:auto;min-height:100vh;overflow:visible;margin:0;padding:24px;background:#f8f4ec;color:#5b5147;font-family:system-ui}h1{font-size:22px;margin:0 0 28px}h2{font-size:15px;margin:0 0 24px;color:#786754}main{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}section{background:#fffdf8;padding:20px;border-radius:16px;min-width:0}.chat{display:block;width:100%;height:auto;overflow:visible}.row{margin:30px 0}.msg-col{max-width:100%}.bubble{font-size:15px;line-height:1.65}.skin-sample{padding:7px;width:96px;box-sizing:border-box;min-height:50px}.skin-sample-bubble{display:inline-block;position:relative}@media(max-width:600px){body{padding:16px}main{grid-template-columns:1fr}section{padding:18px}}</style><h1>气泡新装 · 四种角色，四种轮廓</h1><main>${stems.map(section).join('')}</main>`;
const server=http.createServer((req,res)=>{
 const url=new URL(req.url,'http://localhost');
 if(url.pathname==='/'){res.writeHead(200,{'content-type':'text/html'});return res.end(html)}
 if(!/^\/assets\/[A-Za-z0-9._\/-]+$/.test(url.pathname)||url.pathname.includes('..')){res.writeHead(404);return res.end()}
 const file=path.join(root,'ui',url.pathname.slice(1));
 if(!fs.existsSync(file)){res.writeHead(404);return res.end()}
 const type=file.endsWith('.css')?'text/css':file.endsWith('.webp')?'image/webp':'image/png';
 res.writeHead(200,{'content-type':type,'cache-control':'no-store'});res.end(fs.readFileSync(file));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=process.env.BUBBLE_TEST_BROWSER||path.join(process.env['ProgramFiles(x86)']||'C:/Program Files (x86)','Microsoft/Edge/Application/msedge.exe');
assert.ok(fs.existsSync(browser),'Chromium executable required');
let ws,child,watcher,timer,session;let seq=0;const pending=new Map(),events=new Map();
const call=(method,params={},attached=true)=>new Promise((resolve,reject)=>{const id=++seq;const timeout=setTimeout(()=>{pending.delete(id);reject(Error('CDP timeout: '+method))},20000);pending.set(id,{resolve,reject,timeout});ws.send(JSON.stringify({id,method,params,...(attached&&session?{sessionId:session}:{})}))});
const event=name=>new Promise(resolve=>events.set(name,resolve));
try{
 const ready=new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(Error('No headless endpoint')),30000);watcher=fs.watch(profile,(_e,f)=>{if(f!=='DevToolsActivePort')return;try{const[p,e]=fs.readFileSync(path.join(profile,f),'utf8').trim().split(/\r?\n/);if(p&&e){clearTimeout(timer);watcher.close();resolve(`ws://127.0.0.1:${p}${e}`)}}catch{}})});
 child=spawn(browser,['--headless=new','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--disable-sync','--disable-extensions','--disable-background-networking','about:blank'],{windowsHide:true,stdio:'ignore'});
 ws=new WebSocket(await ready);await new Promise((r,j)=>{ws.addEventListener('open',r,{once:true});ws.addEventListener('error',j,{once:true})});
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timeout);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result)}else if(events.has(m.method)){const cb=events.get(m.method);events.delete(m.method);cb(m.params)}});
 const{targetId}=await call('Target.createTarget',{url:'about:blank'},false);({sessionId:session}=await call('Target.attachToTarget',{targetId,flatten:true},false));
 await call('Page.enable');await call('Runtime.enable');
 await call('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
 const evaluate=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value};
 const navigate=async()=>{const loaded=event('Page.loadEventFired');await call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`});await loaded;await delay(150)};
 const inspect=()=>evaluate(`Array.from(document.querySelectorAll('.bubble,.skin-sample-bubble')).map(e=>{const b=e.getBoundingClientRect(),s=getComputedStyle(e),a=getComputedStyle(e,'::after'),p=getComputedStyle(e,'::before');const range=document.createRange();range.selectNodeContents(e);const t=range.getBoundingClientRect();return{id:e.id,box:{x:b.x,y:b.y,width:b.width,height:b.height},text:{x:t.x,y:t.y,width:t.width,height:t.height},top:parseFloat(s.paddingTop),bottom:parseFloat(s.paddingBottom),left:parseFloat(s.paddingLeft),right:parseFloat(s.paddingRight),motion:a.backgroundImage,base:p.borderImageSource,transform:s.transform,overflowPx:e.scrollWidth-e.clientWidth}})`);
 await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});await navigate();
 const normal=await inspect();assert.equal(normal.length,40);
 for(const e of normal){assert.ok(e.motion.includes('-motion.webp'),`${e.id}: no motion`);assert.ok(e.overflowPx<=8,`${e.id}: unexpected decorative overflow ${e.overflowPx}`);assert.ok(e.top>=8&&e.top<=34,`${e.id}: excess top ${e.top}`);assert.ok(e.bottom>=8&&e.bottom<=24,`${e.id}: excess bottom ${e.bottom}`);assert.ok(e.text.width>0&&e.text.x>=e.box.x&&e.text.x+e.text.width<=e.box.x+e.box.width+1,`${e.id}: text outside`);assert.equal(e.transform,'none',`${e.id}: text transforms`)}
 const media=await evaluate(`(()=>{const box=document.createElement('aside');box.style.cssText='position:absolute;left:-10000px;top:0';const sources=['rabbit','capybara','jellyfish','chick','cloud','letter','pixel','aquarium'];box.innerHTML=sources.map(s=>'<div data-ta-skin="art-'+s+'"><div class="row ta">'+['voice-transcript','is-recalled','sticker','video','audio','photo'].map(k=>'<div class="bubble '+(k==='photo'?'ch-media ': '')+(k==='voice-transcript'||k==='is-recalled'?k:'')+'" data-case="'+s+'-'+k+'">'+(k==='sticker'?'<span class="sticker">图</span>':k==='video'||k==='audio'?'<'+k+'></'+k+'>':k==='photo'?'<span class="message-image">图片</span>':'文字')+'</div>').join('')+'</div></div>').join('');document.body.append(box);return Array.from(box.children).flatMap(parent=>{parent.id='chat';const rows=Array.from(parent.querySelectorAll('.bubble')).map(e=>{const s=getComputedStyle(e);return{id:e.dataset.case,base:getComputedStyle(e,'::before').borderImageSource,motion:getComputedStyle(e,'::after').backgroundImage,left:parseFloat(s.paddingLeft),right:parseFloat(s.paddingRight),top:parseFloat(s.paddingTop),bg:s.backgroundColor}});parent.removeAttribute('id');return rows})})()`);
 for(const e of media){if(e.id.endsWith('-photo')){assert.ok(e.base.includes('-base.png'),e.id+': photo shell missing');assert.ok(e.left>=16&&e.right>=16&&e.top>=13,e.id+': phone photo gutter overridden '+JSON.stringify(e))}else{assert.ok(!e.base.includes('/art-')&&!e.motion.includes('/art-'),e.id+': excluded media got illustrated shell');if(e.id.endsWith('-voice-transcript'))assert.ok(e.bg!=='rgba(0, 0, 0, 0)'&&e.bg!=='transparent',e.id+': transcript backdrop missing')}}
 const frames={};for(const stem of stems)frames[stem]=[];
 for(const stem of stems){
  // Observe one visible element at a time and restart only its decoder clock.
  // Offscreen WebP decoders may pause; intentional five-second rests are not failures.
  await evaluate(`(async()=>{const e=document.getElementById('${stem}-ta-long');e.scrollIntoView({block:'center'});const url='/assets/illustrated-bubbles/art-${stem}-motion.webp?case='+Date.now();e.style.setProperty('--art-motion','url("'+url+'")');const image=new Image();image.src=url;await image.decode();return true})()`);
  const b=await evaluate(`(()=>{const b=document.getElementById('${stem}-ta-long').getBoundingClientRect();return{x:b.x+scrollX,y:b.y+scrollY,width:b.width,height:b.height}})()`);
  for(let i=0;i<5;i++){await delay(i===0?40:360);const shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:Math.max(0,Math.floor(b.x)-8),y:Math.max(0,Math.floor(b.y)-16),width:Math.ceil(b.width)+16,height:Math.ceil(b.height)+32,scale:1}});const file=path.join(out,`${stem}-${i}.png`);fs.writeFileSync(file,Buffer.from(shot.data,'base64'));frames[stem].push(file)}
 }
 const metric=spawnSync('python',['-c',`from PIL import Image,ImageChops\nimport json,sys\na=json.loads(sys.argv[1]);o={}\nfor k,files in a.items():\n base=Image.open(files[0]).convert('RGB');n=0\n for f in files[1:]:\n  d=ImageChops.difference(base,Image.open(f).convert('RGB'));n=max(n,sum(max(p)>3 for p in d.getdata()))\n o[k]=n\nprint(json.dumps(o))`,JSON.stringify(frames)],{encoding:'utf8',windowsHide:true});assert.equal(metric.status,0,metric.stderr);const motionPixels=JSON.parse(metric.stdout);for(const[k,n]of Object.entries(motionPixels))assert.ok(n>=8,`${k}: only ${n} visible moving pixels`);
 await evaluate('scrollTo(0,0)'); const layout=await call('Page.getLayoutMetrics');const shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,clip:{x:0,y:0,width,height:Math.ceil(layout.cssContentSize.height),scale:1}});fs.writeFileSync(path.join(out,'gallery.png'),Buffer.from(shot.data,'base64'));
 await call('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await navigate();const reduced=await inspect();for(const e of reduced){assert.ok(e.motion.includes('-still.png')&&!e.motion.includes('.webp'),`${e.id}: reduced source`)}
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({width,normal,reduced,motionPixels},null,2));
 console.log(JSON.stringify({ok:true,width,bubbles:normal.length,motionPixels,screenshot:path.join(out,'gallery.png')}));
}finally{clearTimeout(timer);watcher?.close();for(const p of pending.values())clearTimeout(p.timeout);try{if(ws?.readyState===WebSocket.OPEN)await call('Browser.close',{},false)}catch{}ws?.close();child?.kill();await new Promise(r=>server.close(r))}
