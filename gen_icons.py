import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icons")
os.makedirs(OUT, exist_ok=True)

# 找一个支持中文的字体
FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyh.ttc",      # 微软雅黑
    r"C:\Windows\Fonts\msyhbd.ttc",    # 微软雅黑粗体
    r"C:\Windows\Fonts\simhei.ttf",    # 黑体
    r"C:\Windows\Fonts\simsun.ttc",    # 宋体
]
FONT = None
for f in FONT_CANDIDATES:
    if os.path.exists(f):
        FONT = f
        break
if FONT is None:
    raise SystemExit("找不到中文字体")

def rounded_gradient(size, c1, c2):
    """生成圆角渐变背景（去透明后的底为纯色，用于 maskable）。"""
    w, h = size, size
    base = Image.new("RGB", (w, h), c1)
    # 简单对角线渐变
    px = base.load()
    for y in range(h):
        for x in range(w):
            t = (x + y) / (w + h)
            r = int(c1[0] + (c2[0] - c1[0]) * t)
            g = int(c1[1] + (c2[1] - c1[1]) * t)
            b = int(c1[2] + (c2[2] - c1[2]) * t)
            px[x, y] = (r, g, b)
    return base

def make_icon(size, maskable=False):
    bg = rounded_gradient(size, (34, 28, 78), (94, 53, 167))  # 深紫->紫红渐变
    img = bg.convert("RGBA")
    d = ImageDraw.Draw(img)

    # 中央白色圆角卡片，模拟一张扑克
    pad = int(size * 0.16)
    card_box = [pad, pad, size - pad, size - pad]
    d.rounded_rectangle(card_box, radius=int(size * 0.10), fill=(255, 255, 255, 255))

    # 文字：扑克（大字）
    big = int(size * 0.34)
    try:
        f_big = ImageFont.truetype(FONT, big)
    except Exception:
        f_big = ImageFont.truetype(FONT, big)
    text = "扑克"
    tb = d.textbbox((0, 0), text, font=f_big)
    tw, th = tb[2] - tb[0], tb[3] - tb[1]
    tx = (size - tw) / 2 - tb[0]
    ty = (size - th) / 2 - tb[1] - int(size * 0.02)
    # 文字颜色：红黑双色（扑克感）——这里用深紫
    d.text((tx, ty), text, font=f_big, fill=(46, 31, 92, 255))

    # 左上角小红心 / 右上角小黑桃 点缀
    small = int(size * 0.10)
    try:
        f_s = ImageFont.truetype(FONT, small)
    except Exception:
        f_s = ImageFont.truetype(FONT, small)
    d.text((pad + int(size*0.04), pad + int(size*0.03)), "♥", font=f_s, fill=(214, 40, 60, 255))
    d.text((size - pad - int(size*0.10), pad + int(size*0.03)), "♠", font=f_s, fill=(40, 40, 50, 255))

    if maskable:
        # maskable：已全幅背景，无需额外处理，但加一层微阴影边界增强辨识
        pass
    else:
        # 非 maskable：做圆角裁切（透明外角），更贴合图标形状
        mask = Image.new("L", (size, size), 0)
        md = ImageDraw.Draw(mask)
        md.rounded_rectangle([0, 0, size, size], radius=int(size * 0.22), fill=255)
        img.putalpha(mask)

    return img

# 192 标准图标（圆角透明）
make_icon(192, maskable=False).save(os.path.join(OUT, "icon-192.png"), "PNG")
# 512 标准图标
make_icon(512, maskable=False).save(os.path.join(OUT, "icon-512.png"), "PNG")
# 512 maskable（全幅，内容在安全区）
make_icon(512, maskable=True).save(os.path.join(OUT, "icon-maskable-512.png"), "PNG")
# apple-touch-icon 180（iOS 要求非透明，圆角由系统处理，给全幅）
make_icon(180, maskable=True).save(os.path.join(OUT, "apple-touch-icon.png"), "PNG")
# favicon 64
make_icon(64, maskable=False).save(os.path.join(OUT, "favicon-64.png"), "PNG")

print("icons generated:", os.listdir(OUT))
