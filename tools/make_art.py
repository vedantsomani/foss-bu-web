"""Build Fragline's art: public/fragline.wad (TITLEPIC), public/share.png and public/backdrop.jpg.

Usage: python3 tools/make_art.py   (needs Pillow; run from the repository root)
The WAD only replaces the title screen; all maps and other graphics come from FreeDM.
"""
import gzip
import struct
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / 'public'
FONT_CANDIDATES = [
    '/usr/share/fonts/opentype/inter/InterDisplay-Black.otf',
    '/usr/share/fonts/opentype/inter/InterDisplay-ExtraBold.otf',
    '/usr/share/fonts/opentype/inter/Inter-ExtraBold.otf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
]
SUB_FONT_CANDIDATES = [
    '/usr/share/fonts/opentype/inter/Inter-Bold.otf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
]


def font(candidates, size):
    for path in candidates:
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    raise SystemExit('No bold font found; edit FONT_CANDIDATES in tools/make_art.py')


def read_lumps_gz(path):
    data = gzip.decompress(path.read_bytes())
    _, count, offset = struct.unpack_from('<4sII', data)
    lumps = {}
    for i in range(count):
        pos, size, name = struct.unpack_from('<II8s', data, offset + 16 * i)
        lumps[name.rstrip(b'\0').decode()] = data[pos:pos + size]
    return lumps


def render(width, height, title=True):
    """Draw the title card in RGB at any size (the layout scales with height)."""
    s = height / 200
    img = Image.new('RGB', (width, height))
    px = img.load()
    for y in range(height):
        t = y / height
        # Dark sky warming into a hot horizon band (tones Doom's palette covers well).
        glow = max(0.0, 1 - abs(t - 0.72) / 0.22)
        r = int(16 + 56 * t + 180 * glow ** 2)
        g = int(12 + 14 * t + 64 * glow ** 3)
        b = int(12 + 6 * t)
        for x in range(width):
            px[x, y] = (min(r, 255), min(g, 255), min(b, 255))
    draw = ImageDraw.Draw(img)
    # Perspective floor grid below the horizon.
    horizon = int(height * 0.72)
    cx = width / 2
    for i in range(-14, 15):
        draw.line([(cx + i * 6 * s, horizon), (cx + i * 60 * s, height)], fill=(90, 34, 20), width=max(1, int(s)))
    y, step = horizon, 2 * s
    while y < height:
        draw.line([(0, int(y)), (width, int(y))], fill=(80, 30, 18), width=max(1, int(s)))
        step *= 1.45
        y += step
    # Distant skyline silhouette on the horizon.
    x = 0
    seed = 7
    while x < width:
        seed = (seed * 1103515245 + 12345) & 0x7fffffff
        w = (6 + seed % 14) * s
        h = (6 + (seed >> 8) % 28) * s
        draw.rectangle([x, horizon - h, x + w, horizon], fill=(20, 12, 18))
        x += w + (seed >> 16) % 3 * s
    if not title:
        return img

    title_font = font(FONT_CANDIDATES, int(58 * s))
    text = 'FRAGLINE'
    box = draw.textbbox((0, 0), text, font=title_font)
    tw, th = box[2] - box[0], box[3] - box[1]
    tx, ty = (width - tw) / 2 - box[0], 52 * s - box[1]
    shadow = Image.new('L', img.size, 0)
    ImageDraw.Draw(shadow).text((tx + 3 * s, ty + 4 * s), text, font=title_font, fill=255)
    img.paste((0, 0, 0), mask=shadow.filter(ImageFilter.GaussianBlur(2 * s)))
    # Fill the letters with a molten vertical gradient.
    gradient = Image.new('RGB', img.size)
    gp = gradient.load()
    for yy in range(height):
        k = min(max((yy - ty - box[1]) / max(th, 1), 0), 1)
        colour = (255, int(236 - 150 * k), int(150 - 140 * k))
        for xx in range(width):
            gp[xx, yy] = colour
    mask = Image.new('L', img.size, 0)
    ImageDraw.Draw(mask).text((tx, ty), text, font=title_font, fill=255,
                              stroke_width=0)
    outline = Image.new('L', img.size, 0)
    ImageDraw.Draw(outline).text((tx, ty), text, font=title_font, fill=255,
                                 stroke_width=max(1, int(2 * s)))
    img.paste((40, 6, 4), mask=outline)
    img.paste(gradient, mask=mask)

    sub_font = font(SUB_FONT_CANDIDATES, int(11 * s))
    sub = 'B R O W S E R   D E A T H M A T C H'
    sb = draw.textbbox((0, 0), sub, font=sub_font)
    sx = (width - (sb[2] - sb[0])) / 2 - sb[0]
    sy = ty + box[3] + 12 * s
    draw.line([(sx - 26 * s, sy + 6 * s), (sx - 8 * s, sy + 6 * s)], fill=(255, 120, 40), width=max(1, int(s)))
    draw.line([(width - sx + 8 * s, sy + 6 * s), (width - sx + 26 * s, sy + 6 * s)], fill=(255, 120, 40), width=max(1, int(s)))
    draw.text((sx, sy), sub, font=sub_font, fill=(235, 225, 210))
    return img


def to_doom_picture(img, palette):
    """Encode a 320x200 RGB image as a Doom picture lump using the given PLAYPAL."""
    pal_img = Image.new('P', (1, 1))
    pal_img.putpalette(palette)
    indexed = img.quantize(palette=pal_img, dither=Image.Dither.NONE)
    w, h = indexed.size
    pixels = indexed.load()
    columns = []
    for x in range(w):
        col = bytearray()
        # Posts start at most at row 254, so 200 rows split into two posts.
        for top in range(0, h, 128):
            run = [pixels[x, y] for y in range(top, min(top + 128, h))]
            col += bytes([top, len(run), run[0]]) + bytes(run) + bytes([run[-1]])
        col.append(255)
        columns.append(bytes(col))
    header = struct.pack('<hhhh', w, h, 0, 0)
    offsets, body, pos = [], bytearray(), 8 + 4 * w
    for col in columns:
        offsets.append(pos + len(body))
        body += col
    return header + b''.join(struct.pack('<I', o) for o in offsets) + bytes(body)


def write_wad(path, lumps):
    data, directory = bytearray(), bytearray()
    pos = 12
    for name, lump in lumps:
        directory += struct.pack('<II8s', pos, len(lump), name.encode())
        data += lump
        pos += len(lump)
    path.write_bytes(struct.pack('<4sII', b'PWAD', len(lumps), pos) + bytes(data) + bytes(directory))


def main():
    palette = read_lumps_gz(PUBLIC / 'freedm.wad.gz')['PLAYPAL'][:768]
    # Draw large and downsample so the 320x200 title keeps clean edges.
    title = render(1280, 800).resize((320, 200), Image.Resampling.LANCZOS)
    write_wad(PUBLIC / 'fragline.wad', [('TITLEPIC', to_doom_picture(title, palette))])
    render(1200, 630).save(PUBLIC / 'share.png', optimize=True)
    # Lobby backdrop without lettering, so it does not compete with the page's own logo.
    render(1200, 900, title=False).save(PUBLIC / 'backdrop.jpg', quality=82, optimize=True, progressive=True)
    print('Wrote public/fragline.wad, public/share.png and public/backdrop.jpg')


if __name__ == '__main__':
    main()
