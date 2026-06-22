"""Draw a wiring and organ-placement simulation for the BMO CAD.

This is not a slicer artifact. It is a visual map for deciding where every
component pod sits inside the open body and how bundles route back to the
heart hub.
"""

from __future__ import annotations

from math import cos, radians, sin
from pathlib import Path
from textwrap import wrap

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
EXPORT_DIR = ROOT / "exports"
OUT_PATH = EXPORT_DIR / "bmo_component_placement_simulation.png"

W, H = 1800, 1200


COLORS = {
    "bg": "#eef6f2",
    "ink": "#123231",
    "muted": "#496966",
    "body": "#61d2c3",
    "body_dark": "#3fb5aa",
    "tray": "#173b39",
    "tray2": "#214d4a",
    "screen": "#c9f6d9",
    "heart": "#f08eb8",
    "heart_shadow": "#b25d84",
    "ear": "#87d2f4",
    "lung": "#f5a0bb",
    "speaker": "#2f343b",
    "spark": "#ffd544",
    "battery": "#ffb15b",
    "charge": "#caa8ff",
    "boost": "#a5db66",
    "wire_red": "#e84d4b",
    "wire_black": "#222222",
    "wire_white": "#f7f3e8",
    "wire_yellow": "#f2c53c",
    "wire_blue": "#3b8eea",
    "wire_green": "#36b866",
    "wire_orange": "#ff8c3a",
    "wire_purple": "#8562d8",
}


def font(size: int, bold: bool = False):
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial.ttf",
    ]
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


FONT_TITLE = font(42, True)
FONT_H2 = font(26, True)
FONT_BODY = font(22)
FONT_SMALL = font(18)
FONT_TINY = font(15)


def rr(draw: ImageDraw.ImageDraw, xy, r, fill, outline=None, width=1):
    draw.rounded_rectangle(xy, radius=r, fill=fill, outline=outline, width=width)


def label(draw: ImageDraw.ImageDraw, xy, title, body, width_chars=28, align="left"):
    x, y = xy
    draw.text((x, y), title, fill=COLORS["ink"], font=FONT_H2, anchor="la" if align == "left" else "ra")
    y += 31
    for line in wrap(body, width_chars):
        draw.text((x, y), line, fill=COLORS["muted"], font=FONT_SMALL, anchor="la" if align == "left" else "ra")
        y += 22


