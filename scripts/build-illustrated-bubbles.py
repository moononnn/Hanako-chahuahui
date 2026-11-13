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
from PIL import Image, ImageChops, ImageDraw, ImageEnhance

PAD = 24
FPS = 12
SHELLS = {
    'croc': ([55, 45, 35, 25], False, .52, .35, 6.8, 8.0),
    'fox': ([55, 45, 35, 20], False, .60, .36, 6.4, 8.0),
    'berry': ([44, 34, 35, 21], False, .62, .45, 6.4, 8.0),
    'whale': ([48, 27, 34, 44], True, .48, .34, 7.4, 8.6),
}


def smooth(t):
    t = max(0., min(1., t))
    return t * t * (3 - 2 * t)


def pulse(t, start, end):
    return math.sin(math.pi * (t - start) / (end - start)) ** 2 if start < t < end else 0.


# Rectangles select existing artwork; they never draw new illustration.
FRONT_MOVING = {
    'croc': [(446, 122, 524, 183), (578, 130, 682, 197)],
    'fox': [(496, 0, 608, 111), (655, 62, 756, 170)],
    'berry': [(599, 0, 737, 106)],
}
FACE_PINS = {
    'croc': [(505, 38, 646, 119), (520, 106, 588, 139)],
    'fox': [(514, 99, 661, 185)],
    'berry': [(575, 88, 714, 163)],
}
FACE_CHECK = {
    'croc': (515, 44, 635, 108),
    'fox': (522, 114, 654, 177),
    'berry': (584, 96, 704, 151),
}


def ellipse_weight(x, y, cx, cy, rx, ry):
    return smooth((1 - math.hypot((x - cx) / rx, (y - cy) / ry)) / .28)


def front_displacement(name, x, y, t):
    """Only paws, ears or leaves move; expression pixels are restored below."""
    if name == 'croc':
        a = -.22 * (pulse(t, .15, 1.55) + .6 * pulse(t, 5.8, 6.8))
        w = ellipse_weight(x, y, 483, 151, 39, 29)
        dx, dy = -a * (y - 135) * w, a * (x - 494) * w
        a = .18 * pulse(t, 1.8, 3.1)
        w = ellipse_weight(x, y, 632, 163, 51, 33)
        return dx - a * (y - 145) * w, dy + a * (x - 620) * w
    if name == 'fox':
        a = .16 * math.sin(4 * math.pi * (t - .1) / 1.8) * pulse(t, .1, 1.9)
        w = ellipse_weight(x, y, 552, 53, 58, 62) * smooth((108 - y) / 20)
        dx, dy = -a * (y - 96) * w, a * (x - 560) * w
        a = -.16 * pulse(t, 2., 3.15)
        w = ellipse_weight(x, y, 710, 108, 47, 55) * smooth((x - 650) / 24)
        return dx - a * (y - 137) * w, dy + a * (x - 686) * w
    a = .17 * math.sin(2 * math.pi * t / 1.8) * pulse(t, .1, 1.9)
    w = ellipse_weight(x, y, 641, 25, 48, 27)
    dx, dy = -a * (y - 51) * w, a * (x - 673) * w
    a = -.18 * (pulse(t, 2., 3.2) + .55 * pulse(t, 5.5, 6.4))
    w = ellipse_weight(x, y, 702, 54, 39, 45) * smooth((107 - y) / 16)
    return dx - a * (y - 49) * w, dy + a * (x - 675) * w


