"""Build eight original generated bubble skins; Pillow is build-time only.
Initial: python scripts/build-bubble-gallery.py --sources .tmp/bubble-gallery-sources.json
Rebuild: python scripts/build-bubble-gallery.py [--only rabbit]
No network, model requests, or production chat access.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw, ImageEnhance

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'ui/assets/illustrated-bubbles'
PAD = 24
# Coordinates refer to the alpha-cropped, 768px-wide generated artwork.
SKINS = {
 'rabbit': dict(slices=[218,340,110,130], anchor='tr', top=27, bottom=15, ink='#735044', masks=[(443,5,528,111),(680,60,768,202)], face=(524,45,679,169)),
 'capybara': dict(slices=[205,320,100,130], anchor='tr', top=26, bottom=15, ink='#705341', masks=[(594,0,685,48)], face=(535,50,738,165)),
 'jellyfish': dict(slices=[270,310,105,130], anchor='tr', top=29, bottom=15, ink='#695476', masks=[(663,151,768,268)], face=(525,43,725,146)),
 'chick': dict(slices=[205,320,105,130], anchor='tr', top=26, bottom=15, ink='#7b5c31', masks=[(514,60,569,143),(693,70,768,149)], face=(565,25,699,135)),
 'cloud': dict(slices=[96,205,115,175], anchor='br', top=15, bottom=18, ink='#526e83', masks=[(642,246,758,312)]),
 'letter': dict(slices=[90,150,68,155], anchor='tl', top=15, bottom=15, ink='#795944', masks=[(0,0,125,44)]),
 'pixel': dict(slices=[52,175,67,105], anchor='br', top=13, bottom=17, ink='#576747', masks=[(692,137,768,189)], glow=True),
 'aquarium': dict(slices=[52,180,69,135], anchor='br', top=13, bottom=18, ink='#45736e', masks=[(683,124,748,174)]),
}

def normalize(source):
 im = Image.open(source).convert('RGBA')
 alpha = im.getchannel('A')
 if alpha.getextrema()[0] == 255:
  raise ValueError('Expected genuine transparent source, not an opaque backdrop')
 bbox = alpha.point(lambda v: 255 if v > 40 else 0).getbbox()
 if not bbox: raise ValueError('Empty artwork')
 im = im.crop(bbox)
 return im.resize((768, round(im.height * 768 / im.width)), Image.Resampling.LANCZOS)

def pulse(t):
 return math.sin(math.pi*t/2.6)**2 if 0 < t < 2.6 else 0

def visible(im):
 bg = Image.new('RGBA', im.size, '#fff9ef'); bg.alpha_composite(im.convert('RGBA'))
 return bg.convert('RGB')

def build(name, spec, source):
 original = DEST / f'art-{name}.png'
 art = normalize(source) if source else Image.open(original).convert('RGBA')
 if source: art.save(original)
 w,h = art.size; top,right,bottom,left = spec['slices']; anchor = spec['anchor']
 assert top+bottom < h and left+right < w
 tw = left if anchor.endswith('l') else right
 th = top if anchor.startswith('t') else bottom
 x0 = 0 if anchor.endswith('l') else w-tw
 y0 = 0 if anchor.startswith('t') else h-th
 tile = Image.new('RGBA',(tw+PAD*2,th+PAD*2))
 tile.paste(art.crop((x0,y0,x0+tw,y0+th)),(PAD,PAD))
 base = art.copy(); base.paste((0,0,0,0),(x0,y0,x0+tw,y0+th))
 base.save(DEST/f'art-{name}-base.png')
 mask = Image.new('L',tile.size); draw=ImageDraw.Draw(mask)
 local = lambda box: tuple(c+PAD-(x0 if i%2==0 else y0) for i,c in enumerate(box))
 for box in spec['masks']: draw.rectangle(local(box),fill=255)
 if spec.get('face'): draw.rectangle(local(spec['face']),fill=0)
 # Frame joints remain exact, independently of the animated part mask.
 if anchor.startswith('t'): draw.rectangle((0,PAD+th-8,tile.width,tile.height),fill=0)
 else: draw.rectangle((0,0,tile.width,PAD+8),fill=0)
 if anchor.endswith('r'): draw.rectangle((0,0,PAD+8,tile.height),fill=0)
 else: draw.rectangle((PAD+tw-8,0,tile.width,tile.height),fill=0)
 def frame(t):
  amount = pulse(t)
  if not amount: return tile.copy()
  if spec.get('glow'):
   moved = ImageEnhance.Brightness(tile).enhance(1+.5*amount)
  else:
   mesh=[]
   def sample(x,y):
    u,v=x-PAD+x0,y-PAD+y0
    dx=dy=0.
    for i,(a,b,c,d) in enumerate(spec['masks']):
     cx,cy=(a+c)/2,(b+d)/2
     radius=math.hypot((u-cx)/max(1,(c-a)/2),(v-cy)/max(1,(d-b)/2))
     weight=max(0,1-radius)**.5
     dx += 16*amount*math.sin(2*math.pi*t/1.3+i)*weight
     dy += 11*amount*math.sin(2*math.pi*t/1.8+i)*weight
    return x+dx,y+dy
   for y in range(0,tile.height,5):
    for x in range(0,tile.width,5):
     ex,ey=min(x+5,tile.width),min(y+5,tile.height)
     mesh.append(((x,y,ex,ey),tuple(v for p in [sample(x,y),sample(x,ey),sample(ex,ey),sample(ex,y)] for v in p)))
   moved=tile.transform(tile.size,Image.Transform.MESH,mesh,Image.Resampling.BICUBIC)
  return Image.composite(moved,tile,mask)
 size=(math.ceil(tile.width/2),math.ceil(tile.height/2))
 frames=[frame(i/12).resize(size,Image.Resampling.LANCZOS) for i in range(33)]
 frames[-1]=frames[0].copy()
 still=DEST/f'art-{name}-still.png'; motion=DEST/f'art-{name}-motion.webp'
 frames[0].save(still)
 frames[0].save(motion,save_all=True,append_images=frames[1:],duration=[83]*32+[5344],loop=0,lossless=True,method=4)
 with Image.open(motion) as check:
  first=visible(check); assert ImageChops.difference(first,visible(frames[0])).getbbox() is None
  changes={.11:0,.15:0}
  for i in range(1,check.n_frames):
   check.seek(i)
   current=visible(check)
   if spec.get('face'):
    a,b,c,d=local(spec['face']); face=(math.ceil((a+6)/2),math.ceil((b+6)/2),math.floor((c-6)/2),math.floor((d-6)/2))
    assert ImageChops.difference(current.crop(face),first.crop(face)).getbbox() is None, f'{name}: expression moved'
   for unit in changes:
    view=(max(1,round(tile.width*unit)),max(1,round(tile.height*unit)))
    delta=ImageChops.difference(current.resize(view),first.resize(view))
    changes[unit]=max(changes[unit],sum(max(p)>3 for p in getattr(delta,'get_flattened_data',delta.getdata)()))
  assert min(changes.values())>=8, f'{name}: local motion too faint ({changes})'
  count=check.n_frames
 return dict(name=name,id=f'art-{name}',size=[w,h],slices=spec['slices'],anchor=anchor,corner=[tw,th],raster=list(size),frames=count,changedByUnit=changes,changedPixels=max(changes.values()),sourceSha256=hashlib.sha256(original.read_bytes()).hexdigest())

def css():
 lines=['/* Generated by scripts/build-bubble-gallery.py. Original illustration pixels, not CSS-drawn mascots. */']
 for name,s in SKINS.items():
  t,r,b,l=s['slices'];tw=l if s['anchor'].endswith('l') else r;th=t if s['anchor'].startswith('t') else b
  for side in ['me','ta']:
   horizontal=s['anchor'][1]; horizontal=('l' if horizontal=='r' else 'r') if side=='me' else horizontal
   edges=dict(top='auto',right='auto',bottom='auto',left='auto'); edges['top' if s['anchor'][0]=='t' else 'bottom']='calc(-24px * var(--art-unit))';edges['left' if horizontal=='l' else 'right']='calc(-24px * var(--art-unit))'
   lines.append(f'[data-{side}-skin="art-{name}"] {{\n  --skin-{side}-bg: var(--bubble-{side}-bg, {"#e8f1e9" if side=="me" else "#fffaf2"}); --skin-{side}-border-color: transparent; --skin-{side}-shadow: none; --skin-{side}-fg: {s["ink"]};\n}}')
   selector=f'[data-{side}-skin="art-{name}"] .row.{side} .bubble, .skin-sample-bubble[data-{side}-skin="art-{name}"].{side}'
   lines.append(selector+' { '+f'--art-base: url("illustrated-bubbles/art-{name}-base.png"); --art-motion: url("illustrated-bubbles/art-{name}-motion.webp"); --art-still: url("illustrated-bubbles/art-{name}-still.png"); --art-t: {t}; --art-r: {r}; --art-b: {b}; --art-l: {l}; --art-w: {tw}; --art-h: {th}; --art-slices: {t} {r} {b} {l}; --art-text-top: {s["top"]}px; --art-text-bottom: {s["bottom"]}px; --art-photo-left: {r if side=="me" else l}; --art-photo-right: {l if side=="me" else r}; --art-ink: {s["ink"]}; --art-flip: {"-1" if side=="me" else "1"}; '+ ' '.join(f'--art-corner-{k}: {v};' for k,v in edges.items())+' }')
 scope=':is([data-me-skin^="art-"] .row.me .bubble, [data-ta-skin^="art-"] .row.ta .bubble, .skin-sample-bubble[data-me-skin^="art-"].me, .skin-sample-bubble[data-ta-skin^="art-"].ta)'
 guard=':not(.voice-transcript, .is-recalled, :has(.sticker, video, audio))'
 q=scope+guard
 lines.extend([
 '[data-me-skin^="art-"], [data-ta-skin^="art-"] { --art-unit: .15; }',
 '.skin-sample-bubble[data-me-skin^="art-"], .skin-sample-bubble[data-ta-skin^="art-"] { --art-unit: .12; }',
 q+' { position: relative; isolation: isolate; overflow: visible; background: transparent !important; border: 0; box-shadow: none !important; color: var(--art-ink); padding: var(--art-text-top) 16px var(--art-text-bottom); min-inline-size: 92px; animation: none !important; }',
 q+'.bubble.ill-tight { --art-unit: .11; padding: max(12px, calc(var(--art-text-top) * .76)) 12px max(12px, calc(var(--art-text-bottom) * .8)); min-inline-size: 70px; }',
 q+'::before { content: ""; position: absolute; inset: 0; display: block; pointer-events: none; z-index: -2; background: transparent; border-style: solid; border-color: transparent; border-width: calc(var(--art-t) * var(--art-unit) * 1px) calc(var(--art-r) * var(--art-unit) * 1px) calc(var(--art-b) * var(--art-unit) * 1px) calc(var(--art-l) * var(--art-unit) * 1px); border-image-source: var(--art-base); border-image-slice: var(--art-slices) fill; border-image-width: 1; transform: scaleX(var(--art-flip)); animation: none !important; box-shadow: none; filter: none; }',
 q+'::after { content: ""; position: absolute; display: block; pointer-events: none; z-index: -1; top: var(--art-corner-top); right: var(--art-corner-right); bottom: var(--art-corner-bottom); left: var(--art-corner-left); width: calc((var(--art-w) + 48) * var(--art-unit) * 1px); height: calc((var(--art-h) + 48) * var(--art-unit) * 1px); background: var(--art-frame, var(--art-motion)) center / 100% 100% no-repeat; border: 0; border-radius: 0; transform: scaleX(var(--art-flip)); animation: none !important; box-shadow: none; filter: none; }',
 q+'.skin-sample-bubble { padding: max(12px, calc(var(--art-text-top) * .8)) 12px 14px; min-inline-size: min(84px, 100%); max-inline-size: 100%; box-sizing: border-box; }',
 q+':has(.message-image, .ch-img) { padding-right: max(16px, calc(var(--art-photo-right) * var(--art-unit) * 1px)); padding-left: max(16px, calc(var(--art-photo-left) * var(--art-unit) * 1px)); padding-bottom: max(var(--art-text-bottom), calc(var(--art-b) * var(--art-unit) * 1px)); }',
 '@media (prefers-reduced-motion: reduce) { '+q+' { --art-frame: var(--art-still); } }',
 ])
 return '\n\n'.join(lines)+'\n'

def main():
 parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--sources',type=Path);parser.add_argument('--only',choices=list(SKINS));args=parser.parse_args()
 DEST.mkdir(parents=True,exist_ok=True)
 sources=json.loads(args.sources.read_text(encoding='utf8')) if args.sources else {}
 old={r['name']:r for r in json.loads((DEST/'art-manifest.json').read_text())} if (DEST/'art-manifest.json').exists() else {}
 for name,s in SKINS.items():
  if args.only and name!=args.only: continue
  old[name]=build(name,s,sources.get(name));print(json.dumps(old[name]))
 (DEST/'art-manifest.json').write_text(json.dumps([old[n] for n in SKINS if n in old],indent=2),encoding='utf8')
 (DEST.parent/'bubble-gallery.css').write_text(css(),encoding='utf8')
if __name__=='__main__':main()