def bezier(p0, p1, p2, steps=72):
    pts = []
    for i in range(steps + 1):
        t = i / steps
        x = (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t**2 * p2[0]
        y = (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t**2 * p2[1]
        pts.append((x, y))
    return pts


def bundle(draw: ImageDraw.ImageDraw, start, control, end, colors, width=5, spread=5):
    offset = -(len(colors) - 1) * spread / 2
    for index, color in enumerate(colors):
        dy = offset + index * spread
        pts = bezier((start[0], start[1] + dy), (control[0], control[1] + dy), (end[0], end[1] + dy))
        draw.line(pts, fill=color, width=width, joint="curve")


def port(draw: ImageDraw.ImageDraw, xy, label_text=None):
    x, y = xy
    rr(draw, (x - 22, y - 8, x + 22, y + 8), 5, "#101d1d", "#d7fff6", 2)
    if label_text:
        draw.text((x, y + 13), label_text, fill="#d7fff6", font=FONT_TINY, anchor="ma")


def star_points(cx, cy, outer, inner, count=5):
    pts = []
    for index in range(count * 2):
        radius = outer if index % 2 == 0 else inner
        angle = radians(-90 + index * 180 / count)
        pts.append((cx + cos(angle) * radius, cy + sin(angle) * radius))
    return pts


def draw_heart(draw: ImageDraw.ImageDraw, box, fill, outline):
    x0, y0, x1, y1 = box
    w = x1 - x0
    h = y1 - y0
    draw.ellipse((x0 + w * 0.03, y0, x0 + w * 0.53, y0 + h * 0.55), fill=fill, outline=outline, width=4)
    draw.ellipse((x0 + w * 0.47, y0, x0 + w * 0.97, y0 + h * 0.55), fill=fill, outline=outline, width=4)
    polygon = [
        (x0 + w * 0.03, y0 + h * 0.27),
        (x0 + w * 0.97, y0 + h * 0.27),
        (x0 + w * 0.79, y0 + h * 0.69),
        (x0 + w * 0.50, y1),
        (x0 + w * 0.21, y0 + h * 0.69),
    ]
    draw.polygon(polygon, fill=fill, outline=outline)
    draw.line(polygon + [polygon[0]], fill=outline, width=4, joint="curve")


def draw_breadboard(draw, box):
    x0, y0, x1, y1 = box
    rr(draw, box, 12, "#f7f7f1", "#c7c7bd", 3)
    for x in range(int(x0 + 16), int(x1 - 14), 12):
        for y in range(int(y0 + 14), int(y1 - 12), 12):
            draw.ellipse((x - 2, y - 2, x + 2, y + 2), fill="#bfc3bd")
    draw.line((x0 + 12, y0 + 18, x0 + 12, y1 - 18), fill="#e95858", width=3)
    draw.line((x1 - 12, y0 + 18, x1 - 12, y1 - 18), fill="#498de2", width=3)


def draw_esp32(draw, box):
    x0, y0, x1, y1 = box
    rr(draw, box, 8, "#11181a", "#293b40", 3)
    rr(draw, (x0 + 18, y0 + 12, x1 - 18, y0 + 34), 5, "#d9d0bd", "#8f8575", 2)
    for y in range(int(y0 + 12), int(y1 - 10), 15):
        draw.rectangle((x0 - 5, y, x0 + 4, y + 5), fill="#c9b66e")
        draw.rectangle((x1 - 4, y, x1 + 5, y + 5), fill="#c9b66e")
    draw.ellipse((x1 - 22, y1 - 24, x1 - 8, y1 - 10), fill="#ff3b38")


def component_tag(draw, box, text):
    x0, y0, x1, y1 = box
    rr(draw, box, 9, "#ffffffcc", COLORS["ink"], 2)
    for index, line in enumerate(wrap(text, 18)):
        draw.text(((x0 + x1) / 2, y0 + 8 + index * 18), line, fill=COLORS["ink"], font=FONT_TINY, anchor="ma")


def title_banner(draw, center, text):
    x, y = center
    left, top, right, bottom = draw.textbbox((x, y), text, font=FONT_SMALL, anchor="ma")
    rr(draw, (left - 10, top - 5, right + 10, bottom + 6), 9, "#ffffffd9", "#b8d8d0", 1)
    draw.text((x, y), text, fill=COLORS["ink"], font=FONT_SMALL, anchor="ma")


def draw_display_pod(draw, box):
    x0, y0, x1, y1 = box
    rr(draw, box, 22, COLORS["screen"], COLORS["ink"], 4)
    rr(draw, (x0 + 25, y0 + 24, x1 - 25, y1 - 24), 14, "#eafff2", COLORS["ink"], 3)
    rr(draw, (x0 + 48, y0 + 42, x1 - 48, y1 - 41), 8, "#d7fff1", "#88bda6", 2)
    port(draw, ((x0 + x1) / 2, y1), "ribbon")
    title_banner(draw, ((x0 + x1) / 2, y0 - 18), "display direct clip")
    draw.text(((x0 + x1) / 2, y1 - 44), "ST7735 TFT", fill=COLORS["ink"], font=FONT_TINY, anchor="ma")


def draw_ear_pod(draw, box):
    x0, y0, x1, y1 = box
    draw.ellipse((x0, y0, x1, y1), fill=COLORS["ear"], outline=COLORS["ink"], width=4)
    draw.ellipse((x0 + 30, y0 + 22, x1 - 22, y1 - 20), outline="#2d6070", width=4)
    draw.ellipse((x0 + 57, y0 + 45, x0 + 88, y0 + 76), outline="#2d6070", width=4)
    component_tag(draw, (x0 + 25, y0 + 72, x1 - 25, y1 - 18), "INMP441 mic")
    port(draw, (x1, (y0 + y1) / 2), "I2S")
    title_banner(draw, ((x0 + x1) / 2, y0 - 16), "mic ear organ")


def draw_lung_pod(draw, box):
    x0, y0, x1, y1 = box
    mid = (x0 + x1) / 2
    rr(draw, (x0, y0 + 10, mid + 18, y1), 34, COLORS["lung"], COLORS["ink"], 4)
    rr(draw, (mid - 18, y0, x1, y1 - 10), 34, COLORS["lung"], COLORS["ink"], 4)
    draw.line((mid, y0 + 24, mid, y1 - 18), fill="#9e425d", width=4)
    component_tag(draw, (x0 + 26, y0 + 62, x1 - 26, y1 - 28), "MAX98357A I2S amp")
    port(draw, (x0, (y0 + y1) / 2), "I2S")
    port(draw, (x1, (y0 + y1) / 2 + 28), "spk")
    title_banner(draw, ((x0 + x1) / 2, y0 - 18), "voice lung organ")


def draw_spark_pod(draw, center, outer=74):
    cx, cy = center
    pts = star_points(cx, cy, outer, outer * 0.46)
    draw.polygon(pts, fill=COLORS["spark"], outline=COLORS["ink"])
    draw.line(pts + [pts[0]], fill=COLORS["ink"], width=4, joint="curve")
    component_tag(draw, (cx - 55, cy - 22, cx + 55, cy + 35), "TTP223 touch sensor")
    port(draw, (cx - outer + 5, cy + 24), "touch")
    title_banner(draw, (cx, cy - outer - 14), "touch spark organ")


def draw_battery_pod(draw, box):
    x0, y0, x1, y1 = box
    rr(draw, box, 34, COLORS["battery"], COLORS["ink"], 4)
    rr(draw, (x1 - 2, y0 + 28, x1 + 28, y1 - 28), 10, COLORS["battery"], COLORS["ink"], 4)
    draw.line((x0 + 28, y0 + 23, x1 - 34, y0 + 23), fill="#b76b1c", width=4)
    draw.line((x0 + 28, y1 - 23, x1 - 34, y1 - 23), fill="#b76b1c", width=4)
    component_tag(draw, (x0 + 25, y0 + 44, x1 - 35, y1 - 26), "LiPo / power lead")
    port(draw, (x1 + 28, (y0 + y1) / 2), "power")
    title_banner(draw, ((x0 + x1) / 2, y0 - 18), "energy cell organ")


def draw_charge_pod(draw, box):
    x0, y0, x1, y1 = box
    rr(draw, box, 24, COLORS["charge"], COLORS["ink"], 4)
    rr(draw, (x0 + 26, y0 + 40, x1 - 26, y1 - 28), 9, "#ffffffcc", COLORS["ink"], 2)
    rr(draw, ((x0 + x1) / 2 - 25, y1 - 11, (x0 + x1) / 2 + 25, y1 + 5), 7, "#222222", "#d7fff6", 2)
    component_tag(draw, (x0 + 20, y0 + 35, x1 - 20, y1 - 22), "TP4056 Type-C charger/protection")
    port(draw, (x0, (y0 + y1) / 2), "batt")
    port(draw, (x1, (y0 + y1) / 2), "out")
    title_banner(draw, ((x0 + x1) / 2, y0 - 18), "charge kidney organ")


def draw_boost_pod(draw, box):
    x0, y0, x1, y1 = box
    rr(draw, box, 24, COLORS["boost"], COLORS["ink"], 4)
    draw.ellipse((x0 + 32, y0 + 34, x0 + 78, y0 + 80), fill="#638e35", outline=COLORS["ink"], width=3)
    rr(draw, (x1 - 75, y0 + 38, x1 - 30, y0 + 80), 10, "#d5f6a2", COLORS["ink"], 3)
    component_tag(draw, (x0 + 20, y0 + 62, x1 - 20, y1 - 8), "MT3608 boost set to needed V")
    port(draw, (x0, (y0 + y1) / 2), "in")
    port(draw, (x1, (y0 + y1) / 2), "5V")
    title_banner(draw, ((x0 + x1) / 2, y0 - 18), "boost gland organ")


def draw_speaker_pod(draw, box):
    x0, y0, x1, y1 = box
    draw.ellipse(box, fill=COLORS["speaker"], outline=COLORS["ink"], width=5)
    draw.ellipse((x0 + 30, y0 + 30, x1 - 30, y1 - 30), fill="#12161a", outline="#6f767d", width=5)
    draw.ellipse((x0 + 58, y0 + 58, x1 - 58, y1 - 58), fill="#303840", outline="#90979d", width=4)
    draw.arc((x0 + 48, y0 + 55, x1 - 48, y1 - 45), start=20, end=160, fill="#d7fff6", width=5)
    port(draw, (x0, (y0 + y1) / 2), "spk")
    title_banner(draw, ((x0 + x1) / 2, y0 - 22), "speaker direct side clip")
    draw.text(((x0 + x1) / 2, y1 + 12), "speaker driver", fill=COLORS["muted"], font=FONT_TINY, anchor="ma")


def main():
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)

    img = Image.new("RGB", (W, H), COLORS["bg"])
    draw = ImageDraw.Draw(img, "RGBA")

    draw.text((60, 44), "BMO component placement simulation", fill=COLORS["ink"], font=FONT_TITLE)
    draw.text(
        (62, 96),
        "Organ pods drop onto keyed tray pegs; display and speaker clip directly into the body.",
        fill=COLORS["muted"],
        font=FONT_BODY,
    )

    # Open front panel on the left.
    rr(draw, (85, 220, 430, 1020), 38, COLORS["body"], COLORS["ink"], 5)
    rr(draw, (130, 280, 385, 455), 18, COLORS["screen"], COLORS["ink"], 4)
    draw.ellipse((185, 340, 198, 372), fill=COLORS["ink"])
    draw.ellipse((315, 340, 328, 372), fill=COLORS["ink"])
    draw.arc((218, 360, 294, 420), start=15, end=165, fill=COLORS["ink"], width=4)
    rr(draw, (162, 515, 320, 543), 8, "#173b39", COLORS["ink"], 3)
    draw.rectangle((155, 660, 245, 688), fill=COLORS["spark"], outline=COLORS["ink"], width=3)
    draw.rectangle((186, 629, 214, 719), fill=COLORS["spark"], outline=COLORS["ink"], width=3)
    draw.ellipse((315, 705, 385, 775), fill="#e84d4b", outline=COLORS["ink"], width=4)
    draw.ellipse((350, 618, 393, 661), fill="#52c965", outline=COLORS["ink"], width=4)
    draw.polygon([(285, 640), (322, 705), (248, 705)], fill="#70d8e8", outline=COLORS["ink"])
    draw.text((258, 1037), "front panel", fill=COLORS["muted"], font=FONT_SMALL, anchor="ma")

    # Main open tray.
    rr(draw, (515, 170, 1285, 1085), 52, COLORS["body"], COLORS["ink"], 5)
    rr(draw, (575, 225, 1225, 1030), 30, COLORS["tray"], "#baf7ef", 5)
    rr(draw, (620, 250, 1180, 980), 24, COLORS["tray2"], "#2d6b66", 3)

    # Side dots and BMO mark.
    for row, y in enumerate((260, 292, 324)):
        for col, x in enumerate((1244, 1274, 1304)):
            if (row, col) not in {(0, 2), (2, 0)}:
                draw.ellipse((x - 6, y - 6, x + 6, y + 6), fill=COLORS["ink"])
    draw.text((1297, 435), "BMO", fill=COLORS["ink"], font=font(56, True), anchor="mm")

    # Component organ pods inside tray.
    display = (730, 240, 1085, 350)
    touch_center = (1138, 458)
    mic = (600, 410, 750, 545)
    lung = (1072, 558, 1220, 710)
    battery = (610, 835, 820, 940)
    charge = (645, 300, 805, 390)
    boost = (1005, 300, 1175, 390)
    speaker = (1000, 835, 1170, 1005)
    heart = (760, 470, 1045, 775)

    draw_display_pod(draw, display)
    draw_spark_pod(draw, touch_center)
    draw_ear_pod(draw, mic)
    draw_lung_pod(draw, lung)
    draw_battery_pod(draw, battery)
    draw_charge_pod(draw, charge)
    draw_boost_pod(draw, boost)
    draw_speaker_pod(draw, speaker)

    # Heart pod and electronics.
    draw_heart(draw, heart, COLORS["heart"], COLORS["ink"])
    draw_heart(draw, (heart[0] + 10, heart[1] + 13, heart[2] - 10, heart[3] - 9), "#f7bfd5", COLORS["heart_shadow"])
    draw.text(((heart[0] + heart[2]) / 2, heart[1] + 42), "heart organ", fill=COLORS["ink"], font=FONT_H2, anchor="ma")
    draw.text(((heart[0] + heart[2]) / 2, heart[1] + 73), "ESP32 + breadboard hub", fill=COLORS["ink"], font=FONT_SMALL, anchor="ma")
    draw_breadboard(draw, (790, 575, 920, 705))
    draw_esp32(draw, (935, 590, 1010, 700))
    draw.text((855, 717), "mini breadboard", fill=COLORS["ink"], font=FONT_TINY, anchor="ma")
    draw.text((973, 717), "ESP32", fill=COLORS["ink"], font=FONT_TINY, anchor="ma")

    # Heart hub ports.
    port(draw, (790, 575), "mic")
    port(draw, (910, 470), "display")
    port(draw, (1040, 620), "amp")
    port(draw, (1015, 745), "speaker")
    port(draw, (795, 740), "power")
    port(draw, (760, 505), "charge")
    port(draw, (1040, 505), "boost")
    port(draw, (1010, 510), "touch")
    port(draw, (900, 775), "usb")

    # Cable bundles.
    bundle(draw, (900, 350), (895, 410), (910, 470), [COLORS["wire_red"], COLORS["wire_black"], COLORS["wire_yellow"], COLORS["wire_blue"], COLORS["wire_green"], COLORS["wire_orange"]], 5, 5)
    bundle(draw, (750, 478), (770, 520), (790, 575), [COLORS["wire_red"], COLORS["wire_black"], COLORS["wire_yellow"], COLORS["wire_blue"], COLORS["wire_white"]], 5, 5)
    bundle(draw, (1069, 482), (1038, 485), (1010, 510), [COLORS["wire_red"], COLORS["wire_black"], COLORS["wire_green"]], 5, 5)
    bundle(draw, (1072, 634), (1050, 630), (1040, 620), [COLORS["wire_red"], COLORS["wire_black"], COLORS["wire_orange"], COLORS["wire_blue"], COLORS["wire_white"]], 5, 5)
    bundle(draw, (1000, 920), (990, 810), (1015, 745), [COLORS["wire_red"], COLORS["wire_black"]], 6, 7)
    bundle(draw, (820, 890), (725, 730), (725, 345), [COLORS["wire_red"], COLORS["wire_black"]], 6, 7)
    bundle(draw, (805, 345), (885, 335), (1005, 345), [COLORS["wire_red"], COLORS["wire_black"]], 6, 7)
    bundle(draw, (1175, 345), (1090, 420), (1040, 505), [COLORS["wire_red"], COLORS["wire_black"]], 6, 7)
    bundle(draw, (795, 740), (815, 660), (845, 610), [COLORS["wire_red"], COLORS["wire_black"], COLORS["wire_white"]], 5, 6)
    bundle(draw, (900, 775), (895, 915), (900, 1030), [COLORS["wire_red"], COLORS["wire_black"], COLORS["wire_white"], COLORS["wire_green"]], 5, 5)

    # Cable exit.
    rr(draw, (842, 1015, 958, 1058), 16, "#101d1d", "#d7fff6", 3)
    draw.text((900, 1067), "rear USB / service cable exit", fill=COLORS["muted"], font=FONT_SMALL, anchor="ma")

    # Label callouts.
    label(draw, (1365, 232), "Heart hub", "Largest organ. Holds ESP32 and the mini breadboard or extension board. All other pods plug into this hub.", 30)
    label(draw, (1365, 390), "Cable ports", "Heart has several 10.5 mm bundle slots plus a 16 mm display ribbon slot. Smaller organs have one heart-facing port.", 30)
    label(draw, (1365, 575), "Power chain", "Battery goes to TP4056, TP4056 protected output goes to MT3608, then regulated output feeds the heart rails.", 30)
    label(draw, (1365, 760), "Shake safety", "Keyed pegs/rails hold pods. Printed wire combs strain-relieve bundles, but grouped locking plugs are best for real shake-proof wiring.", 30)

    # Small legend.
    rr(draw, (60, 1065, 1735, 1145), 20, "#ffffffcc", "#cfe2dc", 2)
    legend_items = [
        ("display ribbon / SPI", COLORS["wire_orange"]),
        ("I2S + mic data", COLORS["wire_blue"]),
        ("power", COLORS["wire_red"]),
        ("ground", COLORS["wire_black"]),
        ("signal", COLORS["wire_green"]),
        ("speaker leads", COLORS["wire_white"]),
    ]
    x = 95
    for text, color in legend_items:
        draw.line((x, 1104, x + 48, 1104), fill=color, width=7)
        draw.text((x + 60, 1089), text, fill=COLORS["ink"], font=FONT_SMALL)
        x += 260

    img.save(OUT_PATH)
    print(OUT_PATH)


if __name__ == "__main__":
    main()
