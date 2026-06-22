"""Generate a visual assembly guide for the printed BMO kit."""

from __future__ import annotations

from pathlib import Path
from textwrap import wrap

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
EXPORT_DIR = ROOT / "exports"
OUT_PATH = EXPORT_DIR / "bmo_assembly_guide.png"

W, H = 1800, 1500


COLORS = {
    "bg": "#eef6f2",
    "ink": "#123231",
    "muted": "#496966",
    "body": "#61d2c3",
    "body_dark": "#214d4a",
    "heart": "#f08eb8",
    "ear": "#87d2f4",
    "lung": "#f5a0bb",
    "speaker": "#30343b",
    "spark": "#ffd544",
    "battery": "#ffb15b",
    "charge": "#caa8ff",
    "boost": "#a5db66",
    "display": "#bff4d7",
    "panel": "#ffffffcc",
    "red": "#e84d4b",
    "blue": "#3b8eea",
    "green": "#34b66b",
    "orange": "#ff8c3a",
    "black": "#222222",
}


def font(size: int, bold: bool = False):
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
    ]
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


TITLE = font(42, True)
H2 = font(27, True)
BODY = font(21)
SMALL = font(17)
TINY = font(14)


def rr(draw, box, radius, fill, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def heading(draw, number, title, x, y):
    draw.ellipse((x, y, x + 44, y + 44), fill=COLORS["ink"])
    draw.text((x + 22, y + 9), str(number), fill="#ffffff", font=H2, anchor="ma")
    draw.text((x + 58, y + 7), title, fill=COLORS["ink"], font=H2)


def note(draw, x, y, text, max_chars=45):
    for line in wrap(text, max_chars):
        draw.text((x, y), line, fill=COLORS["muted"], font=SMALL)
        y += 22
    return y


def arrow(draw, start, end, color=COLORS["ink"]):
    sx, sy = start
    ex, ey = end
    draw.line((sx, sy, ex, ey), fill=color, width=5)
    dx = 1 if ex >= sx else -1
    draw.polygon([(ex, ey), (ex - 18 * dx, ey - 10), (ex - 18 * dx, ey + 10)], fill=color)


def draw_print_plate(draw, box):
    x0, y0, x1, y1 = box
    rr(draw, box, 24, "#e9f0ee", "#bfd8d2", 3)
    for i in range(1, 8):
        x = x0 + i * (x1 - x0) / 8
        draw.line((x, y0 + 15, x, y1 - 15), fill="#d5e4e0", width=1)
    for i in range(1, 5):
        y = y0 + i * (y1 - y0) / 5
        draw.line((x0 + 15, y, x1 - 15, y), fill="#d5e4e0", width=1)
    parts = [
        ((x0 + 28, y0 + 35, x0 + 170, y0 + 210), COLORS["body"], "front"),
        ((x0 + 200, y0 + 35, x0 + 342, y0 + 210), COLORS["body"], "rear tray"),
        ((x0 + 38, y0 + 248, x0 + 128, y0 + 315), COLORS["heart"], "heart base"),
        ((x0 + 155, y0 + 248, x0 + 245, y0 + 315), COLORS["heart"], "heart lid"),
        ((x0 + 270, y0 + 245, x0 + 350, y0 + 315), COLORS["display"], "TFT bezel"),
        ((x0 + 35, y0 + 345, x0 + 90, y0 + 390), COLORS["ear"], "ear"),
        ((x0 + 110, y0 + 345, x0 + 165, y0 + 390), COLORS["lung"], "lung"),
        ((x0 + 190, y0 + 340, x0 + 250, y0 + 400), COLORS["boost"], "boost"),
        ((x0 + 270, y0 + 348, x0 + 335, y0 + 392), COLORS["battery"], "cell"),
        ((x0 + 108, y0 + 410, x0 + 168, y0 + 452), COLORS["charge"], "charge"),
        ((x0 + 205, y0 + 410, x0 + 265, y0 + 452), COLORS["spark"], "touch"),
    ]
    for pbox, color, text in parts:
        rr(draw, pbox, 14, color, COLORS["ink"], 2)
        draw.text(((pbox[0] + pbox[2]) / 2, pbox[3] + 5), text, fill=COLORS["muted"], font=TINY, anchor="ma")


def draw_heart(draw, box):
    x0, y0, x1, y1 = box
    rr(draw, box, 28, COLORS["heart"], COLORS["ink"], 4)
    rr(draw, (x0 + 25, y0 + 68, x0 + 155, y0 + 178), 12, "#fbfbf6", "#c5c5b8", 3)
    rr(draw, (x0 + 175, y0 + 82, x0 + 265, y0 + 178), 10, "#101b1d", "#33484d", 3)
    draw.text((x0 + 90, y0 + 108), "mini\nbreadboard", fill=COLORS["ink"], font=SMALL, anchor="ma")
    draw.text((x0 + 220, y0 + 120), "ESP32", fill="#ffffff", font=SMALL, anchor="ma")
    for px, py, name in [
        (x0 + 38, y0 + 35, "mic"),
        (x0 + 140, y0 + 18, "display"),
        (x0 + 268, y0 + 55, "touch"),
        (x0 + 278, y0 + 130, "amp"),
        (x0 + 230, y0 + 205, "speaker"),
        (x0 + 60, y0 + 205, "power"),
    ]:
        rr(draw, (px - 23, py - 8, px + 23, py + 8), 5, COLORS["black"], "#e9fff8", 2)
        draw.text((px, py + 13), name, fill=COLORS["muted"], font=TINY, anchor="ma")


def draw_organ_row(draw, x, y):
    organs = [
        (COLORS["ear"], "mic ear", "INMP441"),
        (COLORS["spark"], "touch spark", "TTP223"),
        (COLORS["lung"], "voice lung", "MAX98357A"),
        (COLORS["battery"], "energy cell", "103450 LiPo"),
        (COLORS["charge"], "charge kidney", "TP4056 Type-C"),
        (COLORS["boost"], "boost gland", "MT3608 5V"),
        (COLORS["display"], "TFT + bezel", "board clips behind"),
        (COLORS["speaker"], "speaker direct", "clips in side"),
    ]
    for i, (color, title, comp) in enumerate(organs):
        bx = x + (i % 4) * 142
        by = y + (i // 4) * 112
        rr(draw, (bx, by, bx + 116, by + 72), 20, color, COLORS["ink"], 3)
        rr(draw, (bx + 12, by + 30, bx + 104, by + 58), 8, "#ffffffcc", COLORS["ink"], 1)
        draw.text((bx + 58, by + 8), title, fill=COLORS["ink"], font=TINY, anchor="ma")
        draw.text((bx + 58, by + 37), comp, fill=COLORS["ink"], font=TINY, anchor="ma")
        rr(draw, (bx + 102, by + 31, bx + 126, by + 45), 5, COLORS["black"], "#e9fff8", 2)


def draw_body_install(draw, box):
    x0, y0, x1, y1 = box
    rr(draw, box, 38, COLORS["body"], COLORS["ink"], 4)
    rr(draw, (x0 + 42, y0 + 42, x1 - 42, y1 - 42), 22, COLORS["body_dark"], "#c8fff4", 4)
    rr(draw, (x0 + 85, y0 + 70, x1 - 85, y0 + 145), 18, COLORS["display"], COLORS["ink"], 3)
    draw_heart(draw, (x0 + 125, y0 + 190, x0 + 405, y0 + 425))
    rr(draw, (x0 + 48, y0 + 208, x0 + 130, y0 + 284), 20, COLORS["ear"], COLORS["ink"], 3)
    rr(draw, (x0 + 220, y0 + 110, x0 + 300, y0 + 180), 18, COLORS["spark"], COLORS["ink"], 3)
    rr(draw, (x0 + 60, y0 + 110, x0 + 145, y0 + 174), 18, COLORS["charge"], COLORS["ink"], 3)
    rr(draw, (x1 - 150, y0 + 110, x1 - 55, y0 + 174), 18, COLORS["boost"], COLORS["ink"], 3)
    rr(draw, (x1 - 170, y0 + 355, x1 - 52, y0 + 455), 25, COLORS["lung"], COLORS["ink"], 3)
    rr(draw, (x0 + 55, y1 - 160, x0 + 225, y1 - 83), 24, COLORS["battery"], COLORS["ink"], 3)
    draw.ellipse((x1 - 215, y1 - 190, x1 - 70, y1 - 45), fill=COLORS["speaker"], outline=COLORS["ink"], width=4)
    # Wire bundles route into heart.
    for start, end, color in [
        ((x0 + 270, y0 + 145), (x0 + 270, y0 + 190), COLORS["orange"]),
        ((x0 + 130, y0 + 245), (x0 + 170, y0 + 250), COLORS["blue"]),
        ((x0 + 260, y0 + 180), (x0 + 350, y0 + 220), COLORS["green"]),
        ((x0 + 105, y0 + 174), (x0 + 185, y0 + 372), COLORS["red"]),
        ((x1 - 105, y0 + 174), (x0 + 400, y0 + 250), COLORS["red"]),
        ((x1 - 170, y0 + 405), (x0 + 405, y0 + 335), COLORS["blue"]),
        ((x0 + 225, y1 - 122), (x0 + 185, y0 + 395), COLORS["red"]),
        ((x1 - 215, y1 - 115), (x0 + 360, y0 + 398), "#f7f3e8"),
    ]:
        draw.line((*start, *end), fill=color, width=5)


def main():
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    img = Image.new("RGB", (W, H), COLORS["bg"])
    draw = ImageDraw.Draw(img, "RGBA")

    draw.text((62, 44), "How to assemble the BMO printed kit", fill=COLORS["ink"], font=TITLE)
    draw.text((64, 95), "Side-by-side is only the print layout. After printing, every part becomes a separate piece.", fill=COLORS["muted"], font=BODY)

    # Step 1
    heading(draw, 1, "Print, then separate parts", 70, 150)
    draw_print_plate(draw, (90, 220, 470, 650))
    note(draw, 90, 680, "Remove the parts from the plate. Keep each organ base with its matching lid. Arms have side pegs, legs have bottom tabs, and the big BMO front/rear tray are separate body halves.")

    # Step 2
    heading(draw, 2, "Fill pods outside the body", 650, 150)
    draw_heart(draw, (630, 235, 930, 475))
    draw_organ_row(draw, 995, 235)
    note(draw, 630, 520, "Do not snap the lids yet. Put each module into its organ base, run its cable out through the slot, then plug the free end into the heart breadboard or power chain.")

    # Step 3
    heading(draw, 3, "Test wiring while everything is still open", 70, 770)
    rr(draw, (90, 845, 710, 1115), 28, COLORS["panel"], "#bfd8d2", 2)
    rows = [
        ("display face", "CS GP7, RST GP10, DC GP3, MOSI GP6, SCK GP4, 3V3, GND"),
        ("mic ear", "VDD 3V3, GND, BCLK GP0, WS GP1, SD GP5"),
        ("voice lung", "VIN, GND, BCLK GP0, LRC GP1, DIN GP2"),
        ("touch spark", "VCC 3V3, GND, OUT GP20"),
        ("speaker mouth", "speaker + / - goes to MAX98357A output"),
        ("energy cell", "battery lead goes to TP4056 B+ / B-"),
        ("charge kidney", "TP4056 protected OUT+ / OUT- feeds MT3608 input"),
        ("boost gland", "MT3608 adjusted output feeds heart power rail"),
    ]
    y = 872
    for title, text in rows:
        draw.text((120, y), title, fill=COLORS["ink"], font=SMALL)
        draw.text((280, y), text, fill=COLORS["muted"], font=SMALL)
        y += 31

    # Step 4
    heading(draw, 4, "Install pods into rear tray, then close BMO", 870, 770)
    draw_body_install(draw, (900, 845, 1660, 1340))
    note(draw, 900, 1362, "Heart goes in first. Press each bundle under the printed wire clips, leave a small slack loop, snap lids, plug limbs into their slots, then press the rear tray until the latch hooks click.", 80)

    img.save(OUT_PATH)
    print(OUT_PATH)


if __name__ == "__main__":
    main()
