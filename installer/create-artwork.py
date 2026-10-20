#!/usr/bin/env python3
"""Create original Promo Iaulin Windows artwork. Only needed on the CI build machine."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "build-artifacts"
OUT.mkdir(exist_ok=True)
INK = (51, 38, 59)
SAGE = (215, 227, 182)
CREAM = (248, 247, 244)

def font(size, bold=False):
    path = Path("C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf")
    return ImageFont.truetype(str(path), size) if path.exists() else ImageFont.load_default()

icon = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
paint = ImageDraw.Draw(icon)
paint.rounded_rectangle((10, 10, 502, 502), radius=125, fill=INK)
paint.line([(161, 368), (161, 154), (281, 154)], fill=SAGE, width=44, joint="curve")
paint.arc((223, 155, 370, 300), 270, 90, fill=SAGE, width=44)
paint.line((163, 293, 290, 293), fill=SAGE, width=44)
paint.line((287, 351, 392, 245), fill=SAGE, width=29)
paint.line([(330, 246), (395, 246), (395, 310)], fill=SAGE, width=27, joint="curve")
icon.save(OUT / "iaulin.ico", format="ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

sidebar = Image.new("RGB", (200, 420), INK)
p = ImageDraw.Draw(sidebar)
p.rounded_rectangle((40, 46, 160, 166), radius=29, fill=(70, 59, 79))
logo = icon.resize((130, 130), Image.Resampling.LANCZOS).convert("RGBA")
sidebar.paste(logo, (35, 41), logo)
p.text((28, 220), "PROMO", fill=CREAM, font=font(25, True))
p.text((28, 257), "IAULIN", fill=CREAM, font=font(27, True))
p.line((28, 320, 170, 320), fill=SAGE, width=3)
p.text((28, 344), "Conexao segura", fill=SAGE, font=font(14))
sidebar.save(OUT / "wizard.bmp", format="BMP")
header = Image.new("RGB", (80, 80), CREAM)
mini = icon.resize((70, 70), Image.Resampling.LANCZOS).convert("RGBA")
header.paste(mini, (5, 5), mini)
header.save(OUT / "wizard-small.bmp", format="BMP")
print("Artwork created:", OUT)
