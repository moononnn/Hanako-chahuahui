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
from PIL import Image, ImageChops

PAD = 24
FPS = 12
SHELLS = {
    'croc': ([55, 45, 35, 25], False, .52, .35, 1.8, 5.2),
    'fox': ([55, 45, 35, 20], False, .60, .36, 2.6, 6.0),
    'berry': ([44, 34, 35, 21], False, .62, .45, 2.0, 5.4),
    'whale': ([48, 27, 34, 44], True, .48, .34, 3.6, 6.4),
}


def smooth(t):
    t = max(0., min(1., t))
    return t * t * (3 - 2 * t)


def pulse(t, start, end):
    return math.sin(math.pi * (t - start) / (end - start)) ** 2 if start < t < end else 0.


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
            dx, dy, angle = 5 * math.sin(2 * math.pi * t / active) * p, 20 * p, 0

        def sample(x, y):
            u, v = x - PAD, y - PAD
            radius = math.hypot((u - tw * cx) / (tw * .62), (v - th * cy) / (th * .62))
            weight = smooth((1.10 - radius) / .55)
            weight *= smooth((th - v - 8) / (th * .18))
            weight *= smooth(((tw - u) if left else u) / (tw * .14))
            return (x + (dx - angle * (v - th * .70)) * weight,
                    y + (dy + angle * (u - tw * cx)) * weight)

        mesh = []
        for y in range(0, sh, 18):
            for x in range(0, sw, 18):
                x1, y1 = min(x + 18, sw), min(y + 18, sh)
                points = [sample(x, y), sample(x, y1), sample(x1, y1), sample(x1, y)]
                mesh.append(((x, y, x1, y1), tuple(c for point in points for c in point)))
        result = still.transform(still.size, Image.Transform.MESH, mesh, Image.Resampling.BICUBIC)
        # The edge meeting the fixed frame must remain pixel-identical.
        result.paste(still.crop((0, PAD + th - 8, sw, sh)), (0, PAD + th - 8))
        edge = (PAD + tw - 8, 0, sw, sh) if left else (0, 0, PAD + 8, sh)
        result.paste(still.crop(edge), edge[:2])
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
        check.seek(max(1, check.n_frames // 3))
        delta = ImageChops.difference(visible(check), visible(exported_still))
        assert delta.getbbox() is not None, 'Animation must contain real pixel changes'
        pixels = getattr(delta, 'get_flattened_data', delta.getdata)()
        changed = sum(max(pixel) > 3 for pixel in pixels)
        assert changed > 100
        return dict(name=name, size=[width, height], slices=[top, right, bottom, lft],
                    frames=check.n_frames, changed_pixels=changed, raster_size=list(encoded_size), bytes=animated.stat().st_size,
                    original_sha256=hashlib.sha256(dest.read_bytes()).hexdigest())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path)
    args = parser.parse_args()
    target = Path(__file__).resolve().parents[1] / 'ui' / 'assets' / 'illustrated-bubbles'
    target.mkdir(parents=True, exist_ok=True)
    result = [build(name, spec, args.source or target, target) for name, spec in SHELLS.items()]
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
