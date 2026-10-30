#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""自建图形验证码（人机验证第一道闸）—— 不依赖任何第三方账号。

为什么自建而不是 Turnstile / 极验
    Turnstile：实测国内加载 3.3 秒 / 87KB，且要 Cloudflare 账号 + site key + secret；
               更麻烦的是它**必须配服务端 siteverify**，否则前端 token 形同虚设。
    极验：0.54 秒很快，但要注册企业/个人开发者账号、拿 ID+KEY，还要写服务端二次校验。
    自建：0 依赖、0 成本、0 账号，服务端**自己生成自己校验**，天生不可绕过
          （答案只在服务端内存里，前端拿到的只是一张 PNG）。

安全性怎么保证（重要，别以为图形码弱就没用）
    图形码本身可被 OCR，但它不是唯一的防线，而是**组合拳的一环**：
      1. 一次性：校验成功立即从内存删除，重放无效
      2. 短 TTL：180 秒过期
      3. 配合限流：同 IP 注册/登录失败次数、同邮箱发码次数都有上限（见 pay_service.py）
      4. 真正拦住批量注册的是**邮箱验证码**（要能收信），图形码只负责挡掉无脑脚本

设计约束
    · 只用标准库 + PIL（服务器已装 python3-pil）
    · 内存存储，服务重启即失效 —— 可接受（验证码本来只活 3 分钟）
    · 线程安全：ThreadingHTTPServer 是多线程的，所有读写都加锁