def build_lower_detail(name, art, target, period, slices):
    """Animate a complete lower corner so the frame behind it stays continuous."""
    _top, right, bottom, left = slices
    width, height = art.size
    tile_width = right if name == 'fox' else left
    x0, y0 = (width - right if name == 'fox' else 0), height - bottom
    still = Image.new('RGBA', (tile_width + 2 * PAD, bottom + 2 * PAD))
    still.paste(art.crop((x0, y0, x0 + tile_width, height)), (PAD, PAD))
    sw, sh = still.size
    heart_mask = None
    if name == 'berry':
        heart_mask = Image.new('L', still.size)
        pixels = getattr(still, 'get_flattened_data', still.getdata)()
        heart_mask.putdata([255 if 43 <= i % sw - PAD <= 135 and 302 <= i // sw - PAD + y0 <= 377
                           and r > 180 and g > 120 and b > 65 and g > b + 12 and r >= g + 5 and a > 0 else 0
                           for i, (r, g, b, a) in enumerate(pixels)])

    def frame(t):
        if name == 'berry':
            amount = .28 * pulse(t, 3.15, 4.55) + .22 * pulse(t, 4.65, 6.)
            bright = ImageEnhance.Brightness(still).enhance(1 + amount)
            return Image.composite(bright, still, heart_mask)
        if name == 'croc':
            angle = .18 * math.sin(2 * math.pi * (t - 3.3) / 2.4) * pulse(t, 3.3, 5.7)
            box = (73, 317, 136, 384)
        else:
            angle = .10 * math.sin(2 * math.pi * (t - 3.3) / 2.8) * pulse(t, 3.3, 6.1)
            box = (479, 332, 716, 465)
        if not angle:
            return still.copy()

        def sample(px, py):
            x, y = px - PAD + x0, py - PAD + y0
            if name == 'croc':
                weight = ellipse_weight(x, y, 105, 345, 34, 36) * smooth((x - 72) / 12)
                pivot_x, pivot_y = 77, 373
            else:
                weight = ellipse_weight(x, y, 557, 413, 97, 54)
                pivot_x, pivot_y = 688, 355
            return px - angle * (y - pivot_y) * weight, py + angle * (x - pivot_x) * weight

        mesh = []
        for py in range(0, sh, 6):
            for px in range(0, sw, 6):
                ex, ey = min(px + 6, sw), min(py + 6, sh)
                points = [sample(px, py), sample(px, ey), sample(ex, ey), sample(ex, py)]
                mesh.append(((px, py, ex, ey), tuple(c for p in points for c in p)))
        warped = still.transform(still.size, Image.Transform.MESH, mesh, Image.Resampling.BICUBIC)
        mask = Image.new('L', still.size)
        ImageDraw.Draw(mask).rectangle(tuple(c + PAD - (x0 if i % 2 == 0 else y0)
                                            for i, c in enumerate(box)), fill=255)
        result = Image.composite(warped, still, mask)
        # Joins meet the fixed middle/side slices; outer edges may move into PAD.
        result.paste(still.crop((0, 0, sw, PAD + 8)), (0, 0))
        if name == 'fox':
            result.paste(still.crop((0, 0, PAD + 8, sh)), (0, 0))
        else:
            result.paste(still.crop((PAD + tile_width - 8, 0, sw, sh)), (PAD + tile_width - 8, 0))
            # Teeth next to the leaf are fixed as well.
            for fixed in [(108, 351, 147, 406), (145, 352, 188, 413)]:
                local = tuple(c + PAD - (x0 if i % 2 == 0 else y0) for i, c in enumerate(fixed))
                result.paste(still.crop(local), local[:2])
        return result

    encoded = (math.ceil(sw / 2), math.ceil(sh / 2))
    frames = [frame(i / FPS).resize(encoded, Image.Resampling.LANCZOS)
              for i in range(math.ceil(period * FPS))]
    frames[0].save(target / (name + '-details-still.png'))
    dest = target / (name + '-details-motion.webp')
    frames[0].save(dest, save_all=True, append_images=frames[1:], duration=round(1000 / FPS),
                   loop=0, lossless=True, method=4, background=(0, 0, 0, 0))
    with Image.open(dest) as check:
        assert check.is_animated
        assert ImageChops.difference(visible(check), visible(frames[0])).getbbox() is None
        css_size = (math.ceil(sw * .18), math.ceil(sh * .18))
        base_view = visible(frames[0].resize(css_size, Image.Resampling.LANCZOS))
        visible_pixels = 0
        for i in range(1, check.n_frames):
            check.seek(i)
            view = visible(check.convert('RGBA').resize(css_size, Image.Resampling.LANCZOS))
            delta = ImageChops.difference(base_view, view)
            pixels = getattr(delta, 'get_flattened_data', delta.getdata)()
            visible_pixels = max(visible_pixels, sum(max(p) > 3 for p in pixels))
        assert visible_pixels >= 8, 'Lower detail must remain visible at actual chat scale'
        return dict(frames=check.n_frames, raster_size=list(encoded), source_size=[sw, sh], visible_pixels=visible_pixels)


