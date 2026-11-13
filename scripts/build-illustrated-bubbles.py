"""Postprocess the approved original shells; Pillow is a build-time dependency only.

First build: python scripts/build-illustrated-bubbles.py --source <original-PNG-directory>
Rebuild: python scripts/build-illustrated-bubbles.py
No generative model, network requests, or user data are involved.
"""
import argparse
import hashlib
import json
import math
import shutil
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw

PAD = 24
FPS = 12
SHELLS = {
    'croc': ([55, 45, 35, 25], False, .52, .35, 1.8, 5.2),
    'fox': ([55, 45, 35, 20], False, .60, .36, 2.6, 6.0),
    'berry': ([44, 34, 35, 21], False, .62, .45, 2.0, 5.4),
    'whale': ([48, 27, 34, 44], True, .48, .34, 7.4, 8.6),
}


def smooth(t):
    t = max(0., min(1., t))
    return t * t * (3 - 2 * t)


def pulse(t, start, end):
    return math.sin(math.pi * (t - start) / (end - start)) ** 2 if start < t < end else 0.


def whale_displacement(u, v, t):
    """Independent, feathered part masks in the approved artwork's coordinates.

    This deforms existing pixels only: no new eyes/illustration are painted.
    The original sleepy eye gently squeezes; the head and body stay pinned.
    """
    def ellipse(cx, cy, rx, ry):
        return smooth((1 - math.hypot((u - cx) / rx, (v - cy) / ry)) / .28)

    def wag(start, end):
        if not start < t < end:
            return 0.
        phase = (t - start) / (end - start)
        return math.sin(4 * math.pi * phase) * math.sin(math.pi * phase) ** 2

    tail = .14 * wag(.15, 1.85) + .09 * wag(6.2, 7.3)
    tw = ellipse(62, 53, 65, 59) * smooth((116 - u) / 18) * smooth((106 - v) / 18)
    dx, dy = -tail * (v - 88) * tw, tail * (u - 100) * tw
    fin = .18 * math.sin(2 * math.pi * (t - 2.) / 1.25) * pulse(t, 2., 3.25)
    fw = ellipse(119, 134, 48, 35)
    dx += -fin * (v - 115) * fw
    dy += fin * (u - 151) * fw
    blink = max(pulse(t, 4.3, 4.62), .72 * pulse(t, 4.84, 5.08))
    eye = ellipse(176, 87, 27, 19)
    dy += (v - 95) * (.7 * blink) * eye
    return dx, dy


def build_whale_bubbles(art, target, period):
    """Copy an existing painted bubble, then float/fade it beside the frame.

    The ellipse is only an extraction mask, not newly drawn illustration.
    Both frame and original bubbles remain unmodified beneath the extra layer.
    """
    w, h = art.size
    bubble = art.crop((round(w * .925), round(h * .721), round(w * .992), round(h * .817)))
    mask = Image.new('L', (bubble.width * 4, bubble.height * 4))
    ImageDraw.Draw(mask).ellipse((-4, -4, mask.width + 3, mask.height + 3), fill=255)
    mask = mask.resize(bubble.size, Image.Resampling.LANCZOS)
    bubble.putalpha(ImageChops.multiply(bubble.getchannel('A'), mask))
    count = math.ceil(period * FPS)
    frames = []
    for i in range(count):
        t = i / FPS
        canvas = Image.new('RGBA', (128, 208))
        for start, duration, scale, x in [(3.7, 1.8, .7, 76), (5.05, 1.85, .46, 96)]:
            phase = (t - start) / duration
            if not 0 < phase < 1:
                continue
            size = tuple(max(1, round(n * scale)) for n in bubble.size)
            sprite = bubble.resize(size, Image.Resampling.LANCZOS)
            alpha = math.sin(math.pi * phase) ** .8
            sprite.putalpha(sprite.getchannel('A').point(lambda a: round(a * alpha)))
            canvas.alpha_composite(sprite, (x + round(6 * smooth(phase)), round(155 - 64 * smooth(phase))))
        frames.append(canvas.resize((64, 104), Image.Resampling.LANCZOS))
    frames[0].save(target / 'whale-bubbles-still.png')
    frames[0].save(target / 'whale-bubbles-motion.webp', save_all=True,
                   append_images=frames[1:], duration=round(1000 / FPS), loop=0,
                   lossless=True, method=4, background=(0, 0, 0, 0))
    with Image.open(target / 'whale-bubbles-motion.webp') as check:
        assert check.is_animated
        assert check.getchannel('A').getbbox() is None
        assert any(check.seek(i) is None and check.convert('RGBA').getchannel('A').getbbox()
                   for i in range(1, check.n_frames))
        return check.n_frames


def visible(im):
    bg = Image.new('RGBA', im.size, 'white')
    return Image.alpha_composite(bg, im.convert('RGBA')).convert('RGB')