"""

from __future__ import annotations

import base64
import io
import random
import secrets
import threading
import time
from typing import Optional

try:
    from PIL import Image, ImageDraw, ImageFont
    _PIL_OK = True
except Exception:  # noqa: BLE001  —— 没装 PIL 时降级为「不可用」，不拖垮整个服务
    _PIL_OK = False

# 去掉容易看错的 0/O/1/I/l
ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
LENGTH = 4
TTL_SECONDS = 180
MAX_ENTRIES = 5000

FONT_CANDIDATES = (
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
)


class CaptchaStore:
    """线程安全的一次性验证码存储。"""

    #: 同一张图允许输错的次数。1 次太苛刻 —— 用户把 Q 看成 O 就得重新换图，
    #: 这是「防机器人」变成「刁难真人」。3 次足够挡暴力猜（36^4 的 4 位码，
    #: 单张图错 3 次即作废，爆破成本高到没有意义）。
    MAX_TRIES = 3

    def __init__(self, ttl: int = TTL_SECONDS, max_entries: int = MAX_ENTRIES):
        self.ttl = ttl
        self.max_entries = max_entries
        # cid -> (答案, 过期时间, 已错次数)
        self._data: dict[str, tuple[str, float, int]] = {}
        self._lock = threading.Lock()

    # ---------- 内部 ----------
    def _purge_locked(self) -> None:
        now = time.time()
        dead = [k for k, (_, exp, _t) in self._data.items() if exp < now]
        for k in dead:
            self._data.pop(k, None)
        # 硬上限：万一被刷爆，按过期时间淘汰最旧的
        if len(self._data) > self.max_entries:
            ordered = sorted(self._data.items(), key=lambda kv: kv[1][1])
            for k, _ in ordered[: len(self._data) - self.max_entries]:
                self._data.pop(k, None)

    # ---------- 对外 ----------
    def issue(self, answer: str) -> str:
        cid = secrets.token_urlsafe(16)
        with self._lock:
            self._purge_locked()
            self._data[cid] = (answer.strip().upper(), time.time() + self.ttl, 0)
        return cid

    def verify(self, cid: str, answer: str, keep: bool = False) -> tuple[bool, str]:
        """校验验证码。返回 (是否通过, 原因)。

        keep=False（默认）：**校验即消费**。认证类动作（注册/登录/重置）用它。
        keep=True：答对了**保留**这条。只给「发送邮箱验证码」用 ——
            否则用户注册要点两次图形码（发码一次、提交一次），体验很差。

        输错**不作废**，累计到 MAX_TRIES 才废 —— 把 Q 看成 O 就要换图太折磨人。
        """
        cid = (cid or "").strip()
        answer = (answer or "").strip().upper()
        if not cid or not answer:
            return False, "missing"
        with self._lock:
            item = self._data.get(cid)
            if item is None:
                return False, "expired"
            expect, exp, tries = item
            if exp < time.time():
                self._data.pop(cid, None)
                return False, "expired"
            if not secrets.compare_digest(expect, answer):
                tries += 1
                if tries >= self.MAX_TRIES:
                    self._data.pop(cid, None)      # 错满 3 次才作废
                    return False, "too_many_tries"
                self._data[cid] = (expect, exp, tries)
                return False, "mismatch"
            if not keep:
                self._data.pop(cid, None)          # 答对且不保留 → 消费掉
            return True, "ok"

    def _tries(self, cid: str) -> int:
        with self._lock:
            item = self._data.get(cid)
            return item[2] if item else -1

    def stats(self) -> dict:
        with self._lock:
            self._purge_locked()
            return {"pending": len(self._data), "ttl": self.ttl}


STORE = CaptchaStore()


def _load_font(size: int):
    for path in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except Exception:  # noqa: BLE001
            continue
    try:
        return ImageFont.load_default()
    except Exception:  # noqa: BLE001
        return None


def render(text: str) -> Optional[bytes]:
    """把验证码画成 PNG。返回 None 表示环境不支持（未装 PIL）。

    做法：先在一张**足够高**的条带上逐字画（各自微旋转），再整体轻微旋转，
    最后从中间裁出成品尺寸。
    ⚠️ 不要"直接在小画布上逐字旋转再贴" —— 旋转会改外框，60×60 的格子
    把字的下缘切掉过（第一版就是这样，E/Y 的底边整条没了）。
    """
    if not _PIL_OK:
        return None

    font = _load_font(40)
    if font is None:
        return None

    width, height = 176, 62
    pad_y = 14                      # 上下各留的余量（旋转用）
    strip = Image.new("RGB", (width, height + pad_y * 2), (16, 17, 19))
    draw = ImageDraw.Draw(strip)

    # 背景噪点
    for _ in range(460):
        x = random.randrange(width)
        y = random.randrange(strip.height)
        v = random.randint(55, 115)
        draw.point((x, y), fill=(v, v, v))

    # 干扰线（画在条带坐标系里，跟着整体旋转）
    for _ in range(5):
        x1, y1 = random.randrange(width), random.randrange(strip.height)
        x2, y2 = random.randrange(width), random.randrange(strip.height)
        draw.line((x1, y1, x2, y2), fill=(random.randint(70, 130),) * 3, width=1)

    slot = width // len(text)
    for i, ch in enumerate(text):
        # 每个字在自己的小画布上：够大 + 按 bbox 精确居中，然后整格贴到条带
        cell = 64
        glyph = Image.new("RGB", (cell, cell), (16, 17, 19))
        gd = ImageDraw.Draw(glyph)
        color = random.choice([(228, 230, 232), (198, 210, 222), (236, 224, 208)])
        bbox = gd.textbbox((0, 0), ch, font=font)
        gw, gh = bbox[2] - bbox[0], bbox[3] - bbox[1]
        gx = (cell - gw) // 2 - bbox[0]
        gy = (cell - gh) // 2 - bbox[1]
        gd.text((gx, gy), ch, font=font, fill=color)
        ang = random.uniform(-20, 20)
        glyph = glyph.rotate(ang, resample=Image.BICUBIC, fillcolor=(16, 17, 19))
        x = slot * i + (slot - cell) // 2
        # 贴到条带垂直居中
        y = (strip.height - cell) // 2 + random.randint(-3, 3)
        strip.paste(glyph, (x, y))

    # 整体轻微倾斜（±3°），再裁中间
    strip = strip.rotate(random.uniform(-3, 3), resample=Image.BICUBIC, fillcolor=(16, 17, 19))
    top = (strip.height - height) // 2
    img = strip.crop((0, top, width, top + height))

    # 前景细横线
    d2 = ImageDraw.Draw(img)
    for _ in range(3):
        y = random.randrange(height)
        d2.line((0, y, width, y), fill=(52, 54, 58), width=1)

    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def new_captcha() -> dict:
    """生成一组验证码，返回给前端的结构（**不含答案**）。"""
    text = "".join(random.choice(ALPHABET) for _ in range(LENGTH))
    cid = STORE.issue(text)
    png = render(text)
    if png is None:
        return {"ok": False, "reason": "captcha_unavailable"}
    b64 = base64.b64encode(png).decode("ascii")
    return {
        "ok": True,
        "id": cid,
        "image": "data:image/png;base64," + b64,
        "ttl": TTL_SECONDS,
        "length": LENGTH,
    }


def verify(cid: str, answer: str, keep: bool = False) -> tuple[bool, str]:
    return STORE.verify(cid, answer, keep=keep)