def whale_displacement(u, v, t):
    """Independent, feathered part masks in the approved artwork's coordinates.

    This deforms existing pixels only: no new eyes/illustration are painted.
    The original closed eye, head and body stay pinned; only tail/fin move.
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
        def sample(x, y):
            u, v = x - PAD, y - PAD
            if name == 'whale':
                px, py = whale_displacement(u, v, t)
                return x + px, y + py
            px, py = front_displacement(name, u + width - tw, v, t)
            return x + px, y + py

        mesh = []
        step = 6
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
            for box in [(0, 0, 130, 112), (65, 92, 179, 178)]:
                draw.rectangle(tuple(c + PAD for c in box), fill=255)
            result = Image.composite(result, still, moving)
        if name in FRONT_MOVING:
            moving = Image.new('L', still.size)
            draw = ImageDraw.Draw(moving)
            for box in FRONT_MOVING[name]:
                local = tuple(c + PAD - (width - tw if i % 2 == 0 else 0) for i, c in enumerate(box))
                draw.rectangle(local, fill=255)
            result = Image.composite(result, still, moving)
            for box in FACE_PINS[name]:
                local = tuple(c + PAD - (width - tw if i % 2 == 0 else 0) for i, c in enumerate(box))
                result.paste(still.crop(local), local[:2])
        # The edge meeting the fixed frame must remain pixel-identical.
        result.paste(still.crop((0, PAD + th - 8, sw, sh)), (0, PAD + th - 8))
        edge = (PAD + tw - 8, 0, sw, sh) if left else (0, 0, PAD + 8, sh)
        result.paste(still.crop(edge), edge[:2])
        if name == 'whale':
            # Keep the approved closed-eye expression exact, even beside the fin mask.
            eye_box = tuple(c + PAD for c in (148, 68, 206, 105))
            result.paste(still.crop(eye_box), eye_box[:2])
            for box in [(200, 24, 260, 54), (220, 120, 270, 140), (148, 68, 206, 105)]:
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
            if name == 'whale':
                # Verify the actual decoded animation, after downsampling/encoding.
                eye_box = (89, 48, 113, 63)
                assert ImageChops.difference(visible(check).crop(eye_box), visible(exported_still).crop(eye_box)).getbbox() is None, 'Closed eye must remain static in every encoded frame'
            if name in FACE_CHECK:
                box = FACE_CHECK[name]
                local = tuple(round((c + PAD - (width - tw if j % 2 == 0 else 0)) / 2)
                              for j, c in enumerate(box))
                assert ImageChops.difference(visible(check).crop(local), visible(exported_still).crop(local)).getbbox() is None, 'Original expression must remain fixed in every encoded frame'
            delta = ImageChops.difference(visible(check), visible(exported_still))
            pixels = getattr(delta, 'get_flattened_data', delta.getdata)()
            changed = max(changed, sum(max(pixel) > 3 for pixel in pixels))
        assert changed > 100, 'Animation must contain real pixel changes'
        result = dict(name=name, size=[width, height], slices=[top, right, bottom, lft],
                      frames=check.n_frames, changed_pixels=changed, raster_size=list(encoded_size), bytes=animated.stat().st_size,
                      original_sha256=hashlib.sha256(dest.read_bytes()).hexdigest())
    if name == 'whale':
        result['bubbles_frames'] = build_whale_bubbles(art, target, period)
    else:
        result['details'] = build_lower_detail(name, art, target, period, [top, right, bottom, lft])
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