def build(name, spec, source, target):
    original = source / (name + '.png')
    dest = target / (name + '.png')
    if original.resolve() != dest.resolve():
        if dest.exists() and dest.read_bytes() != original.read_bytes():
            raise ValueError('Refusing to overwrite different original artwork: ' + name)
        if not dest.exists():
            shutil.copy2(original, dest)
    art = Image.open(dest).convert('RGBA')
    percents, left, cx, cy, active, period = spec
    width, height = art.size
    top, right, bottom, lft = [round((height if i % 2 == 0 else width) * p / 100) for i, p in enumerate(percents)]
    tw, th = (lft if left else right), top
    tile = art.crop((0 if left else width - tw, 0, tw if left else width, th))
    still = Image.new('RGBA', (tw + PAD * 2, th + PAD * 2))
    still.paste(tile, (PAD, PAD))
    sw, sh = still.size

    def frame(t):
        if t == 0 or t >= active:
            return still.copy()
        p = pulse(t, 0, active)
        if name == 'croc':
            dx, dy, angle = -2 * p, 20 * p, 0
        elif name == 'fox':
            dx, dy, angle = 0, 0, .09 * math.sin(2 * math.pi * t / active) * math.sin(math.pi * t / active)
        elif name == 'berry':
            dx, dy, angle = 0, 22 * pulse(t, 0, .9) + 14 * pulse(t, .95, 1.85), 0
        else:
            # Whale movement is confined to the independent part fields below.
            dx, dy, angle = 0, 0, 0

        def sample(x, y):
            u, v = x - PAD, y - PAD
            if name == 'whale':
                px, py = whale_displacement(u, v, t)
                return x + px, y + py
            radius = math.hypot((u - tw * cx) / (tw * .62), (v - th * cy) / (th * .62))
            weight = smooth((1.10 - radius) / .55)
            weight *= smooth((th - v - 8) / (th * .18))
            weight *= smooth(((tw - u) if left else u) / (tw * .14))
            return (x + (dx - angle * (v - th * .70)) * weight,
                    y + (dy + angle * (u - tw * cx)) * weight)

        mesh = []
        step = 6 if name == 'whale' else 18
        for y in range(0, sh, step):
            for x in range(0, sw, step):
                x1, y1 = min(x + step, sw), min(y + step, sh)
                points = [sample(x, y), sample(x, y1), sample(x1, y1), sample(x1, y)]
                mesh.append(((x, y, x1, y1), tuple(c for point in points for c in point)))
        result = still.transform(still.size, Image.Transform.MESH, mesh, Image.Resampling.BICUBIC)
        if name == 'whale':
            # Restore every pixel outside the moving parts, including antialiasing.
            # Even an identity RGBA bicubic transform can change transparent RGB.
            moving = Image.new('L', still.size)
            draw = ImageDraw.Draw(moving)
            for box in [(0, 0, 130, 112), (65, 92, 179, 178), (141, 60, 213, 113)]:
                draw.rectangle(tuple(c + PAD for c in box), fill=255)
            result = Image.composite(result, still, moving)
        # The edge meeting the fixed frame must remain pixel-identical.
        result.paste(still.crop((0, PAD + th - 8, sw, sh)), (0, PAD + th - 8))
        edge = (PAD + tw - 8, 0, sw, sh) if left else (0, 0, PAD + 8, sh)
        result.paste(still.crop(edge), edge[:2])
        if name == 'whale':
            for box in [(200, 24, 260, 54), (220, 120, 270, 140)]:
                pinned = tuple(c + PAD for c in box)
                assert result.crop(pinned).tobytes() == still.crop(pinned).tobytes(), 'Whale body must not bob'
        return result

    count = math.ceil(active * FPS)
    frames = [frame(i / FPS) for i in range(count + 1)]
    frames[-1] = still.copy()
    # At the UI's .18 scale, half-resolution corners still exceed 2x display density.
    # The CSS continues to use original-art coordinates; only encoded raster density changes.
    encoded_size = (math.ceil(sw / 2), math.ceil(sh / 2))
    frames = [im.resize(encoded_size, Image.Resampling.LANCZOS) for im in frames]
    exported_still = frames[0]
    exported_still.save(target / (name + '-still.png'))
    durations = [round(1000 / FPS)] * count + [round((period - count / FPS) * 1000)]
    animated = target / (name + '-motion.webp')
    frames[0].save(animated, save_all=True, append_images=frames[1:], duration=durations,
                   loop=0, lossless=True, method=4, background=(0, 0, 0, 0))
    with Image.open(animated) as check:
        assert check.is_animated and check.n_frames > 10
        assert ImageChops.difference(visible(check), visible(exported_still)).getbbox() is None
        changed = 0
        for i in range(1, check.n_frames):
            check.seek(i)
            delta = ImageChops.difference(visible(check), visible(exported_still))
            pixels = getattr(delta, 'get_flattened_data', delta.getdata)()
            changed = max(changed, sum(max(pixel) > 3 for pixel in pixels))
        assert changed > 100, 'Animation must contain real pixel changes'
        result = dict(name=name, size=[width, height], slices=[top, right, bottom, lft],
                      frames=check.n_frames, changed_pixels=changed, raster_size=list(encoded_size), bytes=animated.stat().st_size,
                      original_sha256=hashlib.sha256(dest.read_bytes()).hexdigest())
    if name == 'whale':
        result['bubbles_frames'] = build_whale_bubbles(art, target, period)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path)
    parser.add_argument('--only', choices=list(SHELLS), help='Rebuild one skin without touching the others')
    args = parser.parse_args()
    target = Path(__file__).resolve().parents[1] / 'ui' / 'assets' / 'illustrated-bubbles'
    target.mkdir(parents=True, exist_ok=True)
    result = [build(name, spec, args.source or target, target) for name, spec in SHELLS.items()
              if args.only is None or name == args.only]
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
