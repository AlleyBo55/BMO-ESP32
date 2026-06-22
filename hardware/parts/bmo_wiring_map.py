"""Generate a visual wiring map for BMO's organ pods."""

from __future__ import annotations

from pathlib import Path
from textwrap import wrap

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
EXPORT_DIR = ROOT / "exports"
OUT_PATH = EXPORT_DIR / "bmo_organ_wiring_map.png"

W, H = 1800, 1700

COLORS = {
    "bg": "#eef6f2",
    "ink": "#123231",
    "muted": "#496966",
    "heart": "#f08eb8",
    "display": "#bff4d7",
    "ear": "#87d2f4",
    "lung": "#f5a0bb",
    "speaker": "#30343b",
    "spark": "#ffd544",
    "battery": "#ffb15b",
    "charge": "#caa8ff",
    "boost": "#a5db66",
    "power": "#e84d4b",
    "ground": "#222222",
    "signal": "#34b66b",
    "spi": "#ff8c3a",
    "i2s": "#3b8eea",
    "white": "#f7f3e8",
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


TITLE = font(44, True)
H2 = font(27, True)
BODY = font(22)
SMALL = font(18)
TINY = font(15)


def rr(draw, box, radius, fill, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def node(draw, box, title, subtitle, fill):
    x0, y0, x1, y1 = box
    rr(draw, box, 28, fill, COLORS["ink"], 4)
    draw.text(((x0 + x1) / 2, y0 + 18), title, fill=COLORS["ink"], font=H2, anchor="ma")
    y = y0 + 55
    for line in wrap(subtitle, 24):
        draw.text(((x0 + x1) / 2, y), line, fill=COLORS["ink"], font=SMALL, anchor="ma")
        y += 23


def line(draw, start, end, color, text, width=7, bend=0):
    sx, sy = start
    ex, ey = end
    mx = (sx + ex) / 2 + bend
    pts = [(sx, sy), (mx, sy), (mx, ey), (ex, ey)]
    draw.line(pts, fill=color, width=width, joint="curve")
    rr(draw, (mx - 120, (sy + ey) / 2 - 18, mx + 120, (sy + ey) / 2 + 18), 10, "#ffffffd9", "#c7ddd8", 1)
    draw.text((mx, (sy + ey) / 2 - 11), text, fill=COLORS["ink"], font=TINY, anchor="ma")


def pin_table(draw, box):
    x0, y0, x1, y1 = box
    rr(draw, box, 20, "#ffffffcc", "#bfd8d2", 2)
    draw.text((x0 + 24, y0 + 22), "ESP32-C3 heart hub pin map", fill=COLORS["ink"], font=H2)
    rows = [
        ("Display CS", "GP7"),
        ("Display RESET", "GP10"),
        ("Display DC / A0", "GP3"),
        ("Display MOSI / SDA", "GP6"),
        ("Display SCK", "GP4"),
        ("I2S BCLK shared", "GP0"),
        ("I2S LRC / WS shared", "GP1"),
        ("I2S speaker DOUT", "GP2"),
        ("I2S mic SD / DOUT", "GP5"),
        ("Touch OUT", "GP20"),
        ("Power input", "from MT3608 output"),
        ("Ground", "common GND rail"),
    ]
    y = y0 + 72
    for name, pin in rows:
        draw.text((x0 + 28, y), name, fill=COLORS["muted"], font=SMALL)
        draw.text((x1 - 35, y), pin, fill=COLORS["ink"], font=SMALL, anchor="ra")
        y += 31


def main():
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    img = Image.new("RGB", (W, H), COLORS["bg"])
    draw = ImageDraw.Draw(img, "RGBA")

    draw.text((65, 50), "BMO organ wiring map", fill=COLORS["ink"], font=TITLE)
    draw.text(
        (67, 102),
        "Every organ has its own module inside, but electrically all wires return to the heart hub.",
        fill=COLORS["muted"],
        font=BODY,
    )

    heart = (690, 410, 1110, 790)
    node(draw, heart, "HEART ORGAN", "ESP32-C3 Super Mini + mini breadboard / extension board", COLORS["heart"])
    rr(draw, (755, 555, 905, 700), 14, "#fbfbf6", "#c5c5b8", 3)
    draw.text((830, 615), "mini breadboard", fill=COLORS["ink"], font=SMALL, anchor="ma")
    rr(draw, (925, 565, 1035, 700), 12, "#11181a", "#293b40", 3)
    draw.text((980, 615), "ESP32", fill="#f4f4e6", font=SMALL, anchor="ma")

    display = (650, 180, 1150, 300)
    mic = (160, 355, 520, 500)
    touch = (1280, 355, 1640, 500)
    lung = (1280, 645, 1640, 800)
    speaker = (1280, 880, 1640, 1035)
    battery = (135, 820, 465, 975)
    charge = (510, 865, 820, 1005)
    boost = (980, 865, 1290, 1005)
    usb = (705, 1075, 1095, 1200)

    node(draw, display, "DISPLAY DIRECT CLIP", "ST7735 TFT: VCC, GND, LED, CS, RST, DC, MOSI, SCK", COLORS["display"])
    node(draw, mic, "MIC EAR ORGAN", "INMP441 mic: VDD, GND, SCK, WS, SD, L/R strap", COLORS["ear"])
    node(draw, touch, "TOUCH SPARK ORGAN", "TTP223: VCC, GND, OUT", COLORS["spark"])
    node(draw, lung, "VOICE LUNG ORGAN", "MAX98357A amp: VIN, GND, BCLK, LRC, DIN", COLORS["lung"])
    node(draw, speaker, "SPEAKER DIRECT CLIP", "Speaker driver connects only to amplifier output + / -", COLORS["speaker"])
    node(draw, battery, "ENERGY CELL ORGAN", "103450 LiPo raw battery lead", COLORS["battery"])
    node(draw, charge, "CHARGE KIDNEY ORGAN", "TP4056 Type-C charger/protection: B+/B-, OUT+/OUT-", COLORS["charge"])
    node(draw, boost, "BOOST GLAND ORGAN", "MT3608 boost converter: IN+/IN-, adjusted OUT+/OUT-", COLORS["boost"])
    node(draw, usb, "SERVICE / USB EXIT", "USB cable for power, flashing, and serial logs", "#d9eee9")

    line(draw, (900, 410), (900, 300), COLORS["spi"], "SPI bundle: GP7 GP10 GP3 GP6 GP4 + 3V3/GND", 7)
    line(draw, (690, 545), (520, 430), COLORS["i2s"], "mic shares GP0 BCLK + GP1 WS, mic SD -> GP5", 7, bend=-80)
    line(draw, (1110, 545), (1280, 430), COLORS["signal"], "touch OUT -> GP20, plus 3V3/GND", 7, bend=80)
    line(draw, (1110, 650), (1280, 720), COLORS["i2s"], "amp: GP0 BCLK, GP1 LRC, GP2 DIN + power", 7, bend=85)
    line(draw, (1460, 800), (1460, 880), COLORS["white"], "speaker + / - from amp output", 8)
    line(draw, (465, 900), (510, 935), COLORS["power"], "raw LiPo -> TP4056 B+ / B-", 8, bend=25)
    line(draw, (820, 935), (980, 935), COLORS["power"], "protected OUT -> MT3608 input", 8)
    line(draw, (1135, 865), (990, 790), COLORS["power"], "boost output -> heart power rail", 8, bend=-70)
    line(draw, (900, 790), (900, 1075), COLORS["ground"], "USB / service cable leaves body", 8)

    pin_table(draw, (70, 1215, 1730, 1665))
    img.save(OUT_PATH)
    print(OUT_PATH)


if __name__ == "__main__":
    main()
