#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""邮件验证码发送（复用已有的 QQ 邮箱 SMTP 凭据）。

为什么用邮件而不是短信
    短信（阿里云「短信认证」）当前被卡住：配置的 `恒创联众 / 100001` 返回 UNKNOWN，
    赠送的那一对签名模板必须登录控制台才能抄到——在那之前短信不可用。
    而 QQ 邮箱 SMTP **实测可用**（2026-10-21 发信成功），且免费、无条数限制。
    邮箱验证码足以挡住批量注册（对方必须有真实可收信的邮箱）。

凭据来源（按优先级）
    1. 环境变量 CTBU_SMTP_JSON 指定的文件
    2. /etc/ctbu-pay/mail.json
    3. 复用 /etc/ctbu-pay/watchdog.json 里的 smtp_* 字段（**当前实际走这条**）
"""

from __future__ import annotations

import json
import logging
import os
import smtplib
import ssl
import threading
import time
from email.message import EmailMessage
from typing import Any

log = logging.getLogger("ctbu-mail")

MAIL_CONFIG = os.environ.get("CTBU_MAIL_CONFIG", "/etc/ctbu-pay/mail.json")
WATCHDOG_CONFIG = "/etc/ctbu-pay/watchdog.json"


def _load_cfg() -> dict[str, Any] | None:
    for path in (MAIL_CONFIG, WATCHDOG_CONFIG):
        try:
            with open(path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
        except FileNotFoundError:
            continue
        except Exception as e:  # noqa: BLE001
            log.warning("读 %s 失败：%s", path, e)
            continue
        user = str(cfg.get("smtp_user") or "").strip()
        pwd = str(cfg.get("smtp_pass") or "").strip()
        if user and pwd:
            return {
                "host": str(cfg.get("smtp_host") or "smtp.qq.com").strip(),
                "port": int(cfg.get("smtp_port") or 465),
                "user": user,
                "pass": pwd,
                "from_name": str(cfg.get("smtp_from_name") or "工商真题库").strip(),
            }
    return None


CFG = _load_cfg()
if CFG:
    log.info("邮件通道已启用：%s:%s 发件人=%s", CFG["host"], CFG["port"], CFG["user"])
else:
    log.warning("邮件凭据不存在，邮箱验证码不可用")


def available() -> bool:
    return CFG is not None


def send_code(to_email: str, code: str, ttl_minutes: int = 10) -> tuple[bool, str]:
    """发送验证码邮件。返回 (成功, 失败原因)。"""
    if not CFG:
        return False, "mail_not_configured"

    msg = EmailMessage()
    # ⚠️ Python 3.12 起 EmailMessage 用新 policy：头部只能传**字符串**，
    #    传 email.header.Header 会抛 TypeError: 'Header' object is not subscriptable。
    #    中文由 policy.default 自动做 RFC 2047 编码。
    msg["From"] = f"{CFG['from_name']} <{CFG['user']}>"
    msg["To"] = to_email
    msg["Subject"] = f"【工商真题库】验证码 {code}（{ttl_minutes} 分钟内有效）"
    msg.set_content(
        f"你的验证码是：\n\n"
        f"    {code}\n\n"
        f"{ttl_minutes} 分钟内有效，仅可使用一次。\n"
        f"如果不是你本人操作，忽略本邮件即可，你的账号不会有任何变化。\n\n"
        f"—— 工商真题库 https://louisnb.cn\n"
    )

    try:
        ctx = ssl.create_default_context()
        if CFG["port"] == 465:
            with smtplib.SMTP_SSL(CFG["host"], CFG["port"], timeout=20, context=ctx) as s:
                s.login(CFG["user"], CFG["pass"])
                s.send_message(msg)
        else:
            with smtplib.SMTP(CFG["host"], CFG["port"], timeout=20) as s:
                s.starttls(context=ctx)
                s.login(CFG["user"], CFG["pass"])
                s.send_message(msg)
        return True, "ok"
    except smtplib.SMTPAuthenticationError:
        return False, "auth_failed"
    except smtplib.SMTPRecipientsRefused:
        return False, "bad_recipient"
    except Exception as e:  # noqa: BLE001
        log.error("发信失败 %s：%s %s", to_email, type(e).__name__, e)
        return False, f"send_failed:{type(e).__name__}"


def send_plain(to_email: str, subject: str, body: str) -> tuple[bool, str]:
    """发一封纯文本通知邮件（2026-10-28 加）。

    用途：站点给自己发告警（支付异常、迟付补开通、对账差异），不是验证码。
    和 send_code 共用同一套 SMTP 配置，但**不经过** CodeStore，
    也不会被发码配额影响 —— 告警不能被"今天验证码发完了"挡住。
    """
    if not CFG:
        return False, "mail_not_configured"

    msg = EmailMessage()
    msg["From"] = f"{CFG['from_name']} <{CFG['user']}>"
    msg["To"] = to_email
    msg["Subject"] = subject
    msg.set_content(body + "\n\n—— 工商真题库 系统自动发送\n")

    try:
        ctx = ssl.create_default_context()
        if CFG["port"] == 465:
            with smtplib.SMTP_SSL(CFG["host"], CFG["port"], timeout=20, context=ctx) as s:
                s.login(CFG["user"], CFG["pass"])
                s.send_message(msg)
        else:
            with smtplib.SMTP(CFG["host"], CFG["port"], timeout=20) as s:
                s.starttls(context=ctx)
                s.login(CFG["user"], CFG["pass"])
                s.send_message(msg)
        return True, "ok"
    except Exception as e:  # noqa: BLE001
        log.error("通知邮件发送失败 %s：%s", to_email, e)
        return False, f"send_failed:{type(e).__name__}"


# ============================================================
# 验证码存储 + 频率限制
# 内存版，单进程够用；服务重启即失效（验证码本来只活 10 分钟）
# ============================================================
class CodeStore:
    """邮箱验证码：发一次存一条，校验成功即消费。"""

    def __init__(self, ttl_seconds: int = 600, per_email_interval: int = 60,
                 per_email_daily: int = 8, global_daily: int = 300):
        self.ttl = ttl_seconds
        self.per_email_interval = per_email_interval
        self.per_email_daily = per_email_daily
        self.global_daily = global_daily
        self._codes: dict[str, tuple[str, float, int]] = {}   # email -> (code, exp, tries)
        self._lock = threading.Lock()
        self._last_at: dict[str, float] = {}
        self._day: dict[str, tuple[str, int]] = {}
        self._global: tuple[str, int] = ("", 0)

    @staticmethod
    def _today() -> str:
        return time.strftime("%Y-%m-%d")

    def check_quota(self, email: str) -> tuple[bool, str]:
        """发码前检查频率。"""
        email = email.strip().lower()
        now = time.time()
        day = self._today()
        with self._lock:
            last = self._last_at.get(email)
            if last is not None and now - last < self.per_email_interval:
                wait = int(self.per_email_interval - (now - last))
                return False, f"too_frequent:{wait}"
            d, c = self._day.get(email, (day, 0))
            if d != day:
                c = 0
            if c >= self.per_email_daily:
                return False, "email_daily_limit"
            gd, gc = self._global
            if gd != day:
                gc = 0
            if gc >= self.global_daily:
                return False, "global_daily_limit"
        return True, ""

    def commit(self, email: str, code: str) -> None:
        email = email.strip().lower()
        now = time.time()
        day = self._today()
        with self._lock:
            self._codes[email] = (code, now + self.ttl, 0)
            self._last_at[email] = now
            d, c = self._day.get(email, (day, 0))
            self._day[email] = (day, (c + 1) if d == day else 1)
            gd, gc = self._global
            self._global = (day, (gc + 1) if gd == day else 1)
            # 清过期
            dead = [k for k, (_, exp, _) in self._codes.items() if exp < now]
            for k in dead:
                self._codes.pop(k, None)

    def verify(self, email: str, code: str, max_tries: int = 5) -> tuple[bool, str]:
        """校验验证码。**成功才消费**；错误累计，超次数直接废掉这条码。"""
        email = email.strip().lower()
        code = (code or "").strip()
        if not code:
            return False, "missing"
        with self._lock:
            item = self._codes.get(email)
            if item is None:
                return False, "not_sent"
            expect, exp, tries = item
            if exp < time.time():
                self._codes.pop(email, None)
                return False, "expired"
            if tries >= max_tries:
                self._codes.pop(email, None)
                return False, "too_many_tries"
            if not code == expect:
                self._codes[email] = (expect, exp, tries + 1)
                return False, "mismatch"
            self._codes.pop(email, None)   # 一次性
            return True, "ok"

    def peek_ttl(self, email: str) -> int:
        email = email.strip().lower()
        with self._lock:
            item = self._codes.get(email)
            if not item:
                return 0
            return max(0, int(item[1] - time.time()))


CODES = CodeStore()
