"""Build Fragline's art: public/fragline.wad, public/share.png and public/backdrop.jpg.

Usage: python3 tools/make_art.py   (needs Pillow; run from the repository root)
The PWAD overrides every lump of the game data that carries the data set's own name or logo
(TITLEPIC, M_DOOM, CREDIT, HELP, ENDOOM and the DEHACKED text strings).
Maps, sounds and other graphics still come from the game data (see public/credits.html).
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


def pal_image(palette):
    pal_img = Image.new('P', (1, 1))
    pal_img.putpalette(palette)
    return pal_img


def to_doom_patch(rgba, palette, left=0, top=0):
    """Encode an RGBA image (alpha < 128 is transparent) as a Doom patch with offsets."""
    w, h = rgba.size
    alpha = rgba.getchannel('A')
    indexed = rgba.convert('RGB').quantize(palette=pal_image(palette), dither=Image.Dither.NONE)
    px, ap = indexed.load(), alpha.load()
    body, offsets, pos = bytearray(), [], 8 + 4 * w
    for x in range(w):
        offsets.append(pos + len(body))
        y = 0
        while y < h:
            if ap[x, y] < 128:
                y += 1
                continue
            start = y
            while y < h and ap[x, y] >= 128 and y - start < 128:
                y += 1
            run = [px[x, yy] for yy in range(start, y)]
            body += bytes([start, len(run), run[0]]) + bytes(run) + bytes([run[-1]])
        body.append(255)
    return struct.pack('<hhhh', w, h, left, top) + b''.join(struct.pack('<I', o) for o in offsets) + bytes(body)


def from_doom_patch(data, palette):
    w, h, _, _ = struct.unpack_from('<hhhh', data)
    img = Image.new('RGB', (w, h))
    px = img.load()
    for x in range(w):
        p = struct.unpack_from('<I', data, 8 + 4 * x)[0]
        while data[p] != 255:
            top, n = data[p], data[p + 1]
            for j in range(n):
                c = data[p + 3 + j]
                px[x, top + j] = tuple(palette[c * 3:c * 3 + 3])
            p += n + 4
    return img


def molten_text(size, text, font_obj, scale):
    """Red/orange chunky lettering with a dark outline on a transparent canvas."""
    w, h = size
    big = Image.new('RGBA', (w * 4, h * 4), (0, 0, 0, 0))
    box = ImageDraw.Draw(big).textbbox((0, 0), text, font=font_obj)
    x = (w * 4 - (box[2] - box[0])) / 2 - box[0]
    y = (h * 4 - (box[3] - box[1])) / 2 - box[1]
    mask = Image.new('L', big.size, 0)
    ImageDraw.Draw(mask).text((x, y), text, font=font_obj, fill=255)
    outline = Image.new('L', big.size, 0)
    ImageDraw.Draw(outline).text((x, y), text, font=font_obj, fill=255, stroke_width=int(3 * scale))
    grad = Image.new('RGBA', big.size)
    gp = grad.load()
    top, span = y + box[1], max(box[3] - box[1], 1)
    for yy in range(big.size[1]):
        k = min(max((yy - top) / span, 0), 1)
        colour = (255, int(200 - 170 * k), int(40 - 40 * k), 255)
        for xx in range(big.size[0]):
            gp[xx, yy] = colour
    big.paste((60, 4, 0, 255), mask=outline)
    big.paste(grad, mask=mask)
    return big.resize((w, h), Image.Resampling.LANCZOS)


def small_red_text(img, xy, text, size=8, fill=(200, 24, 12), centre=False):
    f = font(SUB_FONT_CANDIDATES, size)
    d = ImageDraw.Draw(img)
    x, y = xy
    if centre:
        b = d.textbbox((0, 0), text, font=f)
        x = (img.size[0] - (b[2] - b[0])) / 2 - b[0]
    d.text((x + 1, y + 1), text, font=f, fill=(20, 0, 0))
    d.text((x, y), text, font=f, fill=fill)


def menu_logo(palette):
    return to_doom_patch(molten_text((189, 70), 'FRAGLINE', font(FONT_CANDIDATES, 33 * 4), 1), palette, 40, -5)


def credit_screen(palette):
    img = render(1280, 800, title=False).resize((320, 200), Image.Resampling.LANCZOS)
    img = img.point(lambda v: int(v * 0.8))
    logo = molten_text((200, 40), 'FRAGLINE', font(FONT_CANDIDATES, 30 * 4), 1)
    img.paste(logo, (60, 8), logo)
    lines = ['Fragline is a browser deathmatch for up',
             'to four players, built on the Crispy Doom',
             'engine and free game data.',
             '',
             'Maps, sounds and graphics are the work of',
             'many contributors; see the credits page',
             'on the Fragline site for names and',
             'licenses.',
             '',
             'Thanks for playing.']
    y = 56
    for line in lines:
        small_red_text(img, (24, y), line, 10, (255, 190, 90))
        y += 13
    return to_doom_picture(img, palette)


def help_screen(original, palette):
    """Original help card with the footer URL painted over (the 'ESC to return' text stays)."""
    img = from_doom_patch(original, palette)
    px = img.load()
    area = [px[x, y] for x in range(0, 70) for y in range(185, 190)]
    fill = tuple(sum(c[i] for c in area) // len(area) for i in range(3))
    for x in range(0, 200):
        for y in range(191, 200):
            px[x, y] = fill
    return to_doom_picture(img, palette)


def endoom():
    rows = [''] * 25
    rows[8] = '*** FRAGLINE ***'.center(80)
    rows[10] = 'Thanks for playing Fragline.'.center(80)
    out = bytearray()
    for i, row in enumerate(rows):
        for ch in row.ljust(80)[:80]:
            out += bytes([ord(ch), 0x0C if i == 8 else 0x07])
    return bytes(out)


def dehacked():
    return ('Patch File for DeHackEd v3.0\nDoom version = 19\nPatch format = 6\n\n'
            '# *allow-extended-strings*\n\n[STRINGS]\n'
            'STARTUP5 = Fragline - browser deathmatch\n'
            'C1TEXT = Fragline\n'
            'C2TEXT = Fragline\n'
            'C3TEXT = Fragline\n'
            'C4TEXT = Thank you for playing Fragline.\n'
            'C5TEXT = Fragline\n'
            'C6TEXT = Fragline\n'
            'TXT_D2E1 = Fragline\n').encode()


def main():
    freedm = read_lumps_gz(PUBLIC / 'freedm.wad.gz')
    palette = freedm['PLAYPAL'][:768]
    # Draw large and downsample so the 320x200 title keeps clean edges.
    title = render(1280, 800).resize((320, 200), Image.Resampling.LANCZOS)
    write_wad(PUBLIC / 'fragline.wad', [
        ('TITLEPIC', to_doom_picture(title, palette)),
        ('M_DOOM', menu_logo(palette)),
        ('CREDIT', credit_screen(palette)),
        ('HELP', help_screen(freedm['HELP'], palette)),
        ('ENDOOM', endoom()),
        ('DEHACKED', dehacked()),
    ])
    render(1200, 630).save(PUBLIC / 'share.png', optimize=True)
    # Lobby backdrop without lettering, so it does not compete with the page's own logo.
    render(1200, 900, title=False).save(PUBLIC / 'backdrop.jpg', quality=82, optimize=True, progressive=True)
    print('Wrote public/fragline.wad, public/share.png and public/backdrop.jpg')


if __name__ == '__main__':
    main()
