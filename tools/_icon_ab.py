# -*- coding: utf-8 -*-
"""方案 A（番茄光盘）与它的「去掉中圈白环」精简版做一张对照图。

起因：A 缩到 16px 只剩一个红蓝点 —— 白环 + 白中心孔把红果切成三圈，
小尺寸下"番茄"的形体被切碎了。把中间那圈白环去掉、只留中心孔，
红盘面就完整了（缩下来是红圆 + 白心 + 绿蒂，跟 🍅 一致），
银灰盘缘仍然保留光盘感。

产出两张图到临时目录，再交给 tools/_icon_compare.py 出标准对比表
（48/32/16px 放大 + 深浅任务栏），格式与之前几轮一致，方便直接比。
"""
import importlib.util
import os

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "dist", "_uicheck", "repro", "_ab")


def load_geo():
    path = os.path.join(ROOT, "tools", "_tomato_geo.py")
    spec = importlib.util.spec_from_file_location("tomato_geo", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


G = load_geo()


def plan_disc_plain():
    """A 的精简版：银灰盘缘 + 红盘面 + 白中心孔 + 萼片，去掉中圈白环。"""
    im, d = G.canvas()
    R = 336
    d.ellipse([G.P(G.CX - R), G.P(548 - R), G.P(G.CX + R), G.P(548 + R)], fill=G.GREY)
    r2 = R - 42
    d.ellipse([G.P(G.CX - r2), G.P(548 - r2), G.P(G.CX + r2), G.P(548 + r2)], fill=G.RED)
    G.hole(d, 548, 92)
    G.calyx(d, G.CX, 548 - R + R * 0.30, R * 0.46)
    return im


os.makedirs(OUT, exist_ok=True)
jobs = [("A", "2026-10-13T00-04-01", G.plan_disc, "现选（含中圈白环）"),
        ("B", "2026-10-13T00-04-08", plan_disc_plain, "精简版（去白环）")]
for tag, stamp, fn, desc in jobs:
    im = fn().resize((G.S, G.S), Image.LANCZOS)
    p = os.path.join(OUT, "%s_%s.png" % (tag, stamp))
    im.save(p)
    print("%s  %-20s %s" % (tag, desc, p))
