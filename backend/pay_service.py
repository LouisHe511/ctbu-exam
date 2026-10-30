#!/usr/bin/env python3
"""工商真题库 · 支付服务

职责（只做这三件事，别把它做大）：
  1. POST /api/pay/create         给学生订单生成支付凭据
                                   微信内 → 微信JSAPI唤起 / 易支付跳转 / 支付宝跳转App
                                   手机   → 易支付跳转 / 支付宝跳转App 或 微信H5
                                   电脑   → 易支付跳转 / 支付宝收银台 或 微信扫码
  2. POST /api/pay/notify/<渠道>  渠道异步通知 → 验签 → 校金额 → 开通会员
       alipay / wechat / epay（易支付协议，GET 与 POST 都接）
  3. GET  /api/pay/wx-openid      微信内网页授权换 openid（AppSecret 不下发到前端）
     POST /api/pay/recheck        主动查单兜底：回调丢了也能给学生开通
     POST /api/pay/sign-media     签发受保护听力音频的短效链接（会员专享）
     GET  /api/pay/cet-explain    取某套四六级全卷的答案解析（会员专享）
     GET  /api/pay/cet-solution-url 签发「原题+答案解析」PDF 的短效链接（会员专享）
     GET  /api/pay/health         健康检查

渠道是可选配置：config.json 里配了哪个就用哪个。
优先级：易支付（若已配）> 支付宝官方 > 微信官方。
配了易支付就用它，因为配了就说明当前阶段就走这条通道。

部署方式：systemd 托管（仅监听 127.0.0.1），由 nginx 反代 /api/pay/*
为什么不放 Supabase Edge Function：平台服务器在国内，访问 *.supabase.co 不稳定，
                              回调丢一次学生就白付钱。放已备案的国内服务器最稳。

依赖：Python 3.12 + cryptography（apt 装 python3-cryptography）+ 标准库
配置：/etc/ctbu-pay/config.json（权限 600，含所有密钥）
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
import secrets
import shutil
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from sms import load_sms, ok as sms_ok, verify_supabase_hook, RateLimiter, explain
import captcha as captcha_mod   # 自建图形验证码（2026-10-21 加）
import mailer                    # 邮箱验证码（2026-10-21 加）
import time
from typing import Any

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

CONFIG_PATH = os.environ.get("CTBU_PAY_CONFIG", "/etc/ctbu-pay/config.json")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("ctbu-pay")

# ---- 本地数据库访问层（2026-10-17 · 阶段 5：登录/数据/支付落库全走它）----
try:
    import db  # noqa: E402  （sys.path 已含本目录；失败不致命，运行时逐处兜底）
except Exception as _db_err:  # noqa: BLE001
    db = None
    log.error("本地数据库访问层加载失败：%s", _db_err)

# ---- AI 学习助手（2026-10-25 加；免费链路：OCR 缓存 + 免费文本模型）----
# ai.py 只在被路由命中时才真正干活；配置没开 ai 段时接口一律 503，是死代码。
import ai  # noqa: E402


# ======================================================================
# 配置
# ======================================================================
def load_config() -> dict[str, Any]:
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        cfg = json.load(f)

    for key in ["listen_host", "listen_port",
                "supabase_url", "supabase_anon_key", "callback_secret"]:
        if key not in cfg:
            raise SystemExit(f"配置文件缺少字段：{key}")

    # 注意：这里**不强制**必须配某个渠道。换平台期间 epay 段凭据为空是正常状态，
    # 让服务照常启动（会员登录、题库、OCR 都不该跟着挂），下单时再明确回"未配置"。
    if not cfg.get("wechat") and not cfg.get("alipay") and not cfg.get("epay"):
        log.warning("三个支付渠道都没配，站点可浏览但无法下单")

    # epay 段：只有在填了凭据时才校验完整性（空段 = 尚未接入新平台，跳过）
    _ep = cfg.get("epay") or {}
    if _ep.get("pid") or _ep.get("key") or _ep.get("gateway"):
        for key in ["pid", "key", "notify_url", "gateway"]:
            if not _ep.get(key):
                raise SystemExit(f"配置 epay 段缺少字段：{key}")

    if cfg.get("alipay"):
        # 与微信同样的原则（2026-10-30 补）：**支付宝配置不完整只禁用该通道**，
        # 不让整站陪葬。签约后填密钥的过程中很容易少填一项，
        # 那种时候应该"支付宝暂时不可用"，而不是站点 502。
        _al_missing = [k for k in ("app_id", "app_private_key_path",
                                   "alipay_public_key_path", "notify_url")
                       if not cfg["alipay"].get(k)]
        if _al_missing:
            logging.getLogger("ctbu-pay").error(
                "支付宝配置不完整，缺：%s —— 该通道已禁用，其他功能正常",
                ", ".join(_al_missing))
            cfg["alipay"] = None

    # ── 微信支付配置校验（2026-10-27 修：不再让整站陪葬）──────────────
    # 事故：本轮填配置时 app_secret 留空，这里 `raise SystemExit` 让进程退出，
    # systemd 无限重启 → **网站整站 502 约 4 分钟**。
    #
    # 正确行为：**配置不完整 = 禁用该通道**，其余功能照常。
    # 微信配错了不该连带题库站打不开 —— 两者是完全独立的业务。
    #
    # 处理方式：把 wechat 段置空，后面 `if CFG.get("wechat")` 判空自然跳过，
    # WECHAT 保持 None，pick_channel 回落到易支付，日志留明确原因。
    if cfg.get("wechat"):
        _wx_required = ["appid", "app_secret", "mchid", "api_v3_key",
                        "merchant_serial", "merchant_key_path",
                        "wxpay_public_key_path", "notify_url"]
        _wx_missing = [k for k in _wx_required if not cfg["wechat"].get(k)]
        if _wx_missing:
            logging.getLogger("ctbu-pay").error(
                "微信支付配置不完整，缺：%s —— 该通道已禁用，其他功能正常",
                ", ".join(_wx_missing))
            cfg["wechat"] = None
    return cfg


CFG = load_config()

# ---- 短信（阿里云「短信认证」）----
SMS = load_sms()
SMS_LIMITER = RateLimiter(per_phone_interval=60, per_phone_daily=10, global_daily=500)
if SMS:
    log.info("短信通道已启用：签名=%s 模板=%s", SMS.sign_name, SMS.template_code)

# ---- 人机验证 / 邮箱验证码（2026-10-21）----
# 人机验证**强制开启**：注册、登录、找回密码三个入口都要过图形码。
# 想临时关掉（本地调试）设环境变量 CTBU_CAPTCHA=off。
CAPTCHA_ON = (os.environ.get("CTBU_CAPTCHA", "on").strip().lower() not in ("off", "0", "false"))
MAIL_ON = mailer.available()
if not MAIL_ON:
    log.warning("邮箱验证码不可用：注册将退回「不发码」模式（仅靠图形码 + 限流）")
else:
    log.info("邮箱验证码已启用")

class WindowLimiter:
    """滑动窗口内"最多失败 N 次"，用于挡撞库 / 挡敏感接口被反复试。

    和 sms.RateLimiter 的分工：
      · 那个按「天配额 + 同号间隔」算，管的是**发码成本**；
      · 这个按「最近 N 分钟失败几次」算，管的是**猜密码** —— 要短窗口，不是日配额。

    只存内存：进程重启即清零。本站单进程、规模小，重启本身就意味着
    "这轮攻击的计数没必要背着"。所有方法都有锁，因为 HTTP 是多线程的。

    用法：
        ok, wait = LOGIN_FAIL.blocked(key)   # 先问能不能试
        ...
        LOGIN_FAIL.fail(key)                 # 失败了记一笔
        LOGIN_FAIL.reset(key)                # 成功了清零
    """

    def __init__(self, max_fails: int, window_seconds: int, sweep_at: int = 20000):
        self.max_fails = max_fails
        self.window = window_seconds
        self.sweep_at = sweep_at
        self._hits: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def _live(self, key: str, now: float) -> list[float]:
        ts = [t for t in self._hits.get(key, []) if now - t < self.window]
        if ts:
            self._hits[key] = ts
        else:
            self._hits.pop(key, None)
        return ts

    def blocked(self, key: str) -> tuple[bool, int]:
        now = time.time()
        with self._lock:
            ts = self._live(key, now)
            if len(ts) < self.max_fails:
                return False, 0
            # 最早那次失败滚出窗口时，就又能试一次
            wait = int(self.window - (now - ts[0])) + 1
            return True, max(wait, 1)

    def fail(self, key: str) -> None:
        now = time.time()
        with self._lock:
            ts = self._live(key, now)
            ts.append(now)
            self._hits[key] = ts
            # 定期清理，别让 key 无限增长（每个攻击 IP 一个 key）
            if len(self._hits) > self.sweep_at:
                for k in [k for k in self._hits if not self._live(k, now)]:
                    self._hits.pop(k, None)

    def reset(self, key: str) -> None:
        with self._lock:
            self._hits.pop(key, None)


# 登录/注册失败计数（2026-10-28 真正接上）。
#   同一「账号 5 次 / 15 分钟」→ 拦住针对某个邮箱的撞库；
#   同一「IP 20 次 / 15 分钟」→ 拦住"拿字典扫不同账号"。
# 之前这里只有一个从未被引用的 _LOGIN_FAIL，等于没有；图形码是唯一门槛，
# 而 4 位图形码挡不住脚本（一次解图后续用同一个 id 反复试）。
LOGIN_FAIL_BY_IDENT = WindowLimiter(max_fails=5, window_seconds=15 * 60)
LOGIN_FAIL_BY_IP = WindowLimiter(max_fails=20, window_seconds=15 * 60)
# 改密 / 重置这类"能直接拿走账号"的接口单独算，阈值更紧
SENSITIVE_FAIL_BY_IP = WindowLimiter(max_fails=10, window_seconds=30 * 60)
# 下单 / 查单：防止把上游支付平台当靶子打（一次 recheck 会打 3 次上游）
PAY_ACTION_BY_UID = WindowLimiter(max_fails=20, window_seconds=60)
RECHECK_BY_UID = WindowLimiter(max_fails=6, window_seconds=60)

# 短信验证码存储（2026-10-21）：与邮箱那套同构，**自己生成、自己校验**。
# 为什么不交给阿里云 CheckSmsVerifyCode：官方文档说明传了自定义 Code 后该接口不再支持校验；
# 而我们要的就是「自己决定验证码」，所以本地存、本地比，可控性更好。
SMS_CODES = mailer.CodeStore(ttl_seconds=300, per_email_interval=60,
                             per_email_daily=10, global_daily=200)
# ↑ 复用同一个类：key 只是字符串，手机号同样适用。

ALIPAY = None
WECHAT = None
EPAY = None
try:
    if CFG.get("alipay"):
        from alipay import Alipay, AlipayError  # noqa: E402
        ALIPAY = Alipay(CFG["alipay"])
except ModuleNotFoundError:  # 只配微信时允许缺 alipay 模块
    pass

# ── 微信官方支付（2026-10-23 补齐初始化与诊断）──────────────────────────
# 原来这里是静默 `pass`：配错字段、证书路径写错，服务照常启动，
# 只有学生点「微信支付」时才炸。现在把每种失败都打成明确日志。
try:
    _wx_cfg = CFG.get("wechat") or {}
    _wx_need = ("appid", "mchid", "api_v3_key", "merchant_serial",
                "merchant_key_path", "notify_url")
    _wx_missing = [k for k in _wx_need if not _wx_cfg.get(k)]
    if _wx_missing:
        if any(_wx_cfg.get(k) for k in _wx_need):
            # 配了一半 → 这是错的，必须大声说
            log.error("微信支付配置不完整，缺：%s —— 微信通道将不可用", ", ".join(_wx_missing))
        else:
            log.info("微信官方支付未配置（正常，当前走易支付）")
    else:
        from wechatpay import WeChatPay, WeChatPayError  # noqa: E402
        WECHAT = WeChatPay(_wx_cfg)
        log.info("微信官方支付已启用：mchid=%s appid=%s", WECHAT.mchid, WECHAT.appid)
except ModuleNotFoundError as exc:
    log.warning("微信支付模块缺失：%s", exc)
except Exception as exc:  # noqa: BLE001
    # 证书读不了 / api_v3_key 不是 32 位 —— 都要立刻看见
    log.error("微信支付初始化失败（通道不可用）：%s", exc)

# 易支付（XArrPay / 云熠）**已下线为新单渠道**（2026-10-30 用户明确：以后只用微信和
# 支付宝官方通道）。
#
# 但对象**照旧构造**，因为两件事还必须靠它：
#   ① 历史未完成订单的异步回调（/api/pay/notify/epay）；
#   ② 对账脚本 reconcile-orders.py 的主动查单。
# 这两件事都是"处理已经发出去的订单"，跟"要不要再给学生这个选项"是两回事。
#
# 是否作为**可选支付方式**由 `epay.enabled` 控制（默认 false）。
# 想彻底连回调也不要了，就把 config 里的 epay 段整段删掉。
EPAY_ACTIVE = False
try:
    # 只有真正填了凭据才构造。换平台期间 epay 段是空壳（pid/key/gateway 都是 ""），
    # 此时**跳过**，否则构造函数会抛「配置缺少 pid」把整个服务带崩
    # —— 2026-10-21 就这么崩过一次，站点 502 了几十秒。
    _ep_cfg = CFG.get("epay") or {}
    EPAY_ACTIVE = bool(_ep_cfg.get("enabled", False))
    if _ep_cfg.get("pid") and _ep_cfg.get("key") and _ep_cfg.get("gateway"):
        from epay import Epay, EpayError  # noqa: E402
        EPAY = Epay(_ep_cfg)
        if EPAY_ACTIVE:
            log.info("易支付通道已启用（作为新单渠道）：%s", EPAY.gateway)
        else:
            log.info("易支付仅保留历史订单回调/查单，不再作为新单渠道")
    else:
        log.warning("易支付通道未配置（等新平台的 pid/key/域名）——站点可浏览，暂不能下单")
except ModuleNotFoundError:
    log.warning("epay 模块缺失")
except Exception as e:  # noqa: BLE001
    log.error("易支付通道初始化失败：%s", e)



# 各渠道允许的回调金额偏差：(绝对下限分, 比例ppm)。官方通道必须精确相等；
# 第三方聚合通道的手续费是在收款过程里扣掉的，回调实收可能少于订单金额，
# 所以在它的配置段里给一个**很小**的容差（默认 10 分 + 2%）。
# 两者都为 0 时不会往数据库传参数 —— 所以数据库没升级也能正常跑（此时等于精确相等）。
CHANNEL_TOLERANCE: dict[str, tuple[int, int]] = {}
if EPAY is not None:
    CHANNEL_TOLERANCE["epay"] = (EPAY.tolerance_cents, EPAY.tolerance_ppm)

# 前端诊断上报只接受这些字段（2026-10-28）。以前整包进日志，
# 于是 openid、location.href、state 都成了日志内容 —— 能识别到人，也没必要留。
_DIAG_ALLOWED_KEYS = {
    "event", "step", "method", "reason", "err", "error", "ua", "scene",
    "inWechat", "hasOpenid", "stateOpenid", "freshOpenid", "orderNo",
    "tier", "channel", "hasCode", "gotIt", "back", "currentHash",
    "openid_from_server", "count", "elapsed", "ok",
}


# ======================================================================
# 本地登录与会话（2026-10-17 · 阶段 5：脱离 Supabase Auth，自建）
# ======================================================================
# 设计：
#   · 密码：pbkdf2_sha256（标准库），60 万轮；库里只存 "算法$轮数$盐$摘要"
#     —— 2026-10-28 由 12 万提到 60 万（OWASP 2023 对 PBKDF2-HMAC-SHA256 的建议值）。
#        旧 hash 里的轮数是**存在字符串里**的，所以老密码照样能验；
#        登录成功时顺手按新参数重算一遍（见 auth_signin 末尾），无需强制所有人改密。
#   · 会话：随机 token（前端 localStorage，走 Bearer）；库里只存 sha256(token)
#   · 30 天滚动有效，但**绝对上限 90 天**（从 created_at 起算，续期不得越过）
# 表结构见 `_搬迁-2026-10-17/05-本地登录.sql`。
SESSION_DAYS = 30
SESSION_ABSOLUTE_DAYS = 90
_PBKDF2_ROUNDS = 600_000
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_UUID_RE = re.compile(r"^[0-9a-fA-F-]{36}$")


def _mask_email(email: str) -> str:
    """日志里不写完整邮箱（2026-10-28）。手机号早就掩码了，邮箱之前是明文。"""
    e = (email or "").strip()
    if "@" not in e:
        return e[:2] + "***" if e else ""
    name, domain = e.split("@", 1)
    return (name[:2] + "***@" + domain) if name else "***@" + domain


def _bearer(headers: dict[str, str]) -> str:
    tok = headers.get("authorization") or ""
    return tok[7:].strip() if tok.lower().startswith("bearer ") else ""


def _hash_pw(password: str) -> str:
    salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"),
                             bytes.fromhex(salt), _PBKDF2_ROUNDS)
    return f"pbkdf2_sha256${_PBKDF2_ROUNDS}${salt}${dk.hex()}"


def _check_pw(password: str, stored: str | None) -> bool:
    if not stored:
        return False
    try:
        algo, rounds, salt, digest = stored.split("$", 3)
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"),
                                 bytes.fromhex(salt), int(rounds))
        return secrets.compare_digest(dk.hex(), digest)
    except Exception:  # noqa: BLE001
        return False


def verify_user(access_token: str) -> str | None:
    """用本地会话 token 换 user_id（登录已自建，不再经 Supabase）。

    滑动续期 + 绝对上限（2026-10-28 改）：
      · 剩余不足 20 天 → 续到 30 天，但**不得超过 created_at + 90 天**
        （原来只滑动、无上限，被盗 token 只要保持活跃就永久有效）
      · last_seen_at 每 5 分钟才写一次（原来每个 API 请求都写一行，
        12 个连接的池子被这种写放大吃掉，是历史 pool exhausted 的诱因之一）
    """
    if not access_token or db is None:
        return None
    try:
        h = hashlib.sha256(access_token.encode("utf-8")).hexdigest()
        rows = db.execute(
            "select user_id from auth.sessions "
            "where token_hash = %s and expires_at > now()", [h])
        if not rows:
            return None
        db.execute(
            "update auth.sessions set"
            "  last_seen_at = now(),"
            "  expires_at = least(now() + interval '30 days',"
            "                     created_at + make_interval(days => %s))"
            " where token_hash = %s"
            "   and expires_at < now() + interval '20 days'", [SESSION_ABSOLUTE_DAYS, h])
        db.execute(
            "update auth.sessions set last_seen_at = now() "
            " where token_hash = %s and last_seen_at < now() - interval '5 minutes'", [h])
        return str(rows[0]["user_id"])
    except Exception as e:  # noqa: BLE001
        log.warning("会话校验失败：%s", e)
        return None


# ======================================================================
# 登录设备限制（2026-10-17）
#
# 目标：同一账号最多 MAX_DEVICES 台设备同时在线，防止把账号借给同学。
#
# 为什么不按 IP 限制：校园网/宿舍 WiFi 都是 NAT，几十人共用一个出口 IP，
# 按 IP 限 2 会误伤同宿舍的人；而借号者若在同一 WiFi，IP 完全一样，根本查不出。
# 所以主键是 **device_id**（浏览器 localStorage 里的 UUID），IP 只做异常画像。
#
# 旧会话（迁移前建的）device_id 为空 → 不计入名额，按 30 天自然过期。
# ======================================================================

MAX_DEVICES = 2
DEVICE_ACTIVE_DAYS = 30


def device_limit_of(uid: str) -> int | None:
    """该账号允许同时在线的设备数；返回 None 表示**不限**。

    规则写在 `public.profiles.max_devices`（2026-10-28 加列）：
        NULL  → 用全局 MAX_DEVICES（默认 2 台）
        0     → 不限设备（个别账号按用户要求开的口子）
        > 0   → 用这个数字

    为什么放进数据库而不是写死一个名单：
      开白名单是运营动作，不该为了"某个人换手机"去改代码、重启服务；
      而且写死在代码里的人名/邮箱，下次谁都不知道当初为什么加。

    任何异常（列还没加、库连不上）一律退回默认值 —— 设备限制是防护，
    不能因为读不到一个可选字段就把所有人挡在门外。
    """
    if db is None:
        return MAX_DEVICES
    try:
        rows = db.execute("select max_devices from public.profiles where id = %s", [uid])
        if not rows:
            return MAX_DEVICES
        v = rows[0].get("max_devices")
        if v is None:
            return MAX_DEVICES
        v = int(v)
        return None if v <= 0 else v
    except Exception as e:  # noqa: BLE001
        log.warning("读取设备名额失败（按默认 %s 台处理）：%s", MAX_DEVICES, e)
        return MAX_DEVICES


def _client_ip(headers: dict[str, str]) -> str | None:
    """取真实客户端 IP（nginx 已设 X-Real-IP / X-Forwarded-For）。"""
    ip = (headers.get("x-real-ip") or "").strip()
    if not ip:
        xff = headers.get("x-forwarded-for") or ""
        ip = xff.split(",")[0].strip()
    return ip or None


def log_security(uid: str | None, kind: str, detail: dict) -> None:
    """写一条安全事件（超限尝试 / 异地登录 / 踢设备）。失败不影响主流程。"""
    if db is None:
        return
    try:
        db.execute(
            "insert into public.security_logs (user_id, kind, detail) values (%s, %s, %s)",
            [uid, kind, json.dumps(detail, ensure_ascii=False)])
    except Exception as e:  # noqa: BLE001
        log.warning("安全日志写入失败：%s", e)


def list_devices(uid: str) -> list[dict]:
    """该用户当前有效的登录设备（按 device_id 归并，一台设备一行）。"""
    if db is None:
        return []
    rows = db.execute(
        "select device_id,"
        "       max(coalesce(device_name, ''))  as device_name,"
        "       max(coalesce(ip, ''))           as ip,"
        "       max(coalesce(last_ip, ''))      as last_ip,"
        "       max(last_seen_at)               as last_seen_at,"
        "       min(created_at)                 as first_seen_at,"
        "       count(*)                        as sessions"
        "  from auth.sessions"
        " where user_id = %s and device_id is not null and expires_at > now()"
        " group by device_id"
        " order by max(last_seen_at) desc", [uid])
    return _jsonable(rows)


def create_session(uid: str, *, headers: dict[str, str] | None = None,
                   device_id: str | None = None,
                   device_name: str | None = None,
                   enforce_limit: bool = True) -> tuple[str | None, str | None]:
    """建会话，返回 (token, error)。

    error = 'device_limit' 表示已达设备上限（调用方应返回 409 并附设备列表）。

    设备名额的算法：
      1. 客户端没带 device_id 时**由服务端生成一个**（2026-10-28）
         —— 原来 `if device_id and enforce_limit` 意味着"不带就不检查"，
            借号者清一下 localStorage 就绕过了整个限制。
      2. 先把「这台设备」的旧会话删掉 —— 同设备重登只换 token，不占第二个名额
      3. 再数还剩几台设备（近 30 天有活动、未过期）
      4. 已达该账号的名额上限 → 拒绝（名额来自 device_limit_of，None = 不限）
    """
    headers = headers or {}
    device_id = (device_id or "").strip()[:64] or None
    device_name = (device_name or "").strip()[:80] or None
    ip = _client_ip(headers)
    ua = (headers.get("user-agent") or "")[:300]

    if not device_id:
        # 老前端 / 被清过 localStorage 的浏览器：服务端兜一个稳定的名字。
        # 用 IP+UA 派生（不含随机数），这样同一台设备重登仍算"同一台"，
        # 不会因为客户端不配合就把名额刷爆。
        seed = f"{ip or ''}|{ua}|{uid}"
        device_id = "srv-" + hashlib.sha256(seed.encode("utf-8")).hexdigest()[:24]
        device_name = device_name or "未识别设备"

    if device_id and enforce_limit:
        db.execute(
            "delete from auth.sessions where user_id = %s and device_id = %s",
            [uid, device_id])
        limit = device_limit_of(uid)
        if limit is not None:
            rows = db.execute(
                "select count(distinct device_id) as n from auth.sessions"
                " where user_id = %s and device_id is not null and expires_at > now()"
                "   and last_seen_at > now() - make_interval(days => %s)",
                [uid, DEVICE_ACTIVE_DAYS])
            used = int(rows[0]["n"]) if rows else 0
            if used >= limit:
                log_security(uid, "device_limit", {
                    "ip": ip, "ua": ua, "device_id": device_id,
                    "device_name": device_name, "used": used, "limit": limit,
                })
                return None, "device_limit"

    tok = secrets.token_urlsafe(32)
    h = hashlib.sha256(tok.encode("utf-8")).hexdigest()
    db.execute(
        "insert into auth.sessions"
        " (token_hash, user_id, expires_at, device_id, device_name, ip, ua, last_ip)"
        " values (%s, %s, now() + interval '30 days', %s, %s, %s, %s, %s)",
        [h, uid, device_id, device_name, ip, ua, ip])
    return tok, None


def kill_session(access_token: str) -> None:
    if not access_token or db is None:
        return
    h = hashlib.sha256(access_token.encode("utf-8")).hexdigest()
    db.execute("delete from auth.sessions where token_hash = %s", [h])


def _jsonable(v):
    """数据库行里的 uuid / datetime 递归转成可 JSON 化的值。"""
    if isinstance(v, dict):
        return {k: _jsonable(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    if isinstance(v, uuid.UUID):
        return str(v)
    if hasattr(v, "isoformat"):
        return v.isoformat()
    return v


def _fetch_profile(uid: str) -> dict | None:
    if db is None:
        return None
    rows = db.execute("select * from public.profiles where id = %s", [uid])
    return _jsonable(dict(rows[0])) if rows else None


def _user_payload(uid: str, with_token: str | None = None) -> dict:
    rows = db.execute(
        "select id, email, phone, raw_user_meta_data from auth.users where id = %s", [uid])
    if not rows:
        return {"ok": False, "reason": "user_missing"}
    # 有没有"用户自己知道的密码"（2026-10-21）
    # ⚠️ 不能看 password_hash 是否为 NULL —— 手机号注册的账号也有一个**随机生成**的
    #    password_hash（服务端不许空密码）。所以用 raw_user_meta_data 里的标记来认：
    #    邮箱注册 / 自己在个人中心设过 / 短信自助重置过 → true。
    meta = rows[0].get("raw_user_meta_data") or {}
    if isinstance(meta, str):
        try:
            meta = json.loads(meta)
        except Exception:  # noqa: BLE001
            meta = {}
    payload = {
        "ok": True,
        # phone 必须下发：手机号登录的账号 email 为 NULL，
        # 个人页拿不到 phone 就显示"未绑定邮箱"，用户会以为自己没登录成功（2026-10-21 实测发现）。
        "user": {"id": str(rows[0]["id"]),
                 "email": rows[0]["email"],
                 "phone": rows[0]["phone"],
                 "password_set": bool(meta.get("password_set"))},
        "profile": _fetch_profile(uid),
        "is_admin": bool(db.rpc("is_admin", {}, uid=uid)),
    }
    if with_token:
        payload["token"] = with_token
    return payload


# ======================================================================
# 登录 / 数据 接口实现（2026-10-17 · 阶段 5）
# 前端从 supabase-js 直连切换为调用本服务：
#   /api/auth/*  登录、注册、会话、改密、重置
#   /api/data/*  试卷列表、个人资料、收藏、浏览记录、订单、管理员接口、RPC 转发
# 授权判断全部在这里（服务端），前端只负责展示 —— 这是红线。
# ======================================================================


def _verify_captcha_required(body: dict[str, Any], keep: bool = False) -> tuple[bool, str]:
    """校验人机验证（图形码）。返回 (通过, 失败原因)。

    前端字段：captcha_id（图片 id）+ captcha_code（用户输入）。
    **必须由服务端校验** —— 只在前端判断等于没做（谁都能直接构造请求）。

    keep=True 只用于「发送邮箱验证码」：注册流程要点两次图形码会让人烦，
    所以发码时校验通过<b>保留</b>该码，提交注册时再消费掉。
    """
    if not CAPTCHA_ON:
        return True, "off"
    cid = str(body.get("captcha_id") or "")
    res = captcha_mod.verify(cid, str(body.get("captcha_code") or ""), keep=keep)
    # 只在失败时记一行：正常通过不刷日志，出问题能立刻看出是"id 不认识(expired)"
    # 还是"答案不对(mismatch)"——两者处理方式完全不同（前者换图，后者原地改）。
    if not res[0]:
        log.info("captcha 拒绝 id=%r → %s（pending=%d）",
                 cid[:12], res[1], captcha_mod.STORE.stats()["pending"])
    return res


# 一张图形码只允许触发**一次**发码（2026-10-28）。
#
# 发码接口用的是 keep=True（答对不消费），本意是"注册时别让用户点两次图"。
# 但这也意味着：解一次图之后，同一个 captcha_id 可以无限次调发码接口，
# 直到把当天全局额度（邮件 300 / 短信 200）打空 —— 正常用户当天就收不到码了。
# 这里记住"这张图已经用来发过码"，第二次直接要求换图；
# 而真正提交注册/重置时用的是 keep=False，那条路仍能用同一个 id 走完。
_CAPTCHA_SEND_USED: dict[str, float] = {}
_CAPTCHA_SEND_LOCK = threading.Lock()
_CAPTCHA_SEND_TTL = 30 * 60


def _captcha_send_once(body: dict[str, Any]) -> tuple[bool, str]:
    cid = str(body.get("captcha_id") or "").strip()
    if not cid:
        return True, ""          # 没开图形码时本函数不参与判断
    now = time.time()
    with _CAPTCHA_SEND_LOCK:
        for k in [k for k, t in _CAPTCHA_SEND_USED.items() if now - t > _CAPTCHA_SEND_TTL]:
            _CAPTCHA_SEND_USED.pop(k, None)
        if cid in _CAPTCHA_SEND_USED:
            return False, "captcha_reused"
        _CAPTCHA_SEND_USED[cid] = now
    return True, ""


def _captcha_reject(why: str) -> tuple[int, dict]:
    # 2026-10-27 用户要求：前端标签已从「人机验证」改为「图形验证」，
    # 面向用户的提示文案必须跟着统一 —— 两套叫法并存会让人以为
    # "人机验证"和"图形验证"是两个不同的东西，不知道该填哪个。
    msg = {
        "expired": "图形验证已过期，请点击图片刷新后重新输入",
        "mismatch": "图形验证码不正确，请重新输入（可再试，最多 3 次）",
        "too_many_tries": "这张验证码错太多次了，已作废，请点图片换一张",
        "missing": "请先填写图形验证码",
    }.get(why, "图形验证未通过，请重新输入")
    return 400, {"ok": False, "reason": "captcha_" + (why or "invalid"), "message": msg}


def auth_signup(raw: str, headers: dict[str, str]) -> tuple[int, dict]:
    if db is None:
        return 503, {"ok": False, "reason": "db_unavailable"}
    try:
        body = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        return 400, {"ok": False, "reason": "bad_json"}
    email = str(body.get("email") or "").strip().lower()
    password = str(body.get("password") or "")
    invite = str(body.get("invite_code") or "").strip().upper()

    # ① 人机验证（第一道闸：挡无脑脚本）
    passed, why = _verify_captcha_required(body)
    if not passed:
        return _captcha_reject(why)

    # ② 邮箱验证码（第二道闸：挡批量注册；没配 SMTP 时跳过，不阻塞上线）
    if MAIL_ON:
        code_ok, code_why = mailer.CODES.verify(
            email, str(body.get("email_code") or ""))
        if not code_ok:
            m = {
                "not_sent": "请先点击「发送验证码」获取邮箱验证码",
                "expired": "验证码已过期，请重新获取",
                "mismatch": "验证码不正确",
                "too_many_tries": "验证码错误次数过多，请重新获取",
                "missing": "请填写邮箱验证码",
            }.get(code_why, "验证码校验失败")
            return 400, {"ok": False, "reason": "email_code_" + code_why, "message": m}

    if not _EMAIL_RE.match(email):
        return 400, {"ok": False, "reason": "bad_email", "message": "邮箱格式不正确"}
    if len(password) < 6 or len(password) > 72:
        return 400, {"ok": False, "reason": "weak_password", "message": "密码至少 6 位"}
    meta = {"invite_code": invite} if invite else {}
    meta["password_set"] = True   # 邮箱注册一定有用户自己设的密码
    try:
        rows = db.execute(
            "insert into auth.users (email, password_hash, raw_user_meta_data) "
            "values (%s, %s, %s) returning id",
            [email, _hash_pw(password), json.dumps(meta, ensure_ascii=False)])
    except Exception as e:  # noqa: BLE001
        if "users_email_key" in str(e) or "duplicate key" in str(e):
            return 409, {"ok": False, "reason": "email_taken",
                         "message": "这个邮箱已经注册过了，直接登录即可"}
        log.exception("注册失败：%s", e)
        return 500, {"ok": False, "reason": "internal_error"}
    uid = str(rows[0]["id"])
    # 温馨提示：触发器 handle_new_user 已自动建好 profile（含邀请码/名额逻辑）
    # 注册即第一台设备，不做名额检查（新号不可能超限）
    token, _ = create_session(
        uid, headers=headers,
        device_id=body.get("device_id"), device_name=body.get("device_name"),
        enforce_limit=False)
    # 注册即第一台设备（上面的备注已说明）；注册返回也带上 device_count，前端统一处理
    payload = _user_payload(uid, with_token=token)
    payload["device_count"] = 1
    payload["max_devices"] = device_limit_of(uid) or 0
    payload["banned"] = False
    payload["violations"] = 0
    return 200, payload


def auth_signin(raw: str, headers: dict[str, str]) -> tuple[int, dict]:
    if db is None:
        return 503, {"ok": False, "reason": "db_unavailable"}
    try:
        body = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        return 400, {"ok": False, "reason": "bad_json"}
    # 账号既可以是邮箱，也可以是手机号（2026-10-21）。
    # 背景：手机号注册的账号 email 为 NULL，只按邮箱查就永远登不进去 ——
    # 手机号用户被锁死在"只能收验证码"这一条路上。
    ident = str(body.get("account") or body.get("phone") or body.get("email") or "").strip()
    password = str(body.get("password") or "")

    # ---- 撞库限流（2026-10-28）----
    # 放在图形码**之前**：被限流时不该顺手把用户刚填对的验证码消费掉，
    # 否则他等 15 分钟回来，第一次尝试又因为"验证码已失效"失败。
    ip = _client_ip(headers) or "-"
    keys = (f"id:{ident.lower()}", f"ip:{ip}")
    for key, limiter in ((keys[0], LOGIN_FAIL_BY_IDENT), (keys[1], LOGIN_FAIL_BY_IP)):
        blocked, wait = limiter.blocked(key)
        if blocked:
            log_security(None, "login_throttled", {"ident": ident[:64], "ip": ip, "wait": wait})
            return 429, {
                "ok": False, "reason": "too_many_attempts",
                "message": f"尝试次数过多，请 {max(1, wait // 60)} 分钟后再试，或直接点「忘记密码」重置。",
                "retry_after": wait,
            }

    # 人机验证：登录也要过（防撞库）。这是**服务端**校验，前端绕不过去。
    passed, why = _verify_captcha_required(body)
    if not passed:
        return _captcha_reject(why)

    if not ident or not password:
        return 400, {"ok": False, "reason": "missing_fields", "message": "请填写账号和密码"}

    # 图形码挡不住"解一次图、反复试同一个 id"的脚本（老版本 keep=True 时期更严重），
    # 所以这里再按「账号 5 次 / 15 分钟」「IP 20 次 / 15 分钟」双线拦。
    phone_ident = _norm_phone(ident)
    if _PHONE_RE.match(phone_ident):
        rows = db.execute(
            "select id, password_hash, raw_user_meta_data from auth.users where phone = %s",
            [phone_ident])
    else:
        rows = db.execute(
            "select id, password_hash, raw_user_meta_data from auth.users where lower(email) = %s",
            [ident.lower()])

    # 账号不存在时也跑一次 PBKDF2（对固定的假 hash），否则"不存在"会比"密码错"
    # 快几十毫秒，可以稳定枚举出哪些邮箱注册过。2026-10-28
    _DUMMY_HASH = ("pbkdf2_sha256$600000$" + "00" * 16 + "$" + "00" * 32)
    stored = rows[0]["password_hash"] if rows else _DUMMY_HASH
    pw_ok = _check_pw(password, stored)
    if not rows or not pw_ok:
        for key, limiter in ((keys[0], LOGIN_FAIL_BY_IDENT), (keys[1], LOGIN_FAIL_BY_IP)):
            limiter.fail(key)
        log_security(None, "login_failed", {"ident": ident[:64], "ip": ip})
        return 401, {"ok": False, "reason": "bad_credentials", "message": "账号或密码不正确"}
    uid = str(rows[0]["id"])
    for key, limiter in ((keys[0], LOGIN_FAIL_BY_IDENT), (keys[1], LOGIN_FAIL_BY_IP)):
        limiter.reset(key)

    # 顺带把旧参数（12 万轮）的 hash 升级到 60 万轮：用户无感，库里的强度跟上。
    try:
        if stored and int(stored.split("$")[1]) < _PBKDF2_ROUNDS:
            db.execute("update auth.users set password_hash = %s where id = %s",
                       [_hash_pw(password), uid])
    except Exception as e:  # noqa: BLE001
        log.warning("密码 hash 升级失败（不影响登录）：%s", e)

    # 封禁期内允许登录（能看到订单与申诉），但内容会被 ban-status / paper-pages 拦住。
    # 这里只在返回里带一个提示，不阻断登录。

    # 管理员豁免设备名额（自己调试/演示常要切多台机器）
    is_admin = bool(db.rpc("is_admin", {}, uid=uid))
    token, err = create_session(
        uid, headers=headers,
        device_id=body.get("device_id"), device_name=body.get("device_name"),
        enforce_limit=not is_admin)
    if err == "device_limit":
        devices = list_devices(uid)
        limit = device_limit_of(uid) or MAX_DEVICES
        # 说明：设备数量上限（2 台）仍然保留；**取消的只是"同时查看"判定与处罚**。
        return 409, {
            "ok": False,
            "reason": "device_limit",
            "message": (
                f"这个账号已在 {limit} 台设备登录，本次登录已被阻止。\n\n"
                "如果这些设备都是你自己的，请在旧设备上进入「个人中心 → 我的设备」退出其中一台，再回来登录。"
            ),
            "max_devices": limit,
            "devices": devices,
        }
    # 2026-10-20：登录成功时告诉前端"这是第几台设备"，第 2 台起弹「不可同时查看」提醒
    payload = _user_payload(uid, with_token=token)
    try:
        n = db.execute(
            "select count(distinct device_id)::int as n from auth.sessions "
            "where user_id = %s and device_id is not null and expires_at > now()", [uid])
        payload["device_count"] = int(n[0]["n"]) if n else 1
    except Exception:
        payload["device_count"] = 1
    # max_devices 传**该账号实际的**名额；0 = 不限（前端据此不弹「第 2 台设备」提醒）
    payload["max_devices"] = device_limit_of(uid) or 0
    # 2026-10-20 取消封禁体系：这两个字段保留（前端可能还在读），恒为未封禁
    payload["banned"] = False
    payload["violations"] = 0
    return 200, payload


def auth_session(headers: dict[str, str]) -> tuple[int, dict]:
    if db is None:
        return 503, {"ok": False, "reason": "db_unavailable"}
    uid = verify_user(_bearer(headers))
    if not uid:
        return 401, {"ok": False, "reason": "not_logged_in"}
    return 200, _user_payload(uid)


def auth_signout(headers: dict[str, str]) -> tuple[int, dict]:
    kill_session(_bearer(headers))
    return 200, {"ok": True}


def auth_devices(headers: dict[str, str]) -> tuple[int, dict]:
    """我的登录设备列表（「个人中心 → 我的设备」用）。"""
    if db is None:
        return 503, {"ok": False, "reason": "db_unavailable"}
    tok = _bearer(headers)
    uid = verify_user(tok)
    if not uid:
        return 401, {"ok": False, "reason": "not_logged_in"}
    devices = list_devices(uid)
    # 标出「当前这台设备」，前端好显示「本机」
    h = hashlib.sha256(tok.encode("utf-8")).hexdigest()
    rows = db.execute("select device_id from auth.sessions where token_hash = %s", [h])
    current = rows[0]["device_id"] if rows else None
    for d in devices:
        d["current"] = bool(current and d.get("device_id") == current)
    return 200, {
        "ok": True,
        "max_devices": device_limit_of(uid) or 0,
        "devices": devices,
        "current_device_id": current,
    }


def auth_revoke_device(raw: str, headers: dict[str, str]) -> tuple[int, dict]:
    """退出一台设备（只能踢自己的；踢完名额立刻释放）。"""
    if db is None:
        return 503, {"ok": False, "reason": "db_unavailable"}
    uid = verify_user(_bearer(headers))
    if not uid:
        return 401, {"ok": False, "reason": "not_logged_in"}
    try:
        body = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        return 400, {"ok": False, "reason": "bad_json"}
    device_id = str(body.get("device_id") or "").strip()[:64]
    if not device_id:
        return 400, {"ok": False, "reason": "missing_device_id"}
    rows = db.execute(
        "delete from auth.sessions where user_id = %s and device_id = %s "
        "returning token_hash", [uid, device_id])
    if not rows:
        return 404, {"ok": False, "reason": "device_not_found"}
    log_security(uid, "device_revoke", {
        "device_id": device_id, "sessions": len(rows), "ip": _client_ip(headers)})
    return 200, {"ok": True, "revoked": len(rows)}


def auth_password(raw: str, headers: dict[str, str]) -> tuple[int, dict]:
    if db is None:
        return 503, {"ok": False, "reason": "db_unavailable"}
    tok = _bearer(headers)
    uid = verify_user(tok)
    if not uid:
        return 401, {"ok": False, "reason": "not_logged_in"}
    try:
        body = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        return 400, {"ok": False, "reason": "bad_json"}
    new = str(body.get("new_password") or "")
    current = str(body.get("current_password") or "")
    if len(new) < 8 or len(new) > 72:
        return 400, {"ok": False, "reason": "weak_password",
                     "message": "密码至少 8 位（建议字母 + 数字）"}
    if new.strip() == current.strip():
        return 400, {"ok": False, "reason": "same_password", "message": "新密码不能和原密码一样"}

    rows = db.execute(
        "select password_hash, raw_user_meta_data from auth.users where id = %s", [uid])
    if not rows:
        return 404, {"ok": False, "reason": "user_not_found"}
    stored = rows[0].get("password_hash")
    meta = rows[0].get("raw_user_meta_data") or {}
    has_pw = bool(stored) and (meta.get("password_set") is not False)

    # 2026-10-28：已经设过密码的账号，改密**必须**验旧密码。
    # 原来只凭 Bearer token 就能改密并把其他设备踢下线 —— token 存在 localStorage，
    # 一次 XSS 或一台没退出的公用电脑就等于永久接管账号。
    # 手机号注册、还没设过密码的账号（password_set=false）走"首次设置"，不要求旧密码。
    if has_pw:
        if not current:
            return 400, {"ok": False, "reason": "need_current_password",
                         "message": "请先输入当前密码"}
        if not _check_pw(current, stored):
            SENSITIVE_FAIL_BY_IP.fail(_client_ip(headers) or "-")
            return 403, {"ok": False, "reason": "wrong_current_password",
                         "message": "当前密码不正确"}
        SENSITIVE_FAIL_BY_IP.reset(_client_ip(headers) or "-")

    # 设密码 = 以后可以用「手机号/邮箱 + 密码」登录，所以打上 password_set 标记
    db.execute(
        "update auth.users set password_hash = %s, "
        "raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) "
        "|| '{\"password_set\": true}'::jsonb where id = %s",
        [_hash_pw(new), uid])
    # 其他设备的会话全部失效（改密码的常规安全预期），保留当前设备
    h = hashlib.sha256(tok.encode("utf-8")).hexdigest()
    db.execute("delete from auth.sessions where user_id = %s and token_hash <> %s", [uid, h])
    log_security(uid, "password_changed", {"ip": _client_ip(headers)})
    return 200, {"ok": True}


def auth_captcha() -> tuple[int, dict]:
    """发一张图形验证码。GET /api/auth/captcha

    答案只留在服务端内存，前端只拿到 PNG 和 id —— 这就是它不可绕过的原因。
    """
    if not CAPTCHA_ON:
        return 200, {"ok": True, "disabled": True}
    return 200, captcha_mod.new_captcha()


def auth_send_email_code(raw: str, headers: dict[str, str]) -> tuple[int, dict]:
    """发送邮箱验证码。POST /api/auth/email-code

    两道限制叠加：
      ① 必须先过图形验证码（挡脚本刷）
      ② 同邮箱 60 秒 1 条、每天 8 条；全局每天 300 条（挡刷我们的发信额度）
    """
    if not MAIL_ON:
        return 503, {"ok": False, "reason": "mail_not_configured",
                     "message": "邮件通道未配置，请联系站长"}
    try:
        body = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        return 400, {"ok": False, "reason": "bad_json"}

    # keep=True：这条图形码在「发送邮箱验证码」这一步先不消费，
    # 让用户接下来提交注册时还能复用同一张（否则要点两次图，体验很差）。
    passed, why = _verify_captcha_required(body, keep=True)
    if not passed:
        return _captcha_reject(why)
    ok_once, why_once = _captcha_send_once(body)
    if not ok_once:
        return 429, {"ok": False, "reason": why_once,
                     "message": "这张图形验证码已经用过一次了，请点图片换一张再发"}

    email = str(body.get("email") or "").strip().lower()
    if not _EMAIL_RE.match(email):
        return 400, {"ok": False, "reason": "bad_email", "message": "邮箱格式不正确"}

    allowed, quota_why = mailer.CODES.check_quota(email)
    if not allowed:
        if quota_why.startswith("too_frequent:"):
            wait = quota_why.split(":", 1)[1]
            return 429, {"ok": False, "reason": "too_frequent",
                         "message": f"发送太频繁，请 {wait} 秒后再试"}
        return 429, {"ok": False, "reason": quota_why,
                     "message": "今天该邮箱的验证码次数已用完，请明天再试"}

    code = f"{secrets.randbelow(1000000):06d}"
    sent, err = mailer.send_code(email, code, ttl_minutes=10)
    if not sent:
        log.error("邮箱验证码发送失败 %s：%s", email, err)
        return 502, {"ok": False, "reason": err,
                     "message": "验证码发送失败，请稍后重试或联系站长"}

    mailer.CODES.commit(email, code)
    log.info("邮箱验证码已发送 → %s", email[:2] + "***@" + email.split("@")[-1])
    return 200, {"ok": True, "ttl": 600,
                 "message": "验证码已发送，请查看邮箱（注意垃圾邮件箱）"}


def _norm_phone(raw: str) -> str:
    """规范化中国大陆手机号：只留数字，去掉 +86 / 86 前缀。"""
    d = "".join(ch for ch in str(raw or "") if ch.isdigit())
    if len(d) == 13 and d.startswith("86"):
        d = d[2:]
    if len(d) == 12 and d.startswith("0"):
        d = d[1:]
    return d


_PHONE_RE = re.compile(r"^1[3-9]\d{9}$")


def auth_send_sms_code(raw: str, headers: dict[str, str]) -> tuple[int, dict]:
    """发送短信验证码。POST /api/auth/sms-code

    与邮箱验证码同一套限制：先过图形码，再按号码限流（60 秒 1 条 / 每天 10 条 / 全局 200 条）。
    验证码**我们自己生成**，阿里云只负责把字发出去（自定义 Code）。
    """
    if SMS is None:
        return 503, {"ok": False, "reason": "sms_not_configured",
                     "message": "短信通道未配置，请改用邮箱验证码"}
    try:
        body = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        return 400, {"ok": False, "reason": "bad_json"}

    passed, why = _verify_captcha_required(body, keep=True)
    if not passed:
        return _captcha_reject(why)
    ok_once, why_once = _captcha_send_once(body)
    if not ok_once:
        return 429, {"ok": False, "reason": why_once,
                     "message": "这张图形验证码已经用过一次了，请点图片换一张再发"}

    phone = _norm_phone(body.get("phone") or "")
    if not _PHONE_RE.match(phone):
        return 400, {"ok": False, "reason": "bad_phone",
                     "message": "手机号格式不正确（仅支持中国大陆 11 位手机号）"}

    allowed, quota_why = SMS_CODES.check_quota(phone)
    if not allowed:
        if quota_why.startswith("too_frequent:"):
            wait = quota_why.split(":", 1)[1]
            return 429, {"ok": False, "reason": "too_frequent",
                         "message": f"发送太频繁，请 {wait} 秒后再试"}
        return 429, {"ok": False, "reason": quota_why,
                     "message": "今天该号码的验证码次数已用完，请明天再试"}

    code = f"{secrets.randbelow(1000000):06d}"
    resp = SMS.send_code(phone, code, 5)
    if not sms_ok(resp):
        detail = explain(resp) or str(resp.get("Message"))[:120]
        log.error("短信发送失败 %s：%s %s", phone[:3] + "****" + phone[-4:],
                  resp.get("Code"), detail)
        return 502, {"ok": False, "reason": resp.get("Code") or "send_failed",
                     "message": "短信发送失败：" + (detail or "请稍后重试")}

    SMS_CODES.commit(phone, code)
    log.info("短信验证码已发送 → %s", phone[:3] + "****" + phone[-4:])
    return 200, {"ok": True, "ttl": 300, "message": "验证码已发送，请查看短信"}


def auth_sms_login(raw: str, headers: dict[str, str]) -> tuple[int, dict]:
    """手机号 + 短信验证码**登录 / 首次自动注册**。POST /api/auth/sms-login

    没绑手机号的账号不受影响；这里只处理"用手机号进来"的用户。
    首次用某个号码登录时自动建号（email 为空、phone 唯一），
    这样学生不用被迫填邮箱。
    """
    if db is None:
        return 503, {"ok": False, "reason": "db_unavailable"}
    if SMS is None:
        return 503, {"ok": False, "reason": "sms_not_configured"}
    try:
        body = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        return 400, {"ok": False, "reason": "bad_json"}

    phone = _norm_phone(body.get("phone") or "")
    code = str(body.get("sms_code") or "").strip()

    passed, why = _verify_captcha_required(body)
    if not passed:
        return _captcha_reject(why)

    if not _PHONE_RE.match(phone):
        return 400, {"ok": False, "reason": "bad_phone", "message": "手机号格式不正确"}

    # 验证码猜解限流（2026-10-28）：6 位码 5 次机会听起来够安全，但没有频率限制时
    # 攻击者可以对同一个号反复"发码 + 试 5 次"，一天几千次。按号码 + IP 双线拦。
    ip = _client_ip(headers) or "-"
    for key, limiter in ((f"sms:{phone}", LOGIN_FAIL_BY_IDENT), (f"smsip:{ip}", LOGIN_FAIL_BY_IP)):
        blocked, wait = limiter.blocked(key)
        if blocked:
            return 429, {"ok": False, "reason": "too_many_attempts",
                         "message": f"尝试次数过多，请 {max(1, wait // 60)} 分钟后再试",
                         "retry_after": wait}

    ok_code, code_why = SMS_CODES.verify(phone, code)
    if not ok_code:
        LOGIN_FAIL_BY_IDENT.fail(f"sms:{phone}")
        LOGIN_FAIL_BY_IP.fail(f"smsip:{ip}")
        m = {
            "not_sent": "请先点击「发送验证码」",
            "expired": "验证码已过期，请重新获取",
            "mismatch": "验证码不正确",
            "too_many_tries": "验证码错误次数过多，请重新获取",
            "missing": "请填写短信验证码",
        }.get(code_why, "验证码校验失败")
        return 400, {"ok": False, "reason": "sms_code_" + code_why, "message": m}

    rows = db.execute("select id from auth.users where phone = %s", [phone])
    is_new = False
    if rows:
        uid = str(rows[0]["id"])
    else:
        # 首次登录 = 自动建号。email 留空（短信用户不一定有邮箱）。
        #
        # 邀请码（2026-10-21 加）：注册页也能选「手机号注册」，那就得和邮箱注册
        # 一样支持填邀请码。数据库的 handle_new_user() 触发器的判据是
        # `raw_user_meta_data->>'invite_code'`，所以这里塞进同一个字段即可，
        # 不用改触发器、也不用另开一条 SQL 路径。
        meta: dict[str, Any] = {"signup_via": "sms"}
        ref = str(body.get("invite_code") or "").strip().upper()
        if ref:
            meta["invite_code"] = ref
        created = db.execute(
            "insert into auth.users (phone, password_hash, raw_user_meta_data) "
            "values (%s, %s, %s) returning id",
            [phone, _hash_pw(secrets.token_urlsafe(24)),
             json.dumps(meta, ensure_ascii=False)])
        uid = str(created[0]["id"])
        is_new = True
        log.info("短信首次登录，已自动建号：%s（邀请码=%s）",
                 phone[:3] + "****" + phone[-4:], ref or "无")

    token, err = create_session(
        uid, headers=headers,
        device_id=body.get("device_id"), device_name=body.get("device_name"),
        enforce_limit=not bool(db.rpc("is_admin", {}, uid=uid)))
    if err == "device_limit":
        limit = device_limit_of(uid) or MAX_DEVICES
        return 409, {
            "ok": False, "reason": "device_limit",
            "message": f"这个账号已在 {limit} 台设备登录，请先在旧设备退出其中一台。",
            "max_devices": limit, "devices": list_devices(uid),
        }

    payload = _user_payload(uid, with_token=token)
    payload["is_new"] = is_new
    payload["device_count"] = 1
    payload["max_devices"] = device_limit_of(uid) or 0
    payload["banned"] = False
    payload["violations"] = 0
    return 200, payload


def auth_reset_by_phone(raw: str, headers: dict[str, str]) -> tuple[int, dict]:
    """手机号 + 短信验证码重置密码。POST /api/auth/reset-by-phone

    这是「忘记密码」里手机号那条路的真正实现（原来只有界面、按钮是灰的）。
    """
    if db is None:
        return 503, {"ok": False, "reason": "db_unavailable"}
    if SMS is None:
        return 503, {"ok": False, "reason": "sms_not_configured"}
    try:
        body = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        return 400, {"ok": False, "reason": "bad_json"}

    phone = _norm_phone(body.get("phone") or "")
    code = str(body.get("sms_code") or "").strip()
    new_password = str(body.get("new_password") or "")

    if not _PHONE_RE.match(phone):
        return 400, {"ok": False, "reason": "bad_phone", "message": "手机号格式不正确"}
    if len(new_password) < 8 or len(new_password) > 72:
        return 400, {"ok": False, "reason": "weak_password", "message": "新密码至少 8 位"}

    # 2026-10-28：补上图形码。原来注册/登录/发码都要过图形码，唯独"重置密码"不要 ——
    # 于是任何人都能对已知手机号连发错码，把受害者刚收到的验证码打成 too_many_tries
    # 直接作废（mailer/sms 的 CodeStore 错满 5 次就删），重置流程永远走不完。
    passed, why = _verify_captcha_required(body)
    if not passed:
        return _captcha_reject(why)

    ok_code, code_why = SMS_CODES.verify(phone, code)
    if not ok_code:
        m = {
            "not_sent": "请先点击「发送验证码」",
            "expired": "验证码已过期，请重新获取",
            "mismatch": "验证码不正确",
            "too_many_tries": "验证码错误次数过多，请重新获取",
        }.get(code_why, "验证码校验失败")
        return 400, {"ok": False, "reason": "sms_code_" + code_why, "message": m}

    rows = db.execute("select id from auth.users where phone = %s", [phone])
    if not rows:
        # 不暴露「这个号码有没有注册」
        return 200, {"ok": True, "message": "如果该手机号已注册，密码已重置"}

    uid = str(rows[0]["id"])
    db.execute(
        "update auth.users set password_hash = %s, "
        "raw_user_meta_data = coalesce(raw_user_meta_data, '{}'::jsonb) "
        "|| '{\"password_set\": true}'::jsonb where id = %s",
        [_hash_pw(new_password), uid])
    db.execute("delete from auth.sessions where user_id = %s", [uid])
    log_security(uid, "password_reset", {"ip": _client_ip(headers), "via": "sms_code"})
    log.info("密码已通过短信自助重置：%s", phone[:3] + "****" + phone[-4:])
    return 200, {"ok": True, "message": "密码已重置，请用新密码登录"}


def auth_reset_request(raw: str, headers: dict[str, str]) -> tuple[int, dict]:
    """重置密码：邮箱验证码自助重置。POST /api/auth/reset-request

    流程：过图形码 → 收邮件验证码 → 填新密码 → 服务端核验后改密。
    没配 SMTP 时退回人工通道（不再假装成功）。
    """
    if db is None:
        return 503, {"ok": False, "reason": "db_unavailable"}
    if not MAIL_ON:
        return 200, {"ok": False, "reason": "manual_required",
                     "message": "重置密码暂时采用人工方式：请联系站长（把注册邮箱发给他），验证后尽快帮你重置。"}
    try:
        body = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        return 400, {"ok": False, "reason": "bad_json"}

    email = str(body.get("email") or "").strip().lower()
    code = str(body.get("email_code") or "").strip()
    new_password = str(body.get("new_password") or "")

    if not _EMAIL_RE.match(email):
        return 400, {"ok": False, "reason": "bad_email", "message": "邮箱格式不正确"}
    if not code:
        return 400, {"ok": False, "reason": "missing_code", "message": "请填写邮箱验证码"}
    if len(new_password) < 8 or len(new_password) > 72:
        return 400, {"ok": False, "reason": "weak_password", "message": "新密码至少 8 位"}

    # 图形码（2026-10-28 补，理由同 auth_reset_by_phone）
    passed, why = _verify_captcha_required(body)
    if not passed:
        return _captcha_reject(why)

    ok_code, code_why = mailer.CODES.verify(email, code)
    if not ok_code:
        m = {
            "not_sent": "请先点击「发送验证码」",
            "expired": "验证码已过期，请重新获取",
            "mismatch": "验证码不正确",
            "too_many_tries": "验证码错误次数过多，请重新获取",
        }.get(code_why, "验证码校验失败")
        return 400, {"ok": False, "reason": "email_code_" + code_why, "message": m}

    rows = db.execute("select id from auth.users where lower(email) = %s", [email])
    # 不暴露「这个邮箱有没有注册」：照样返回成功文案，但不做任何改动
    if rows:
        uid = str(rows[0]["id"])
        db.execute("update auth.users set password_hash = %s where id = %s",
                   [_hash_pw(new_password), uid])
        db.execute("delete from auth.sessions where user_id = %s", [uid])
        log_security(uid, "password_reset", {"ip": _client_ip(headers), "via": "email_code"})
        log.info("密码已自助重置：%s", _mask_email(email))
    else:
        log.info("重置请求命中未注册邮箱（静默忽略）：%s", email)

    return 200, {"ok": True, "message": "密码已重置，请用新密码登录"}


def data_papers(query: dict, headers: dict[str, str]) -> tuple[int, dict]:
    if db is None:
        return 503, {"ok": False, "reason": "db_unavailable"}
    uid = verify_user(_bearer(headers))
    scope = (query.get("scope") or [""])[0]
    login_only: dict[str, int] = {}
    try:
        if scope == "all":
            if not uid:
                return 401, {"ok": False, "reason": "not_logged_in"}
            if not db.rpc("is_admin", {}, uid=uid):
                return 403, {"ok": False, "reason": "not_admin"}
            rows = db.execute("select * from public.papers order by created_at desc")
        elif uid:
            # 登录用户：全部已发布（含 visibility='login' 的）
            rows = db.execute("select * from public.papers "
                              "where status = 'published' order by created_at desc")
        else:
            # 匿名：只看公开的（等价于原 RLS：匿名读不到 login 行）
            rows = db.execute("select * from public.papers "
                              "where status = 'published' and visibility = 'public' "
                              "order by created_at desc")
            # 顺带告诉前端「还有多少份是登录可见的」（只给数量，不给内容）。
            # 没有这个数字，匿名访客点进会计学/统计学只会看到「没有试卷」，
            # 误以为真题丢了（2026-10-17 用户实际反馈）。
            stat = db.execute(
                "select course_id, count(*)::int as n from public.papers "
                "where status = 'published' and visibility = 'login' "
                "group by course_id")
            login_only = {str(r["course_id"]): int(r["n"]) for r in stat}
    except Exception as e:  # noqa: BLE001
        log.exception("读取试卷列表失败：%s", e)
        return 500, {"ok": False, "reason": "db_error"}
    payload: dict = {"ok": True, "papers": _jsonable(rows)}

    # 2026-10-20：匿名访客的"全库口径"统计。
    # 用户反馈「为什么只显示 53 套真题」——因为匿名只拿得到 public 行，
    # 另有 37 行 visibility='login' 服务端根本不给。
    # 这里只补**数字**（份数 / 含答案份数），不下发任何登录可见行的内容，
    # 既不破坏原有的可见性规则，又让首页能报真实总量。
    if not uid:
        try:
            agg = db.execute(
                "select count(*)::int as total, "
                "       count(*) filter (where has_answer)::int as with_answer "
                "from public.papers where status = 'published'")
            if agg:
                payload["total_papers"] = int(agg[0]["total"] or 0)
                payload["total_with_answer"] = int(agg[0]["with_answer"] or 0)
        except Exception:  # noqa: BLE001
            pass

    if login_only:
        payload["login_only_by_course"] = login_only
        payload["login_only_total"] = sum(login_only.values())
    return 200, payload


_PROFILE_FIELDS = ("display_name", "student_id", "school", "college")


def data_profile_get(headers: dict[str, str]) -> tuple[int, dict]:
    uid = verify_user(_bearer(headers))
    if not uid:
        return 401, {"ok": False, "reason": "not_logged_in"}
    return 200, {"ok": True, "profile": _fetch_profile(uid)}


def data_profile_update(raw: str, headers: dict[str, str]) -> tuple[int, dict]:
    if db is None:
        return 503, {"ok": False, "reason": "db_unavailable"}
    uid = verify_user(_bearer(headers))
    if not uid:
        return 401, {"ok": False, "reason": "not_logged_in"}
    try:
        body = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        return 400, {"ok": False, "reason": "bad_json"}
    sets, vals = [], []
    for f in _PROFILE_FIELDS:               # 字段名来自固定元组，安全
        if f in body:
            sets.append(f"{f} = %s")
            vals.append(str(body.get(f) or "")[:120])
    if not sets:
        return 400, {"ok": False, "reason": "nothing_to_update"}
    vals.append(uid)
    try:
        db.execute(f"update public.profiles set {', '.join(sets)} where id = %s", vals)
    except Exception as e:  # noqa: BLE001
        log.exception("更新资料失败：%s", e)
        return 500, {"ok": False, "reason": "db_error"}
    return 200, {"ok": True, "profile": _fetch_profile(uid)}


def data_favorites_get(headers: dict[str, str]) -> tuple[int, dict]:
    uid = verify_user(_bearer(headers))
    if not uid:
        return 401, {"ok": False, "reason": "not_logged_in"}
    rows = db.execute("select paper_id, created_at from public.favorites "
                      "where user_id = %s order by created_at desc", [uid])
    return 200, {"ok": True, "favorites": _jsonable(rows)}


def data_favorites_toggle(raw: str, headers: dict[str, str]) -> tuple[int, dict]:
    if db is None:
        return 503, {"ok": False, "reason": "db_unavailable"}
    uid = verify_user(_bearer(headers))
    if not uid:
        return 401, {"ok": False, "reason": "not_logged_in"}
    try:
        body = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        return 400, {"ok": False, "reason": "bad_json"}
    pid = str(body.get("paper_id") or "")
    if not _UUID_RE.match(pid):
        return 400, {"ok": False, "reason": "bad_paper_id"}
    rows = db.execute("select id from public.favorites "
                      "where user_id = %s and paper_id = %s", [uid, pid])
    if rows:
        db.execute("delete from public.favorites "
                   "where user_id = %s and paper_id = %s", [uid, pid])
        return 200, {"ok": True, "action": "removed"}
    ins = db.execute("insert into public.favorites (user_id, paper_id) "
                     "values (%s, %s) returning created_at", [uid, pid])
    return 200, {"ok": True, "action": "added",
                 "created_at": _jsonable(ins[0]["created_at"]) if ins else None}


def data_recent_get(headers: dict[str, str]) -> tuple[int, dict]:
    uid = verify_user(_bearer(headers))
    if not uid:
        return 401, {"ok": False, "reason": "not_logged_in"}
    rows = db.execute("select paper_id, viewed_at from public.recent_views "
                      "where user_id = %s order by viewed_at desc limit 20", [uid])
    return 200, {"ok": True, "recent": _jsonable(rows)}


def data_recent_add(raw: str, headers: dict[str, str]) -> tuple[int, dict]:
    if db is None:
        return 503, {"ok": False, "reason": "db_unavailable"}
    uid = verify_user(_bearer(headers))
    if not uid:
        return 401, {"ok": False, "reason": "not_logged_in"}
    try:
        body = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        return 400, {"ok": False, "reason": "bad_json"}
    pid = str(body.get("paper_id") or "")
    if not _UUID_RE.match(pid):
        return 400, {"ok": False, "reason": "bad_paper_id"}
    row = db.execute(
        "insert into public.recent_views (user_id, paper_id) values (%s, %s) "
        "on conflict (user_id, paper_id) do update set viewed_at = now() "
        "returning viewed_at", [uid, pid])
    return 200, {"ok": True,
                 "viewed_at": _jsonable(row[0]["viewed_at"]) if row else None}


# ══════════════════════════════════════════════════════════════════
# 继续阅读 + 错题本（2026-10-25 深夜批次：④继续阅读 / ③错题本）
# 表见 sql/2026-10-25-继续阅读与错题本.sql
# ══════════════════════════════════════════════════════════════════

def data_progress_get(headers: dict[str, str]) -> tuple[int, dict]:
    """GET /api/data/progress —— 全部阅读进度（书库徽章用），带卷名便于直接展示。"""
    uid = verify_user(_bearer(headers))
    if not uid:
        return 401, {"ok": False, "reason": "not_logged_in"}
    rows = db.execute(
        "select r.paper_id, r.page, r.which, r.updated_at, "
        "  p.course_name, coalesce(p.title, '') as title, p.year "
        "from public.reading_progress r "
        "left join public.papers p on p.id = r.paper_id "
        "where r.user_id = %s and r.which = 'paper' "
        "order by r.updated_at desc limit 60", [uid])
    return 200, {"ok": True, "progress": _jsonable(rows)}


def data_progress_set(raw: str, headers: dict[str, str]) -> tuple[int, dict]:
    """POST /api/data/progress {paper_id, page, which?} —— 高频 upsert，越轻越好。"""
    if db is None:
        return 503, {"ok": False, "reason": "db_unavailable"}
    uid = verify_user(_bearer(headers))
    if not uid:
        return 401, {"ok": False, "reason": "not_logged_in"}
    try:
        body = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        return 400, {"ok": False, "reason": "bad_json"}
    pid = str(body.get("paper_id") or "")
    if not _UUID_RE.match(pid):
        return 400, {"ok": False, "reason": "bad_paper_id"}
    try:
        page = max(1, min(int(body.get("page") or 1), 500))
    except (TypeError, ValueError):
        return 400, {"ok": False, "reason": "bad_page"}
    which = "answer" if body.get("which") == "answer" else "paper"
    db.execute(
        "insert into public.reading_progress (user_id, paper_id, page, which, updated_at) "
        "values (%s, %s, %s, %s, now()) "
        "on conflict (user_id, paper_id, which) do update "
        "set page = excluded.page, updated_at = now()", [uid, pid, page, which])
    return 200, {"ok": True}


MISTAKE_FREE_LIMIT = 10     # 免费用户错题本上限；会员不限


def data_mistakes_get(headers: dict[str, str]) -> tuple[int, dict]:
    """GET /api/data/mistakes —— 错题本（带卷名，最新在前）。"""
    uid = verify_user(_bearer(headers))
    if not uid:
        return 401, {"ok": False, "reason": "not_logged_in"}
    rows = db.execute(
        "select m.id, m.paper_id, m.page, m.question, m.created_at, "
        "  p.course_name, coalesce(p.title, '') as title, p.year, "
        "  p.solution_page "
        "from public.mistakes m "
        "left join public.papers p on p.id = m.paper_id "
        "where m.user_id = %s order by m.created_at desc limit 200", [uid])
    mem = db.rpc("my_membership", {}, uid=uid)
    return 200, {"ok": True, "mistakes": _jsonable(rows),
                 "is_member": bool(mem.get("is_member")),
                 "free_limit": MISTAKE_FREE_LIMIT}


def data_mistakes_add(raw: str, headers: dict[str, str]) -> tuple[int, dict]:
    """POST /api/data/mistakes {paper_id, page, question?} —— 免费用户超 10 条拦截。"""
    if db is None:
        return 503, {"ok": False, "reason": "db_unavailable"}
    uid = verify_user(_bearer(headers))
    if not uid:
        return 401, {"ok": False, "reason": "not_logged_in"}
    try:
        body = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        return 400, {"ok": False, "reason": "bad_json"}
    pid = str(body.get("paper_id") or "")
    if not _UUID_RE.match(pid):
        return 400, {"ok": False, "reason": "bad_paper_id"}
    try:
        page = max(1, min(int(body.get("page") or 1), 500))
    except (TypeError, ValueError):
        return 400, {"ok": False, "reason": "bad_page"}
    question = str(body.get("question") or "")[:60].strip()
    mem = db.rpc("my_membership", {}, uid=uid)
    if not mem.get("is_member"):
        rows = db.execute("select count(*) as n from public.mistakes where user_id = %s", [uid])
        if int(rows[0]["n"] or 0) >= MISTAKE_FREE_LIMIT:
            return 403, {"ok": False, "reason": "mistake_limit",
                         "message": f"免费用户最多记 {MISTAKE_FREE_LIMIT} 道错题，开通会员后不限量"}
    ins = db.execute(
        "insert into public.mistakes (user_id, paper_id, page, question) "
        "values (%s, %s, %s, %s) "
        "on conflict (user_id, paper_id, page, question) do nothing "
        "returning id, created_at", [uid, pid, page, question])
    return 200, {"ok": True, "added": bool(ins),
                 "mistake": _jsonable(ins[0]) if ins else None}


def data_mistakes_remove(raw: str, headers: dict[str, str]) -> tuple[int, dict]:
    """POST /api/data/mistakes/remove {id} —— 只能删自己的。"""
    if db is None:
        return 503, {"ok": False, "reason": "db_unavailable"}
    uid = verify_user(_bearer(headers))
    if not uid:
        return 401, {"ok": False, "reason": "not_logged_in"}
    try:
        body = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        return 400, {"ok": False, "reason": "bad_json"}
    try:
        mid = int(body.get("id") or 0)
    except (TypeError, ValueError):
        return 400, {"ok": False, "reason": "bad_id"}
    if mid <= 0:
        return 400, {"ok": False, "reason": "bad_id"}
    db.execute("delete from public.mistakes where id = %s and user_id = %s", [mid, uid])
    return 200, {"ok": True}


def data_admin_stats(headers: dict[str, str]) -> tuple[int, dict]:
    """GET /api/data/admin/stats —— 数据看板（⑧，仅管理员）。

    口径刻意从简（都是已有表的重聚合，不加新埋点）：
      · 浏览 Top20：papers.view_count（前端 incrementPaperView 累加）
      · 活跃/提问：ai_usage（AI 埋点本来就有）+ recent_views（当天打开过卷子的人）
      · 增长：profiles 注册曲线、会员构成
    """
    if db is None:
        return 503, {"ok": False, "reason": "db_unavailable"}
    uid = verify_user(_bearer(headers))
    if not uid:
        return 401, {"ok": False, "reason": "not_logged_in"}
    if not db.rpc("is_admin", {}, uid=uid):
        return 403, {"ok": False, "reason": "not_admin"}
    out = {}
    out["top_papers"] = _jsonable(db.execute(
        "select course_name, coalesce(title,'') as title, year, "
        "coalesce(view_count, 0) as views from public.papers "
        "where status = 'published' "
        "order by coalesce(view_count, 0) desc limit 20"))
    out["ai_by_course"] = _jsonable(db.execute(
        "select p.course_name, count(*) as asks, "
        "count(distinct u.user_id) as users "
        "from public.ai_usage u left join public.papers p on p.id = u.paper_id "
        "group by 1 order by asks desc limit 20"))
    out["ai_daily"] = _jsonable(db.execute(
        "select created_at::date as day, count(*) as asks, "
        "count(distinct user_id) as users "
        "from public.ai_usage where created_at > now() - interval '14 days' "
        "group by 1 order by 1"))
    out["signups_daily"] = _jsonable(db.execute(
        "select created_at::date as day, count(*) as n "
        "from public.profiles where created_at > now() - interval '30 days' "
        "group by 1 order by 1"))
    out["tiers"] = _jsonable(db.execute(
        "select membership_tier, count(*) as n from public.profiles "
        "group by 1 order by n desc"))
    out["today"] = _jsonable(db.execute(
        "select "
        "(select count(distinct user_id) from public.recent_views "
        "  where viewed_at::date = current_date) as readers_today, "
        "(select count(*) from public.ai_usage "
        "  where created_at::date = current_date) as asks_today, "
        "(select count(*) from public.mistakes) as mistakes_total, "
        "(select count(*) from public.reading_progress "
        "  where updated_at > now() - interval '7 days') as active_readers_week"))
    return 200, {"ok": True, "stats": out}


def data_my_orders(query: dict, headers: dict[str, str]) -> tuple[int, dict]:
    uid = verify_user(_bearer(headers))
    if not uid:
        return 401, {"ok": False, "reason": "not_logged_in"}
    try:
        limit = int((query.get("limit") or ["10"])[0])
    except ValueError:
        limit = 10
    limit = max(1, min(limit, 50))
    rows = db.execute(
        "select order_no, tier, amount_cents, status, created_at, paid_at, claimed_at "
        "from public.payment_orders where user_id = %s "
        "order by created_at desc limit %s", [uid, limit])
    return 200, {"ok": True, "orders": _jsonable(rows)}


# ======================================================================
# 微信 openid 绑定到账号（2026-10-27）
# ======================================================================
# 为什么需要：JSAPI 下单必须带 openid，而拿 openid 必须走 OAuth 授权，
# **而授权是整页跳转**。只要"每次支付前才去拿 openid"，用户就每次都被跳一次
# （用户原话：「怎么感觉老是有一个支付流程结构上的问题」）。
#
# 办法：第一次授权拿到 openid 就存到这个账号上，之后直接从库里读，
# 支付全程零跳转。
#
# 安全考虑：openid 只是「这个微信用户 + 这个 AppID」的标识，不是凭证，
# 拿到 openid 也不能替别人付款；但仍只允许本人读写自己的那一行。

def bind_wx_openid(raw: str, headers: dict[str, str]) -> tuple[int, dict]:
    """把这个账号的 wx_openid 存下来（登录后由前端调用）。"""
    if db is None:
        return 503, {"ok": False, "reason": "db_unavailable"}
    uid = verify_user(_bearer(headers))
    if not uid:
        return 401, {"ok": False, "reason": "not_logged_in"}

    try:
        body = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        return 400, {"ok": False, "reason": "bad_json"}

    openid = str(body.get("openid") or "").strip()
    # 微信 openid 形如 oXXXX...（28 位左右，只含字母数字_-）
    if not (18 <= len(openid) <= 64) or not re.fullmatch(r"[A-Za-z0-9_\-]+", openid):
        return 400, {"ok": False, "reason": "bad_openid"}

    try:
        db.execute(
            "update public.profiles set wx_openid = %s where id = %s",
            (openid, uid),
        )
    except Exception as exc:  # noqa: BLE001
        log.error("绑定 openid 失败 uid=%s: %s", uid, exc)
        return 500, {"ok": False, "reason": "db_error"}

    # openid 不落日志（2026-10-28）：它是这个服务号下可识别到人的标识，
    # 排查只需要知道"有没有绑"，不需要知道具体值。
    log.info("账号 %s 已绑定微信 openid（长度 %d）", str(uid)[:8], len(openid))
    return 200, {"ok": True}


def my_wx_openid(headers: dict[str, str]) -> tuple[int, dict]:
    """返回当前账号已绑定的 openid（没有就返回 null）。"""
    if db is None:
        return 503, {"ok": False, "reason": "db_unavailable"}
    uid = verify_user(_bearer(headers))
    if not uid:
        return 401, {"ok": False, "reason": "not_logged_in"}
    try:
        rows = db.execute(
            "select wx_openid from public.profiles where id = %s", (uid,)
        )
    except Exception as exc:  # noqa: BLE001
        log.error("查 openid 失败 uid=%s: %s", uid, exc)
        return 500, {"ok": False, "reason": "db_error"}
    openid = (rows[0].get("wx_openid") if rows else None) or None
    return 200, {"ok": True, "openid": openid}


def data_admin_users(headers: dict[str, str]) -> tuple[int, dict]:
    if db is None:
        return 503, {"ok": False, "reason": "db_unavailable"}
    uid = verify_user(_bearer(headers))
    if not uid:
        return 401, {"ok": False, "reason": "not_logged_in"}
    if not db.rpc("is_admin", {}, uid=uid):
        return 403, {"ok": False, "reason": "not_admin"}
    # 带上 auth.users.phone（2026-10-21）：手机号注册的账号 profiles.email 是 NULL，
    # 后台如果只看 profiles 就分不清"空账号"和"手机号用户"。
    #
    # ⚠️ 2026-10-23：排序改 `desc`（新的在最上）。
    #    原来这里是 `order by p.created_at`（升序），而订单表是 `desc` ——
    #    两个后台列表方向相反，用户两次反馈「用户列表排列逻辑不对，要变成从上往下越来越旧」。
    #    注册时间相同（同一秒批量注册）时用 id 兜底，保证顺序稳定、不会来回跳。
    rows = db.execute(
        "select p.*, u.phone from public.profiles p "
        "join auth.users u on u.id = p.id "
        "order by p.created_at desc, p.id desc")
    return 200, {"ok": True, "users": _jsonable(rows)}


def data_admin_delete(raw: str, headers: dict[str, str]) -> tuple[int, dict]:
    """删除一份试卷（连同 PDF / 图片目录 / 关联记录）—— 管理员专用。"""
    if db is None:
        return 503, {"ok": False, "reason": "db_unavailable"}
    uid = verify_user(_bearer(headers))
    if not uid:
        return 401, {"ok": False, "reason": "not_logged_in"}
    if not db.rpc("is_admin", {}, uid=uid):
        return 403, {"ok": False, "reason": "not_admin"}
    try:
        body = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        return 400, {"ok": False, "reason": "bad_json"}
    pid = str(body.get("id") or "")
    if not _UUID_RE.match(pid):
        return 400, {"ok": False, "reason": "bad_paper_id"}
    rows = db.execute("select file_path, answer_path from public.papers where id = %s", [pid])
    if not rows:
        return 404, {"ok": False, "reason": "not_found"}
    row = rows[0]
    for fp in (row.get("file_path"), row.get("answer_path")):
        if fp:
            name = pages_dir_of(str(fp))
            shutil.rmtree(os.path.join(PDFS_DIR, name), ignore_errors=True)
            shutil.rmtree(os.path.join(PAGES_DIR, name), ignore_errors=True)
    # 先清关联记录再删主记录（与历史人工删除流程一致）
    db.execute("delete from public.paper_unlocks where paper_id = %s", [pid])
    db.execute("delete from public.favorites where paper_id = %s", [pid])
    db.execute("delete from public.recent_views where paper_id = %s", [pid])
    db.execute("delete from public.papers where id = %s", [pid])
    return 200, {"ok": True}


def data_rpc(raw: str, headers: dict[str, str]) -> tuple[int, dict]:
    """RPC 转发：前端 supabase.rpc(fn, args) 的等价物。

    函数名白名单在 db.py（ALLOWED_RPC），这里不再维护第二份；
    匿名也可调（如 count_login_only_papers），身份（或"匿名"）由会话决定。
    """
    if db is None:
        return 503, {"ok": False, "reason": "db_unavailable"}
    try:
        body = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        return 400, {"ok": False, "reason": "bad_json"}
    fn = str(body.get("fn") or "").strip()
    args = body.get("args") or {}
    if not isinstance(args, dict):
        return 400, {"ok": False, "reason": "bad_args"}
    uid = verify_user(_bearer(headers))
    try:
        result = db.rpc(fn, args, uid=uid)
    except ValueError as e:
        return 400, {"ok": False, "reason": "bad_fn", "message": str(e)}
    except Exception as e:  # noqa: BLE001
        log.exception("rpc %s 失败：%s", fn, e)
        return 500, {"ok": False, "reason": "rpc_error", "message": "查询失败，请稍后重试"}
    return 200, {"ok": True, "data": _jsonable(result)}


# ---- 管理员上传（multipart 解析 + 落盘 + 入库）----

def parse_multipart(body: bytes, content_type: str) -> dict[str, tuple[str | None, bytes]]:
    """极简 multipart/form-data 解析（只处理我们自己的上传表单，够用即可）。"""
    m = re.search(r'boundary="?([^";]+)"?', content_type or "")
    if not m:
        return {}
    boundary = b"--" + m.group(1).encode("utf-8")
    parts: dict[str, tuple[str | None, bytes]] = {}
    for chunk in body.split(boundary):
        if chunk.startswith(b"\r\n"):
            chunk = chunk[2:]
        if not chunk or chunk.startswith(b"--"):        # 结尾段 / 空段
            continue
        if chunk.endswith(b"\r\n"):
            chunk = chunk[:-2]
        if b"\r\n\r\n" not in chunk:
            continue
        head, data = chunk.split(b"\r\n\r\n", 1)
        hdr = head.decode("utf-8", "replace")
        name_m = re.search(r'name="([^"]*)"', hdr)
        if not name_m:
            continue
        fn_m = re.search(r'filename="([^"]*)"', hdr)
        parts[name_m.group(1)] = (fn_m.group(1) if fn_m else None, data)
    return parts


def save_pdf(file_path: str, data: bytes) -> str:
    """把上传的 PDF 写进 /var/lib/ctbu-pdfs/<目录>/<文件>.pdf，返回目录名。"""
    name = file_path.replace("/", "__").rsplit(".pdf", 1)[0]
    d = os.path.join(PDFS_DIR, name)
    os.makedirs(d, exist_ok=True)
    path = os.path.join(d, name + ".pdf")
    with open(path, "wb") as f:
        f.write(data)
    os.chmod(path, 0o644)
    return name


def insert_paper(meta: dict, file_path: str, file_size: int,
                 answer_path: str | None) -> dict:
    cols = {
        "course_id": str(meta.get("course_id") or "").strip(),
        "course_name": str(meta.get("course_name") or "").strip(),
        "category": str(meta.get("category") or "").strip(),
        "year": meta.get("year"),
        "semester": str(meta.get("semester") or ""),
        "exam_type": str(meta.get("exam_type") or "期末"),
        "source_type": str(meta.get("source_type") or "original"),
        "resource_type": str(meta.get("resource_type") or "exam"),
        "source_school": (str(meta["source_school"]) if meta.get("source_school") else None),
        "has_answer": bool(meta.get("has_answer")),
        "has_solution": bool(meta.get("has_solution")),
        "solution_page": meta.get("solution_page"),
        "page_count": int(meta.get("page_count") or 1),
        "file_path": file_path,
        "file_size": file_size,
        "answer_path": answer_path,
        "description": str(meta.get("description") or ""),
        "status": "published",
        "visibility": "public" if meta.get("visibility") == "public" else "login",
        "uploaded_by": meta.get("uploaded_by"),
    }
    keys = list(cols.keys())
    ph = ", ".join(["%s"] * len(keys))
    rows = db.execute(
        f"insert into public.papers ({', '.join(keys)}) values ({ph}) returning *",
        [cols[k] for k in keys])
    return _jsonable(rows[0]) if rows else {}


# ======================================================================
# 四六级听力音频：签发 nginx secure_link 短效链接
# ======================================================================
# 链路：前端 POST /api/pay/sign-media {path:"/media/cet4/x.mp3"}
#   → 服务端验用户 → 验会员 → 拼 md5 → 返回 /media/...?md5=<sig>&expires=<ts>
#   → nginx 用 secure_link 校验，通过才发文件（支持 Range，可拖进度条）
# ⚠️ 密钥必须与 nginx 的 $ctbu_media_secret 完全一致（见 config.json 的 media_secret）
MEDIA_TTL_SECONDS = 6 * 3600          # 6 小时：一套听力听很久也够用
# 听力音频：mp3（旧）与 m4a（AAC 版，2026-10-17 起前端默认用它）
_MEDIA_PATH_RE = re.compile(r"^/media/[A-Za-z0-9._/-]+\.(mp3|m4a)$")


def media_sign(path: str, expires: int) -> str:
    """复刻 nginx `secure_link_md5 "$secure_link_expires$uri <secret>"`。

    ⚠️ 拼串里 uri 与密钥之间**必须有一个空格** —— 少这个空格签名会恒不匹配（踩过）。
    nginx 要的是：md5 原始字节 → base64 → `+`→`-`、`/`→`_` → **去掉 `=`**
    """
    secret = str(CFG.get("media_secret") or "")
    raw = f"{expires}{path} {secret}".encode("utf-8")
    digest = hashlib.md5(raw).digest()
    sig = base64.b64encode(digest).decode("ascii")
    return sig.replace("+", "-").replace("/", "_").rstrip("=")


# ======================================================================
# 试卷「逐页图片」：把扫描版试卷按页发出去（2026-10-17 新增）
#
# 为什么要有这条通道：
#   扫描版试卷整份 2.4 MB，而 PDF.js 必须拿到**整份**才能渲染第一页 →
#   实测在 3 Mbps 上首屏要 7.9 秒。切成逐页 WebP 后首屏只有 110 KB、
#   实测 0.156 秒，快了约 50 倍。矢量版试卷**不走这条路**（图片化反而会变大 4 倍）。
#
# 鉴权与 /media/ 同一套路：nginx secure_link + 逐 URI 签名。
# 但**授权判定在这里**（会员 or 已解锁），前端绕不过去 —— 这是红线。
# ======================================================================
PAGES_DIR = str(CFG.get("pages_dir") or "/var/lib/ctbu-pages")
# 试卷原始 PDF（矢量卷走这条；扫描卷走图片，不下载 PDF）
PDFS_DIR = str(CFG.get("pdfs_dir") or "/var/lib/ctbu-pdfs")
# 页面链接的有效期。2026-10-28 由 6 小时收到 2 小时：
# 签名只有 "过期时间 + 路径 + 密钥"，不绑用户、不可吊销 —— 链接被转发到群里，
# 在这段时间内谁都能下。2 小时足够一次自习，且配合前端"失败自动重签"不影响体验。
PAGES_URL_TTL = 2 * 3600


def pdf_local_exists(file_path: str) -> bool:
    """本机有没有这份 PDF（2026-10-17 把全部 66 个 PDF 都搬到了 /var/lib/ctbu-pdfs/）。

    有就签本地链接 —— 这才是"文件彻底搬离 Supabase"的落点；
    没有就退回让前端走 Supabase（过渡期兜底，不该有文件落到这里）。
    """
    if not file_path:
        return False
    name = file_path.replace("/", "__").rsplit(".pdf", 1)[0]
    if ".." in name or "/" in name:
        return False
    return os.path.isfile(os.path.join(PDFS_DIR, name, name + ".pdf"))


def pdf_sign_url(file_path: str, expires: int) -> str | None:
    """给本地 PDF 签一个 nginx secure_link 链接；本机没有就返回 None。"""
    if not pdf_local_exists(file_path):
        return None
    name = file_path.replace("/", "__").rsplit(".pdf", 1)[0]
    uri = f"/pdfs/{name}/{name}.pdf"
    return f"{uri}?md5={pages_sign(uri, expires)}&expires={expires}"


def pages_sign(path: str, expires: int) -> str:
    """与 media_sign 同算法，只是换用 pages_secret（两把密钥分开，互不影响）"""
    secret = str(CFG.get("pages_secret") or "")
    if not secret:
        raise RuntimeError("config.json 缺 pages_secret")
    raw = f"{expires}{path} {secret}".encode("utf-8")
    digest = hashlib.md5(raw).digest()
    sig = base64.b64encode(digest).decode("ascii")
    return sig.replace("+", "-").replace("/", "_").rstrip("=")


def pages_dir_of(file_path: str) -> str:
    """由 papers.file_path 推出图片目录名（与 上传图片.py 的命名规则必须一致）。

    file_path 形如 `c017/1792145430547-CTBU-_-2020-2021-_1_-A_-_.pdf`
    → 目录名 `c017__1792145430547-CTBU-_-2020-2021-_1_-A_-_`
    规则只用 ASCII，URL 里不会出现中文，省掉一整类编码问题。
    """
    return file_path.replace("/", "__").rsplit(".pdf", 1)[0]


def pages_count(dirname: str) -> int:
    """数这个目录下有多少张 pNN.webp。目录不存在 → 0（调用方据此回退 PDF）。"""
    if not dirname or "/" in dirname or ".." in dirname:
        return 0
    d = os.path.join(PAGES_DIR, dirname)
    if not os.path.isdir(d):
        return 0
    return sum(1 for f in os.listdir(d)
               if f.startswith("p") and f.endswith(".webp"))


# ======================================================================
# 四六级全卷「答案解析」：会员专属数据
# ======================================================================
# 链路：前端 GET /api/pay/cet-explain?slug=cet4-2024-12-1（带用户 access token）
#   → 服务端验用户 → 验会员 → 读 /var/lib/ctbu-cet-explain/{slug}.json → 原样返回
#
# 为什么必须走服务端而不是放前端 public/：
#   public/ 是静态资源，谁拿到 URL 都能下，会员限制就形同虚设。
#   解析文本（逐题解析、写作范文、参考译文）是会员内容，必须在这里把关。
#
# 注意与「答案字母」的分工：判分要用的答案字母是**公开**的（随前端走，
# public/cet/full/{slug}.key.json），否则学生做完题得不到任何反馈。
# 这里返回的是完整的解析文本。
CET_EXPLAIN_DIR = str(CFG.get("cet_explain_dir") or "/var/lib/ctbu-cet-explain")
# slug 白名单：只有 cet4-2024-12-1 这种形状能通过，杜绝路径穿越
_CET_SLUG_RE = re.compile(r"^cet[46]-\d{4}-\d{2}-\d$")
# 单套解析约 100KB，给 8MB 上限足够，同时防止有人拿超大文件打内存
_CET_MAX_BYTES = 8 * 1024 * 1024


def load_cet_explain(slug: str) -> bytes | None:
    """读某套的解析 JSON（字节）。目录/文件不存在都返回 None，由调用方转成 404。"""
    if not _CET_SLUG_RE.match(slug or ""):
        return None
    path = os.path.join(CET_EXPLAIN_DIR, f"{slug}.json")
    # 双保险：正则已挡住穿越，这里再确认最终路径仍在目录内
    if os.path.realpath(os.path.dirname(path)) != os.path.realpath(CET_EXPLAIN_DIR):
        return None
    try:
        if os.path.getsize(path) > _CET_MAX_BYTES:
            log.error("解析文件超过上限：%s", path)
            return None
        with open(path, "rb") as fh:
            return fh.read()
    except OSError:
        return None


# ======================================================================
# 四六级「原题 + 答案解析」PDF：签发 nginx secure_link 短效链接（会员专属）
# ======================================================================
# 链路：前端 GET /api/pay/cet-solution-url?slug=cet4-2024-12-1（带用户 token）
#   → 服务端验用户 → 验会员 → 用 media_sign() 签 /solutions/{slug}-paper-solution.pdf
#   → 返回 {ok:true, url:"/solutions/...?md5=..&expires=.."} → 浏览器下载
#   → nginx 用 secure_link 校验，通过才发文件
#
# 与「原题 PDF」的分工（用户 2026-10-16 拍板）：
#   · 原题 PDF  **公开**，nginx 直接静态挂着（/papers/ → /var/www/ctbu-papers/）
#   · 解析版 PDF  **会员专享**，走签名 + 私密目录（/var/lib/ctbu-cet-solution/，750）
#   所以这里只签解析版；原题不需要经过本服务。
#
# ⚠️ 密钥沿用 media_secret（nginx 里那个 $ctbu_media_secret），**别再造第二份** ——
#    再造一份就要在 nginx 多一个 map 变量，两份密钥还会不同步。
CET_SOLUTION_DIR = str(CFG.get("cet_solution_dir") or "/var/lib/ctbu-cet-solution")
# 与听力音频同口径：6 小时足够学生下载，过期后前端会重新换一次链接
CET_SOLUTION_TTL_SECONDS = 30 * 60


def cet_solution_relpath(slug: str) -> str | None:
    """解析版 PDF 在站点上的 URI（也是 nginx secure_link 参与签名的 $uri）。

    slug 只有过白名单才放行 —— 否则 `/solutions/../../etc/shadow` 这类能签到任意路径。
    """
    if not _CET_SLUG_RE.match(slug or ""):
        return None
    return f"/solutions/{slug}-paper-solution.pdf"


def cet_solution_file(slug: str) -> str | None:
    """解析版 PDF 在服务器上的绝对路径；slug 不合法或路径逃逸则 None。"""
    if not _CET_SLUG_RE.match(slug or ""):
        return None
    path = os.path.join(CET_SOLUTION_DIR, f"{slug}-paper-solution.pdf")
    # 双保险：正则已挡住穿越，这里再确认最终路径仍在目录内
    if os.path.realpath(os.path.dirname(path)) != os.path.realpath(CET_SOLUTION_DIR):
        return None
    return path


# ======================================================================
# 微信网页授权：code → openid（JSAPI 必需）
# ======================================================================
def qr_data_url(text: str, box_size: int = 8, border: int = 2) -> str | None:
    """把一段文本渲染成 PNG 二维码，返回 `data:image/png;base64,...`。

    为什么在后端生成：
      前端装个 JS 二维码库要 +15KB 且要处理打包；
      服务端 `python3-qrcode` 是 apt 包，一行 import 就够，
      而且微信支付官方 Native 给的 `code_url` 本来就是个字符串，
      最终还是要变成图 —— 干脆一次做完。

    依赖缺失时返回 None（前端退回到「显示 code_url 文本 + 提示复制」），不报错。
    """
    try:
        import base64 as _b64
        import io as _io
        import qrcode  # type: ignore

        img = qrcode.make(text, box_size=box_size, border=border)
        buf = _io.BytesIO()
        img.save(buf, format="PNG")
        return "data:image/png;base64," + _b64.b64encode(buf.getvalue()).decode("ascii")
    except Exception as exc:  # noqa: BLE001
        log.warning("生成二维码失败（前端将退化为文本提示）：%s", exc)
        return None


def wx_code_to_openid(code: str) -> str | None:
    if not WECHAT:
        return None
    qs = urllib.parse.urlencode({
        "appid": CFG["wechat"]["appid"],
        "secret": CFG["wechat"]["app_secret"],
        "code": code,
        "grant_type": "authorization_code",
    })
    try:
        with urllib.request.urlopen(
            f"https://api.weixin.qq.com/sns/oauth2/access_token?{qs}", timeout=10
        ) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        log.error("换取 openid 网络失败: %s", exc)
        return None
    if data.get("openid"):
        return data["openid"]
    log.error("换取 openid 失败: %s", data)
    return None


# ======================================================================
# 业务：创建支付
# ======================================================================
TIER_DESC = {
    "monthly": "工商真题库 单月会员",
    "yearly": "工商真题库 年度会员",
    "lifetime": "工商真题库 永久会员",
}

# ======================================================================
# 微信支付产品能力开关（2026-10-27）
# ======================================================================
# 商户号批了哪些产品权限，代码必须**跟着走**，否则就是"能点上、点了报错"。
#
# 现状（2026-10-27 实测）：
#   · JSAPI  ✅ 有权限（下单返 400 参数错误，不是权限拒绝）
#   · Native ❌ 403 无权限（申请时只勾了「服务号或公众号」场景）
#
# 补申请 Native 后，把 config.json 的 wechat.native_enabled 改成 true 即可，
# 不用改代码。
WECHAT_NATIVE_OK = bool(
    WECHAT and (CFG.get("wechat") or {}).get("native_enabled", False)
)

# H5 支付（手机浏览器跳转微信付款）—— 2026-10-30 正在申请权限。
# 审核通过后把 config 的 `wechat.h5_enabled` 改成 true 即可，不用改代码。
WECHAT_H5_OK = bool(
    WECHAT and (CFG.get("wechat") or {}).get("h5_enabled", False)
)

ALL_CHANNELS = {"wechat_jsapi", "wechat_h5", "wechat_native",
                "alipay_wap", "alipay_page", "epay"}


def is_mobile_ua(ua: str) -> bool:
    low = ua.lower()
    return any(k in low for k in ("android", "iphone", "ipad", "mobile"))


def epay_device(ua: str) -> str:
    """给易支付平台传对设备类型，它自己的收银台会据此优化展示。"""
    low = ua.lower()
    if "micromessenger" in low:
        return "wechat"
    if "alipayclient" in low:
        return "alipay"
    if "qq" in low and "mqqbrowser" in low:
        return "qq"
    return "mobile" if is_mobile_ua(ua) else "pc"


def resolve_device(ua: str, hint: str | None = None) -> tuple[str, bool]:
    """判定 (设备类型, 是否在微信里)。设备类型 ∈ "pc" / "mobile" / "tablet"。

    用户的场景要求（2026-10-30 明确）：
      · 电脑（**包括微信电脑版**）        → 微信 Native 扫码
      · iPad / 平板 · 微信内              → 微信 JSAPI
      · iPad / 平板 · 浏览器              → 微信 H5
      · 手机 · 微信内                     → 微信 JSAPI
      · 手机 · 浏览器（含所有手机浏览器） → 微信 H5

    为什么需要 hint：
      iPadOS 13 起 Safari 默认发**桌面 Mac 的 UA**（Macintosh…），只看 UA 会把它当成电脑，
      于是给学生一张二维码让另一台手机扫 —— 体验完全不对。前端会用
      `navigator.maxTouchPoints` 判出这是平板并把类型传上来。

    为什么微信电脑版要单独判：
      它的 UA 里同样带 MicroMessenger，但**JSAPI 在微信电脑版里拉不起付款面板**。
      以前 `in_wechat` 一律走 JSAPI，等于让电脑版微信的用户点了没反应。
      Windows 版 UA 带 `WindowsWechat` / `Windows NT`，Mac 版带 `MacWechat`。
    """
    low = (ua or "").lower()
    in_wechat = "micromessenger" in low

    # 微信电脑版：带 MicroMessenger，但宿主是 Windows / macOS
    pc_wechat = in_wechat and (
        "windowswechat" in low
        or "macwechat" in low
        or "windows nt" in low
        or ("macintosh" in low and "ipad" not in low)
    )
    if pc_wechat:
        return "pc", in_wechat

    # 前端给的判定优先（能覆盖 iPadOS 的桌面 UA）
    if hint in ("pc", "mobile", "tablet"):
        return hint, in_wechat

    if "ipad" in low or "tablet" in low:
        return "tablet", in_wechat
    if any(k in low for k in ("android", "iphone", "ipod", "mobile")):
        return "mobile", in_wechat
    return "pc", in_wechat


def pick_channel(ua: str, requested: str | None = None, pay_type: str | None = None,
                 device_hint: str | None = None) -> str:
    """按「设备 × 容器 × 学生选择」决定通道（2026-10-30 重写第二版）。

    决策矩阵（用户 2026-10-30 明确要求，改动前先看 `resolve_device` 的说明）：

        电脑（含微信电脑版）  → 微信 Native 扫码
        iPad / 平板 · 微信内  → 微信 JSAPI
        iPad / 平板 · 浏览器  → 微信 H5
        手机 · 微信内         → 微信 JSAPI
        手机 · 浏览器         → 微信 H5

    例外只有两个：
      · 学生**明确选了支付宝** → 不能被微信抢走，走支付宝官方（配了）或易支付；
      · H5 权限还没批下来时，手机浏览器的微信支付暂时退到 Native（给二维码兜底），
        总比"点了一直失败"好；H5 批下来后自动切过去。
    """
    if requested in ALL_CHANNELS:
        return requested

    kind, in_wechat = resolve_device(ua, device_hint)
    asked = (pay_type or "").strip().lower()

    # ── 微信内，且是真的手机/平板微信 → JSAPI（唯一正确的选择）────────────
    if in_wechat and kind != "pc":
        # 微信里跳不出支付宝，明确拒绝 —— 不要再"静默换成微信"，
        # 那会让学生以为自己选的支付宝生效了，实际付的是微信。
        if asked == "alipay":
            return "none"
        if WECHAT:
            return "wechat_jsapi"
        if EPAY and EPAY_ACTIVE and EPAY.prefer_type(in_wechat=True):
            return "epay"
        return "need_browser"

    # ── 电脑（含微信电脑版）→ Native 扫码 ──────────────────────────────────
    if kind == "pc":
        if asked == "alipay":
            if ALIPAY:
                return "alipay_page"
            if EPAY and EPAY_ACTIVE and "alipay" in EPAY.pay_types:
                return "epay"
            return "none"
        if WECHAT and WECHAT_NATIVE_OK:
            return "wechat_native"
        if EPAY and EPAY_ACTIVE:
            return "epay"
        return "none"

    # ── 手机 / 平板浏览器 ─────────────────────────────────────────────────
    #
    # 支付宝：移动端能跳转就用「手机网站支付」（alipay.trade.wap.pay），
    # 这是**支付宝官方支持个体户**的产品，和微信 H5 不一样。
    if asked == "alipay":
        if ALIPAY:
            return "alipay_wap"
        if EPAY and EPAY_ACTIVE and "alipay" in EPAY.pay_types:
            return "epay"
        return "none"

    # 微信：移动端浏览器依旧走 Native 扫码（2026-10-30 用户决定）。
    #
    # ⚠️ 为什么不再等 H5：微信官方的 H5 支付准入规则写得很死 ——
    #    「支持企业法人、党政、机关及事业单位、其他组织；**个体工商户、小微商户暂不支持**」
    #    （腾讯客服 FAQ 211124JbyEFj）。本站主体是个体工商户，**永远批不下来**，
    #    2026-10-30 实测提交即被驳回（理由：该商户类型/主体类型暂不支持申请）。
    #
    # 所以 `WECHAT_H5_OK` 与实际申请状态无关，别指望它变 true。
    # 这个开关只留给「将来主体升级为企业」那一种可能；在那之前，
    # 移动端微信支付 = 二维码（长按识别 / 另一台设备扫）。
    if WECHAT and WECHAT_NATIVE_OK:
        return "wechat_native"
    if EPAY and EPAY_ACTIVE:
        return "epay"
    return "none"


def handle_create(body: dict[str, Any], headers: dict[str, str], client_ip: str) -> tuple[int, dict]:
    order_no = (body.get("order_no") or "").strip()
    if not order_no:
        return 400, {"ok": False, "reason": "missing_order_no"}

    user_id = verify_user(headers.get("authorization", "").replace("Bearer ", ""))
    if not user_id:
        return 401, {"ok": False, "reason": "not_logged_in"}

    # 下单节流（2026-10-28）：每次下单都会打上游平台，登录用户循环调用
    # 足以把第三方通道打出风控。20 次/分钟对真人绰绰有余。
    blocked, wait = PAY_ACTION_BY_UID.blocked(f"create:{user_id}")
    if blocked:
        return 429, {"ok": False, "reason": "too_many_requests",
                     "message": f"操作太频繁，请 {wait} 秒后再试", "retry_after": wait}
    PAY_ACTION_BY_UID.fail(f"create:{user_id}")

    info = db.rpc("get_order_for_pay", {
        "p_order_no": order_no,
        "p_secret": CFG["callback_secret"],
    })
    if not info.get("ok"):
        return 400, {"ok": False, "reason": info.get("reason", "order_unavailable")}
    if info.get("user_id") != user_id:
        return 403, {"ok": False, "reason": "not_your_order"}
    if info.get("status") != "pending":
        return 409, {"ok": False, "reason": "not_pending", "status": info.get("status")}

    amount = int(info["amount_cents"])
    subject = TIER_DESC.get(info["tier"], "工商真题库 会员")
    # 学生自己选的支付方式（pay_type）必须参与渠道决策：选了支付宝就绝不能被
    # 微信 Native 抢走（2026-10-30 用户反馈）。
    channel = pick_channel(headers.get("user-agent", ""), body.get("channel"),
                           body.get("pay_type"), body.get("device"))

    if channel == "need_browser":
        # 微信内、且没配微信支付 → 让前端提示"请在浏览器打开"
        return 200, {"ok": False, "reason": "need_browser",
                     "message": "微信内无法跳转支付宝，请点右上角选择「在浏览器打开」"}
    if channel == "none":
        # 2026-10-30：易支付下线后，支付宝官方签约前，浏览器端只有微信扫码一条路。
        # 这里给一句人话，不要让学生对着「no_channel_configured」猜。
        return 503, {"ok": False, "reason": "no_channel_configured",
                     "message": "这种支付方式暂未开通，请改用微信支付（扫码或在小程序里直接付）。"}

    try:
        # ---------------- 易支付（易支付协议：跳转到它的收银台） ----------------
        if channel == "epay":
            if not EPAY_ACTIVE:
                # 内部调用（如 recheck）可能显式指定 epay；新单已不允许。
                return 409, {"ok": False, "reason": "channel_retired",
                             "message": "该支付通道已停用，请使用微信支付。"}
            ua = headers.get("user-agent", "")
            in_wechat = "micromessenger" in ua.lower()
            # 学生在前端**自己选**的支付方式优先（2026-10-21 用户要求：
            # 不能点一下方案就直接被拉进支付宝，必须先选方式再确认）。
            # 只接受配置里真实开通的 pay_type，其它一律按自动选择处理。
            asked = (body.get("pay_type") or "").strip().lower()
            if asked in ("alipay", "wxpay") and asked in EPAY.pay_types:
                want = asked
            else:
                want = None

            # 微信内置浏览器里打不开支付宝 —— 提前拦，别让学生在支付宝页面里卡住
            if want == "alipay" and in_wechat:
                return 200, {"ok": False, "reason": "need_browser",
                             "message": "微信里打不开支付宝，请选「微信支付」，"
                                        "或点右上角「在浏览器打开」后再选支付宝。"}

            pay_type = want or EPAY.prefer_type(in_wechat)
            if not pay_type:
                # 微信内、且通道没开微信 → 支付宝在微信里跳不出去
                return 200, {"ok": False, "reason": "need_browser",
                             "message": "微信内无法使用支付宝付款，请点右上角选择「在浏览器打开」"}
            # ⚠️ 平台按 out_trade_no **复用**已存在的订单，连当初选的支付方式一起复用。
            #    学生「先点了支付宝、退回来改微信」时，平台还是会把他带回支付宝
            #    （2026-10-21 实测：同一 out_trade_no 先 alipay 后 wxpay，两次都进支付宝）。
            #    所以学生**明确指定**方式时，给平台单号加一个方式后缀，让它按方式各建一单；
            #    回调里再把这个后缀剥掉，映射回我们自己的订单号（见 normalize_out_trade_no）。
            plat_no = f"{order_no}-{want}" if want else order_no
            url = EPAY.pay_url(
                plat_no, amount, subject,
                pay_type=pay_type, device=epay_device(ua),
                param=order_no,          # 双保险：平台会原样回传 param
            )
            db.rpc("attach_prepay", {"p_order_no": order_no, "p_code_url": "epay",
                                     "p_provider": "epay", "p_secret": CFG["callback_secret"]})
            return 200, {"ok": True, "channel": "epay", "pay_url": url,
                         "pay_type": pay_type, "amount_cents": amount,
                         "order_no": order_no}

        # ---------------- 支付宝 ----------------
        if channel == "alipay_wap":
            url = ALIPAY.create_wap_pay(order_no, amount, subject,
                                        quit_url=body.get("quit_url", ""))
            db.rpc("attach_prepay", {"p_order_no": order_no, "p_code_url": "alipay_wap",
                                     "p_provider": "alipay", "p_secret": CFG["callback_secret"]})
            return 200, {"ok": True, "channel": "alipay_wap", "pay_url": url,
                         "amount_cents": amount, "order_no": order_no}

        if channel == "alipay_page":
            url = ALIPAY.create_page_pay(order_no, amount, subject)
            db.rpc("attach_prepay", {"p_order_no": order_no, "p_code_url": "alipay_page",
                                     "p_provider": "alipay", "p_secret": CFG["callback_secret"]})
            return 200, {"ok": True, "channel": "alipay_page", "pay_url": url,
                         "amount_cents": amount, "order_no": order_no}

        # ---------------- 微信 ----------------
        if channel == "wechat_jsapi":
            openid = (body.get("openid") or "").strip()
            if not openid:
                # 2026-10-27：**必须留日志**。之前只记 HTTP 400 不记 reason，
                # 排查"点了没反应"时完全看不出是缺 openid、缺单号还是通道没开，
                # 白查了一轮。以后 400 都要能在日志里看到原因。
                log.warning("下单被拒：缺 openid（订单 %s，微信内 JSAPI）", order_no)
                return 400, {"ok": False, "reason": "need_openid"}
            resp = WECHAT.create_jsapi(order_no, amount, subject, openid)
            params = WECHAT.build_jsapi_pay_params(resp["prepay_id"])
            db.rpc("attach_prepay", {"p_order_no": order_no, "p_code_url": "jsapi",
                                     "p_provider": "wechat", "p_secret": CFG["callback_secret"]})
            return 200, {"ok": True, "channel": "wechat_jsapi", "jsapi": params,
                         "amount_cents": amount, "order_no": order_no}

        if channel == "wechat_h5":
            # 支付完成后微信把学生送回会员页（否则会落在微信的默认页上）
            back = str(CFG.get("site_origin") or "https://louisnb.cn").rstrip("/")
            resp = WECHAT.create_h5(order_no, amount, subject, client_ip,
                                    redirect_url=f"{back}/#/membership")
            db.rpc("attach_prepay", {"p_order_no": order_no, "p_code_url": resp["h5_url"],
                                     "p_provider": "wechat", "p_secret": CFG["callback_secret"]})
            return 200, {"ok": True, "channel": "wechat_h5", "h5_url": resp["h5_url"],
                         "amount_cents": amount, "order_no": order_no}

        if channel == "wechat_native":
            # 🔴 2026-10-27：没有 Native 权限时**直接拒绝**，不要往下走。
            # 否则学生点了微信支付，我们调微信接口拿 403，前端只能显示"付款失败"，
            # 而真实原因是"这个产品权限还没批下来" —— 那种提示毫无意义。
            # 给出可执行的指引：微信内付款，或等 Native 权限。
            if not WECHAT_NATIVE_OK:
                log.warning("下单被拒：Native 权限未开通（订单 %s）", order_no)
                return 400, {
                    "ok": False,
                    "reason": "native_not_enabled",
                    "message": "扫码支付暂未开通，请在微信内打开本页面付款。",
                }
            code_url = info.get("code_url")
            if not code_url or not code_url.startswith("weixin://"):
                resp = WECHAT.create_native(order_no, amount, subject)
                code_url = resp["code_url"]
                db.rpc("attach_prepay", {"p_order_no": order_no, "p_code_url": code_url,
                                         "p_provider": "wechat", "p_secret": CFG["callback_secret"]})
            # ⚠️ code_url 是 `weixin://wxpay/bizpayurl?pr=xxx` —— 不能直接当链接跳，
            # 必须渲染成二维码让学生用微信扫。原来只返回 code_url 字符串，
            # 前端拿到也没法用（点不动、也没图），等于不可用。
            # 这里直接返回 PNG 的 dataURL，前端 <img src> 就能显示。
            out_native = {"ok": True, "channel": "wechat_native", "code_url": code_url,
                          "amount_cents": amount, "order_no": order_no}
            qr = qr_data_url(code_url)
            if qr:
                out_native["qr_image"] = qr
            return 200, out_native

        return 400, {"ok": False, "reason": "unsupported_channel"}

    except Exception as exc:  # noqa: BLE001
        log.error("下单失败 order=%s channel=%s err=%s", order_no, channel, exc)
        return 502, {"ok": False, "reason": "channel_error", "detail": str(exc)}


# ======================================================================
# 开通会员（两个渠道共用）
# ======================================================================
_LAST_ALERT_MAIL = 0.0
_ALERT_MAIL_GAP = 600          # 同类告警 10 分钟内只发一封，别把管理员信箱刷爆


def alert_payment(kind: str, order_no: str, detail: dict) -> None:
    """支付异常留痕 + 通知管理员（2026-10-28）。

    以前"钱到了但会员没开通"只在 journal 里留一行 error，而 journal 没人天天翻。
    现在落一行结构化记录到 payment_alerts，并给管理员发一封邮件。

    全部 best-effort：告警失败绝不能让回调本身失败（回滚/重试才是更大的灾难）。
    """
    global _LAST_ALERT_MAIL
    try:
        db.execute(
            "insert into public.payment_alerts (kind, order_no, detail) values (%s, %s, %s)",
            [kind, order_no, json.dumps(detail, ensure_ascii=False)])
    except Exception as e:  # noqa: BLE001
        log.warning("支付告警落库失败（不影响主流程）：%s", e)

    now = time.time()
    if now - _LAST_ALERT_MAIL < _ALERT_MAIL_GAP:
        return
    to = str(CFG.get("alert_email") or CFG.get("admin_email") or "")
    if not to or not MAIL_ON:
        return
    _LAST_ALERT_MAIL = now
    try:
        body = (f"订单 {order_no}\n类型 {kind}\n"
                f"详情 {json.dumps(detail, ensure_ascii=False)[:1500]}\n\n"
                "处理建议：到支付平台后台核对这笔的实收金额与状态；\n"
                "确认已收款的话，在后台「订单」里手工开通，并记下原因。")
        ok, err = mailer.send_plain(to, "【真题库】支付异常，需要人工核对", body)
        if not ok:
            log.warning("支付告警邮件发送失败：%s", err)
    except Exception as e:  # noqa: BLE001
        log.warning("支付告警邮件异常：%s", e)


def grant(order_no: str, txn_id: str, paid_cents: int | None,
          provider: str, payload: dict) -> tuple[int, dict]:
    """调用数据库里的幂等开通函数。返回 (HTTP 状态, 回执)"""
    rpc_payload: dict[str, Any] = {
        "p_order_no": order_no,
        "p_transaction_id": txn_id,
        "p_paid_cents": paid_cents,
        "p_provider": provider,
        "p_secret": CFG["callback_secret"],
        # ⚠️ p_payload 必须是 **JSON 字符串**，不能传 dict。
        # psycopg2 不知道怎么把 dict 适配成 jsonb，会抛
        # `can't adapt type 'dict'` → 回调 500 → 平台一直重试、会员永远不开通。
        # 2026-10-21 实测踩到（之前从未真正跑过回调，所以一直没暴露）。
        "p_payload": json.dumps(payload, ensure_ascii=False),
    }
    # 只有配了容差才传这两个参数 —— 这样数据库那边没升级也能正常跑
    tol_cents, tol_ppm = CHANNEL_TOLERANCE.get(provider, (0, 0))
    if tol_cents or tol_ppm:
        rpc_payload["p_tolerance_cents"] = tol_cents
        rpc_payload["p_tolerance_ppm"] = tol_ppm
        log.info("渠道 %s 金额容差：下限 %s 分 + 比例 %s ppm（实收 %s 分）",
                 provider, tol_cents, tol_ppm, paid_cents)

    try:
        result = db.rpc("confirm_payment_auto", rpc_payload)

        # ---- 迟付补开通（2026-10-28）----
        # 订单 30 分钟后会被 expire_stale_orders 改成 expired，但学生完全可能
        # 在第 31 分钟才在收银台点完（页面开着、扫码慢了）。这时 confirm 会回
        # not_pending —— 钱真的到了，会员却永远不开。
        # 处置：把这个订单临时改回 pending 再走一次幂等开通（只给 24 小时内的单）。
        if (not result.get("ok")
                and result.get("reason") == "not_pending"
                and result.get("status") == "expired"):
            reopened = db.execute(
                "update public.payment_orders set status = 'pending'"
                " where order_no = %s and status = 'expired'"
                "   and created_at > now() - interval '24 hours'"
                " returning order_no", [order_no])
            if reopened:
                log.warning("迟付订单重新打开 order=%s provider=%s 金额=%s",
                            order_no, provider, paid_cents)
                alert_payment("late_payment", order_no, {
                    "provider": provider, "paid_cents": paid_cents, "txn": txn_id})
                result = db.rpc("confirm_payment_auto", rpc_payload)
    except Exception as exc:  # noqa: BLE001
        # 回 5xx 让渠道按自己策略重试（我们是幂等的，重试安全）
        log.error("开通会员失败 order=%s err=%s", order_no, exc)
        alert_payment("grant_error", order_no, {"provider": provider, "error": str(exc)[:300]})
        return 500, {"ok": False, "reason": "internal_error"}

    if result.get("ok"):
        log.info("支付成功并开通 order=%s txn=%s tier=%s reason=%s",
                 order_no, txn_id, result.get("tier"), result.get("reason"))
    else:
        # 业务拒绝：记一笔 + 给管理员发信（回执由调用方决定，见各 notify 的注释）
        log.error("回调被业务拒绝 order=%s result=%s", order_no, result)
        alert_payment("callback_rejected", order_no, {
            "provider": provider, "paid_cents": paid_cents,
            "txn": txn_id, "result": result})
    return 200, result


# ======================================================================
# 支付宝异步通知
# ======================================================================
def handle_notify_alipay(form: dict[str, list[str]]) -> tuple[int, str]:
    """支付宝异步通知是 form-urlencoded（值可能被 url-encode 过）。

    回执要求：成功回纯文本 "success"，失败回 "failure"，否则支付宝会重试 25 小时。
    """
    flat = {k: (v[0] if isinstance(v, list) and v else "") for k, v in form.items()}

    try:
        ALIPAY.verify_notify(flat)
    except Exception as exc:  # noqa: BLE001
        log.warning("支付宝通知验签失败：%s", exc)
        return 400, "failure"

    trade_status = flat.get("trade_status")
    order_no = flat.get("out_trade_no")
    txn_id = flat.get("trade_no")

    if trade_status not in ("TRADE_SUCCESS", "TRADE_FINISHED"):
        log.info("忽略非成功状态 %s（订单 %s）", trade_status, order_no)
        return 200, "success"

    if not order_no:
        log.warning("支付宝通知缺少 out_trade_no")
        return 400, "failure"

    # total_amount 是「元」的字符串，转成分再比对
    try:
        paid_cents = int(round(float(flat.get("total_amount", "0")) * 100))
    except (TypeError, ValueError):
        log.warning("支付宝通知金额格式异常：%s", flat.get("total_amount"))
        return 400, "failure"

    # 只留必要字段做留档，避免把整包敏感信息写进库
    payload = {k: flat.get(k) for k in (
        "trade_no", "out_trade_no", "trade_status", "total_amount",
        "receipt_amount", "buyer_id", "gmt_payment", "app_id",
    ) if flat.get(k)}

    status, result = grant(order_no, txn_id or "", paid_cents, "alipay", payload)
    # 同易支付：业务拒绝也回 success（否则平台 25 小时内一直重发，而结果不会变），
    # 但已经写进 payment_alerts 并给管理员发信。2026-10-28
    if status != 200:
        return 500, "failure"
    return 200, "success"


# ======================================================================
# 微信支付回调
# ======================================================================
def handle_notify_wechat(headers: dict[str, str], raw_body: str) -> tuple[int, dict]:
    try:
        WECHAT.verify_notify(headers, raw_body)
    except Exception as exc:  # noqa: BLE001
        log.warning("微信回调验签失败：%s", exc)
        return 401, {"code": "FAIL", "message": "验签失败"}

    try:
        envelope = json.loads(raw_body)
    except json.JSONDecodeError:
        return 400, {"code": "FAIL", "message": "报文不是合法 JSON"}

    if envelope.get("event_type") != "TRANSACTION.SUCCESS":
        log.info("忽略非成功事件：%s", envelope.get("event_type"))
        return 200, {"code": "SUCCESS", "message": "成功"}

    try:
        tx = WECHAT.decrypt_resource(envelope.get("resource") or {})
    except Exception as exc:  # noqa: BLE001
        log.error("微信回调解密失败：%s", exc)
        return 400, {"code": "FAIL", "message": "解密失败"}

    order_no = tx.get("out_trade_no")
    if not order_no or tx.get("trade_state") != "SUCCESS":
        log.warning("微信回调内容异常 order=%s state=%s", order_no, tx.get("trade_state"))
        return 200, {"code": "SUCCESS", "message": "成功"}

    paid = (tx.get("amount") or {}).get("total")
    status, _r = grant(order_no, tx.get("transaction_id") or "",
                       int(paid) if paid is not None else None, "wechat", tx)
    if status == 200:
        return 200, {"code": "SUCCESS", "message": "成功"}
    return 500, {"code": "FAIL", "message": "内部错误，请重试"}


# ======================================================================
# 易支付异步通知（易支付协议）
# ======================================================================
def normalize_out_trade_no(s: str) -> str:
    """平台单号 → 我们自己的订单号。

    学生明确选了支付方式时，下单用的是 `订单号-wxpay` / `订单号-alipay`
    （见 handle_create 里的说明：平台会按 out_trade_no 锁住支付方式）。
    回调必须把后缀剥掉，否则对不上 orders.order_no，会员永远开不通。
    我们的订单号形如 CTBU20261021XXXXXXXX，不会以 -alipay/-wxpay 结尾。
    """
    for suf in ("-alipay", "-wxpay"):
        if s.endswith(suf):
            return s[: -len(suf)]
    return s


def handle_notify_epay(params: dict[str, str]) -> tuple[int, str]:
    """易支付的异步通知。GET 与 POST 都可能来（后台可设成只发 POST）。

    回执要求：成功回纯文本 "success"，其余回 "fail"（平台会重试）。
    """
    passed, why = EPAY.verify_notify(params)
    if not passed:
        log.warning("易支付通知验签失败：%s", why)
        return 400, "fail"

    order_no = normalize_out_trade_no((params.get("out_trade_no") or "").strip())
    trade_status = params.get("trade_status")

    # 只有 TRADE_SUCCESS 才算成功；其他状态照回 success 让它别再重发
    if trade_status and trade_status != "TRADE_SUCCESS":
        log.info("忽略易支付非成功状态 %s（订单 %s）", trade_status, order_no)
        return 200, "success"

    if not order_no:
        log.warning("易支付通知缺少 out_trade_no")
        return 400, "fail"

    try:
        paid_cents = EPAY.to_cents(params.get("money"))
    except Exception as exc:  # noqa: BLE001
        log.warning("易支付通知金额无法解析：%r（%s）", params.get("money"), exc)
        return 400, "fail"

    payload = {k: params.get(k) for k in (
        "pid", "trade_no", "out_trade_no", "trade_status", "type", "money", "param",
    ) if params.get(k)}

    status, result = grant(order_no, params.get("trade_no") or "",
                           paid_cents, "epay", payload)
    # 2026-10-28 统一回执语义：
    #   · 内部错误（连库都写不进去）→ 5xx，让平台重试（我们是幂等的，重试安全）
    #   · 业务拒绝（金额不符 / 订单不存在）→ 回 success 止损。
    #     原来这里回 500，平台会按策略重试几十次，日志里只有一行"回调被业务拒绝"，
    #     学生钱付了、会员不开，谁也不知道。现在同时写 payment_alerts 并给管理员发信。
    if status != 200:
        return 500, "fail"
    return 200, "success"


# ======================================================================
# 主动查单兜底：回调丢了 / 没配好回调时，学生也能拿到会员
# ======================================================================
# ======================================================================
# 通道在线探测（2026-10-23）
# ======================================================================
# 「配置里写了某种支付方式」≠「平台那边真有收款账号在线」。
# 后者只能现场问平台 —— 它会在下单时回「没有找到可用支付账号」。
#
# 代价：每次探针会在平台侧留下一笔 SELFTEST 空订单（待支付→超时），
# 会轻微拉低平台的"成功率"统计。所以**必须缓存**，不能每次页面加载都探。
_PAY_LIVE_CACHE: dict[str, Any] = {"at": 0.0, "data": {}}
_PAY_LIVE_TTL = 90  # 秒
_pay_live_lock = threading.Lock()


def _channel_liveness() -> dict[str, tuple[bool, str]]:
    """返回 {pay_type: (是否在线, 原因)}。带 90 秒缓存。

    探针失败（网络异常等）一律当作"在线" —— 宁可让学生点一下再报错，
    也不要因为一次网络抖动就把整条通道从界面上藏掉。

    2026-10-30：易支付已不作为新单渠道（`EPAY_ACTIVE=False`），这里直接返回空 ——
    不再往平台打探测单（每 90 秒留一条 LIVENESS 垃圾单，人家也不欢迎）。
    """
    if not EPAY or not EPAY_ACTIVE:
        return {}
    now = time.time()
    with _pay_live_lock:
        if now - float(_PAY_LIVE_CACHE["at"]) < _PAY_LIVE_TTL and _PAY_LIVE_CACHE["data"]:
            return dict(_PAY_LIVE_CACHE["data"])

    out: dict[str, tuple[bool, str]] = {}
    for t in EPAY.pay_types:
        probe_no = f"LIVENESS{int(now)}{t[:2]}"
        try:
            r = EPAY.create_order(probe_no, 1, "通道探测", pay_type=t)
        except Exception as exc:  # noqa: BLE001
            # 判据（2026-10-23 修，别再改回"看字符串"）：
            #   ① EpayError(code='no_pay_url') 且平台回执 code=1
            #      → **通道是通的**。云熠的 mapi.php 对微信只回
            #        {code:1, msg:success, trade_no, money}，不给 payurl/qrcode，
            #        因为微信走的是页面方式。原来的写法把这当成失败，
            #        导致网站上「微信支付」被误灰掉（学生实际能付）。
            #   ② 平台明确说"没有找到可用支付账号" → 真的不可用
            #   ③ 其它（超时/网络/解析）→ 保守放行，别因一次抖动藏掉通道
            from epay import EpayError  # 局部导入，避免模块级循环依赖
            code = getattr(exc, "code", "")
            raw = getattr(exc, "raw", None)
            if code == "no_pay_url" and isinstance(raw, dict) and str(raw.get("code")) == "1":
                out[t] = (True, "")
                continue
            msg = str(exc)
            if "可用支付账号" in msg or "没有找到" in msg:
                out[t] = (False, msg[:40])
            else:
                log.info("通道探测异常（放行）%s: %s", t, msg[:80])
                out[t] = (True, "")
            continue
        if str(r.get("code")) == "1":
            out[t] = (True, "")
        else:
            out[t] = (False, str(r.get("msg") or "该收款方式当前不可用")[:40])

    with _pay_live_lock:
        _PAY_LIVE_CACHE["at"] = now
        _PAY_LIVE_CACHE["data"] = dict(out)
    log.info("通道在线探测：%s", {k: ("在线" if v[0] else "离线 " + v[1]) for k, v in out.items()})
    return out


def query_order_variants(order_no: str) -> tuple[bool, dict | None]:
    """查单：我们的订单号在平台上可能有两种写法。

    学生明确选了支付方式时，下单用的是 `订单号-wxpay` / `订单号-alipay`
    （见 handle_create 的说明）。所以查单要把三种写法都试一遍：
      默认单号 → -alipay → -wxpay
    找到一笔已付就立刻返回；都没付就把查到的第一笔原样带回（供上层判断）。

    返回 (是否已付, 平台回执 or None)。
    回执 None **只**表示三次查询全部在传输层失败（网络/接口挂了）。
    「平台上没有这笔单」不算失败 —— 那是"学生还没付"，回执会带着 code=0 一起返回，
    上层据此回 pending，而不是把红字拍在学生脸上。
    """
    first: dict | None = None
    for cand in (order_no, f"{order_no}-alipay", f"{order_no}-wxpay"):
        try:
            paid, ret = EPAY.is_paid(order_no=cand)
        except Exception as exc:  # noqa: BLE001
            log.warning("主动查单出错 order=%s err=%s", cand, exc)
            continue
        if paid:
            return True, ret
        first = first or ret       # code=0（没有这笔单）也留着，代表"查过了、没付"
    return False, first


def query_order_by_provider(order_no: str) -> tuple[bool, dict | None, str]:
    """按订单**实际走的渠道**去对应平台查单（2026-10-30）。

    为什么需要：`query_order_variants` 只问易支付。支付宝/微信的单子在这里
    永远得到"平台上没有这笔" → 回 pending → 学生真付了钱也开不通。
    平时靠异步回调能补上，但回调会丢（网络抖动、服务重启、nginx 502），
    那时"点我已完成付款"就是唯一的自救手段，它必须是准的。

    返回 (是否已付, 平台回执, 渠道名)。回执 None 只表示该渠道查不通。
    """
    provider = None
    try:
        rows = db.execute(
            "select provider from payment_orders where order_no = %s", [order_no])
        if rows:
            provider = (rows[0].get("provider") or "").strip() or None
    except Exception as exc:  # noqa: BLE001
        log.warning("查单读 provider 失败 order=%s err=%s", order_no, exc)

    if provider == "wechat" and WECHAT:
        try:
            r = WECHAT.query_order(order_no)
            state = (r.get("trade_state") or "").upper()
            return state == "SUCCESS", r, "wechat"
        except Exception as exc:  # noqa: BLE001
            log.warning("微信查单失败 order=%s err=%s", order_no, exc)
            return False, None, "wechat"

    if provider == "alipay" and ALIPAY:
        try:
            r = ALIPAY.query_trade(order_no)
            # code != 10000 = 业务失败（含 ACQ.TRADE_NOT_EXIST 交易不存在）→ 当作未付
            if r.get("code") not in (None, "10000"):
                return False, r, "alipay"
            return ALIPAY.is_trade_success(r), r, "alipay"
        except Exception as exc:  # noqa: BLE001
            log.warning("支付宝查单失败 order=%s err=%s", order_no, exc)
            return False, None, "alipay"

    # 易支付（历史订单）或 provider 缺失时，退回老三样试单号
    paid, ret = query_order_variants(order_no)
    return paid, ret, "epay"


def handle_recheck(body: dict[str, Any], headers: dict[str, str]) -> tuple[int, dict]:
    """学生点「我已付款」时调这个：我们主动问平台这笔订单到底付没付。

    只查不判：查到已付才开通；没查到就如实回未付，等回调或人工处理。
    """
    if not EPAY:
        return 503, {"ok": False, "reason": "epay_not_configured"}

    order_no = (body.get("order_no") or "").strip()
    if not order_no:
        return 400, {"ok": False, "reason": "missing_order_no"}

    user_id = verify_user(headers.get("authorization", "").replace("Bearer ", ""))
    if not user_id:
        return 401, {"ok": False, "reason": "not_logged_in"}

    # 查单节流（2026-10-28）：一次 recheck 会按 3 个候选单号各打一次上游，
    # 是天然的放大器。真人点「我已完成付款」不会一分钟点十几次。
    blocked, wait = RECHECK_BY_UID.blocked(user_id)
    if blocked:
        return 429, {"ok": False, "reason": "too_many_requests",
                     "message": f"核对太频繁，请 {wait} 秒后再试，或等自动到账",
                     "retry_after": wait}
    RECHECK_BY_UID.fail(user_id)

    info = db.rpc("get_order_for_pay", {
        "p_order_no": order_no, "p_secret": CFG["callback_secret"],
    })
    if not info.get("ok"):
        return 400, {"ok": False, "reason": info.get("reason", "order_unavailable")}
    if info.get("user_id") != user_id:
        return 403, {"ok": False, "reason": "not_your_order"}
    if info.get("status") == "paid":
        return 200, {"ok": True, "status": "paid", "reason": "already_paid"}

    paid, result, via = query_order_by_provider(order_no)
    if result is None:
        return 502, {"ok": False, "reason": "query_failed"}

    if not paid:
        return 200, {"ok": True, "status": "pending", "reason": "not_paid_yet"}

    # 各渠道的回执字段不一样，金额单位也不一样（支付宝是元、微信是分）
    if via == "alipay":
        try:
            paid_cents = int(round(float(result.get("total_amount", "0")) * 100))
        except (TypeError, ValueError):
            paid_cents = None
        txn_id = result.get("trade_no") or ""
        payload = {"source": "recheck", "trade_no": txn_id,
                   "out_trade_no": result.get("out_trade_no"),
                   "total_amount": result.get("total_amount"),
                   "trade_status": result.get("trade_status")}
    elif via == "wechat":
        amt = (result.get("amount") or {}).get("total")
        paid_cents = int(amt) if amt is not None else None
        txn_id = result.get("transaction_id") or ""
        payload = {"source": "recheck", "trade_no": txn_id,
                   "out_trade_no": result.get("out_trade_no"),
                   "trade_state": result.get("trade_state")}
    else:
        try:
            paid_cents = EPAY.to_cents(result.get("money"))
        except Exception:  # noqa: BLE001
            paid_cents = None
        txn_id = result.get("trade_no") or ""
        payload = {"source": "recheck", "trade_no": result.get("trade_no"),
                   "out_trade_no": result.get("out_trade_no"),
                   "money": result.get("money"),
                   "status": result.get("status")}

    status, grant_result = grant(order_no, txn_id, paid_cents, via, payload)
    if status != 200 or not grant_result.get("ok"):
        return 502, {"ok": False, "reason": "grant_failed", "detail": grant_result}

    return 200, {"ok": True, "status": "paid",
                 "reason": grant_result.get("reason", "granted"),
                 "tier": grant_result.get("tier")}


# ======================================================================
# HTTP 层
# ======================================================================
class _BadRequest(Exception):
    """请求本身不合法（体超限 / 长度头非法 / 编码不对）。

    单独定义一个异常，是为了让 do_GET/do_POST 的统一兜底能把它翻译成
    一条结构化的 JSON 错误，而不是像以前那样让 ValueError 冒到
    BaseHTTPRequestHandler，客户端拿到的是"连接被重置"、日志里一段 traceback。
    """

    def __init__(self, status: int, reason: str, message: str = ""):
        super().__init__(reason)
        self.status = status
        self.reason = reason
        self.message = message


class Handler(BaseHTTPRequestHandler):
    server_version = "ctbu-pay/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        log.info("%s - %s", self.address_string(), fmt % args)

    # JSON 接口的请求体上限。所有正常的 JSON 请求都在几 KB 以内，
    # 64KB 已经非常宽松；上传走 _handle_admin_upload 自己的流式通道，不经这里。
    MAX_JSON_BODY = 64 * 1024

    def _read_body(self, max_bytes: int | None = None) -> str:
        """读 JSON 请求体，带大小上限与类型校验（2026-10-28 加固）。

        原来直接 `int(Content-Length)` + `read(length)`：
          · 头不是数字 → ValueError → 连接被重置
          · 没有上限 → 一个超大 body 在 2G 内存的机器上直接读进来
        """
        limit = max_bytes or self.MAX_JSON_BODY
        raw_len = (self.headers.get("Content-Length") or "0").strip()
        try:
            length = int(raw_len)
        except (TypeError, ValueError):
            raise _BadRequest(400, "bad_content_length", "Content-Length 不是合法数字") from None
        if length < 0:
            raise _BadRequest(400, "bad_content_length", "Content-Length 不能为负")
        if length > limit:
            raise _BadRequest(413, "body_too_large",
                              f"请求体过大（上限 {limit // 1024} KB）")
        if length == 0:
            return ""
        data = self.rfile.read(length)
        try:
            return data.decode("utf-8")
        except UnicodeDecodeError:
            raise _BadRequest(400, "bad_encoding", "请求体必须是 UTF-8") from None

    def _safe_handle(self, route) -> None:
        """所有路由的统一兜底（2026-10-28）。

        以前未捕获的异常会直接冒到 BaseHTTPRequestHandler：客户端看到连接被重置，
        日志里一段 traceback，既没有 trace_id 也没法按路径定位。
        现在统一成 JSON + 一个 trace_id，日志里能 grep 到同一条。
        """
        try:
            route()
        except _BadRequest as exc:
            self._json(exc.status, {"ok": False, "reason": exc.reason,
                                    "message": exc.message or exc.reason})
        except (BrokenPipeError, ConnectionResetError):
            # 用户中途关页面/切网络，属于正常现象，不值得一条 traceback
            log.info("客户端提前断开：%s", self.path)
        except Exception:  # noqa: BLE001
            trace_id = secrets.token_hex(4)
            log.exception("未捕获异常 trace_id=%s path=%s", trace_id, self.path)
            try:
                self._json(500, {"ok": False, "reason": "internal_error",
                                 "message": "服务暂时不可用，请稍后重试。若持续出现，请把错误码发给站长。",
                                 "trace_id": trace_id})
            except Exception:  # noqa: BLE001
                pass

    def _json(self, status: int, payload: dict, no_cache: bool = False) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        if no_cache:
            # 验证码必须每次都是新的：否则浏览器/代理缓存会给同一张图，
            # 而那张图的答案在服务端已消费 → 用户怎么输都失败。
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def _text(self, status: int, body: str) -> None:
        data = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _lower_headers(self) -> dict[str, str]:
        return {k.lower(): v for k, v in self.headers.items()}

    def _flat(self, qs: dict[str, list[str]]) -> dict[str, str]:
        return {k: (v[0] if isinstance(v, list) and v else "") for k, v in qs.items()}

    def do_GET(self) -> None:  # noqa: N802
        self._safe_handle(self._route_get)

    def do_POST(self) -> None:  # noqa: N802
        self._safe_handle(self._route_post)

    def _route_get(self) -> None:
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == "/api/pay/health":
            # 2026-10-28：原来这里匿名暴露「哪些渠道已配、易支付有几个支付方式」，
            # 对排查没帮助，对探测很有帮助。对外只留一句 ok，细节需要登录。
            if self._bearer_uid():
                self._json(200, {
                    "ok": True, "service": "ctbu-pay",
                    "channels": {
                        "epay": EPAY is not None,
                        "alipay": ALIPAY is not None,
                        "wechat": WECHAT is not None,
                    },
                })
            else:
                self._json(200, {"ok": True, "service": "ctbu-pay"})
            return

        # 前端「选支付方式」用：告诉它现在真的能用哪几种，别把不可用的摆出来
        if parsed.path == "/api/pay/channels":
            ua = self.headers.get("User-Agent", "")
            _qs = urllib.parse.parse_qs(parsed.query)
            hint = ((_qs.get("device") or [""])[0] or "").strip().lower()
            kind, in_wechat_raw = resolve_device(ua, hint)
            # 只有"手机/平板 + 微信内"才走 JSAPI；微信**电脑版**按电脑处理（走 Native）
            wx_jsapi = in_wechat_raw and kind != "pc"
            methods: list[dict] = []

            if wx_jsapi:
                # 微信内（手机/平板）：只有 JSAPI 一条路
                if WECHAT:
                    methods.append({"id": "wxpay", "label": "微信支付", "available": True,
                                    "note": "点击后直接唤起微信付款", "_skip_probe": True})
                methods.append({"id": "alipay", "label": "支付宝", "available": False,
                                "note": "微信内无法跳转支付宝，请在浏览器中打开"})
            else:
                # 电脑（含微信电脑版）→ 扫码；手机/平板浏览器 → H5
                if kind == "pc":
                    if WECHAT and WECHAT_NATIVE_OK:
                        methods.append({"id": "wxpay", "label": "微信支付", "available": True,
                                        "note": "微信扫码支付", "_skip_probe": True})
                else:
                    # 手机/平板浏览器：微信只有二维码一条路（H5 对个体户永久不可用，
                    # 见 pick_channel 里的说明）。文案要提示"长按识别"，
                    # 因为手机用户没法扫自己屏幕上的码。
                    if WECHAT and WECHAT_NATIVE_OK:
                        methods.append({"id": "wxpay", "label": "微信支付", "available": True,
                                        "note": "扫码或长按识别", "_skip_probe": True})
                # 支付宝：配了官方就用官方，否则看易支付那边开没开
                if ALIPAY:
                    methods.append({"id": "alipay", "label": "支付宝", "available": True,
                                    "note": "跳转支付宝付款", "_skip_probe": True})
                elif EPAY and EPAY_ACTIVE and "alipay" in EPAY.pay_types:
                    methods.append({"id": "alipay", "label": "支付宝", "available": True,
                                    "raw": True, "note": ""})

            # 内部字段（_skip_probe / raw）不能下发给前端
            for m in methods:
                m.pop("_skip_probe", None)
                m.pop("raw", None)
            # `in_wechat` 语义保持"要不要走微信内授权链"：
            # 微信电脑版虽然也带 MicroMessenger，但走 Native，不需要 openid，
            # 所以这里对电脑版返回 false，前端就不会去跳 OAuth。
            self._json(200, {"ok": True, "in_wechat": wx_jsapi, "device": kind,
                             "methods": [m for m in methods if m["available"]],
                             "all": methods})
            return

        # 易支付协议通知：GET 与 POST 都可能（不同平台默认不同）。
        if parsed.path == "/api/pay/notify/epay":
            if not EPAY:
                self._text(503, "fail")
                return
            status, text = handle_notify_epay(
                self._flat(urllib.parse.parse_qs(parsed.query, keep_blank_values=True))
            )
            self._text(status, text)
            return

        if parsed.path == "/api/pay/wx-openid":
            qs = urllib.parse.parse_qs(parsed.query)
            code = (qs.get("code") or [""])[0]
            if not code:
                self._json(400, {"ok": False, "reason": "missing_code"})
                return
            if not WECHAT:
                self._json(503, {"ok": False, "reason": "wechat_not_configured"})
                return
            openid = wx_code_to_openid(code)
            self._json(200 if openid else 400,
                       {"ok": bool(openid), "openid": openid} if openid
                       else {"ok": False, "reason": "oauth_failed"})
            return

        # ---- 微信内 JSAPI 支付：拿网页授权地址（前端跳过去，回来带 code）----
        # 为什么要服务端生成：AppSecret 不能下发到前端，签名/拼串也在服务端做。
        if parsed.path == "/api/pay/my-openid":
            status, payload = my_wx_openid(self._lower_headers())
            self._json(status, payload)
            return

        if parsed.path == "/api/pay/wx-oauth-url":
            if not WECHAT:
                self._json(503, {"ok": False, "reason": "wechat_not_configured"})
                return
            # 🔴 2026-10-27 修：**redirect_uri 绝对不能带 hash**。
            #
            # 事故现场：原来 redirect_uri = `https://louisnb.cn/#/membership`。
            # 微信对这个带 fragment 的地址处理不可靠 —— 实测回调后落到了根路径，
            # code 变成 `https://louisnb.cn/?code=xxx`。而前端获取 openid 的逻辑
            # 当时只写在**会员页组件**里，落在首页时组件没挂载 → code 白白丢掉 →
            # 点支付又跳授权 → 日志里出现 7 次「create 400 + wx-oauth-url 200」，
            # 却**一次 `wx-openid` 请求都没有**（用户原话："点了就刷新，付不了"）。
            #
            # 现在：redirect_uri 用干净的根路径，code 一定落在 `?` 里（search 能读到）；
            # 前端在 **App 全局**捕获 code 换 openid，再跳回会员页。
            #
            # `back` 参数保留但只用于前端跳转，不再拼进 redirect_uri。
            qs = urllib.parse.parse_qs(parsed.query)
            back = (qs.get("back") or ["/#/membership"])[0]
            # 只允许站内相对路径，防开放重定向
            if not back.startswith("/") or back.startswith("//"):
                back = "/#/membership"
            host = self.headers.get("Host") or "louisnb.cn"
            redirect_uri = urllib.parse.quote(f"https://{host}/", safe="")
            # state 带上"回到哪一页"，回调后前端据此跳回（微信 state ≤128 字节）
            state = urllib.parse.quote(back, safe="")
            url = ("https://open.weixin.qq.com/connect/oauth2/authorize"
                   f"?appid={WECHAT.appid}"
                   f"&redirect_uri={redirect_uri}"
                   f"&response_type=code&scope=snsapi_base&state={state}"
                   "#wechat_redirect")
            self._json(200, {"ok": True, "url": url})
            return

        # ---- 四六级全卷：领取答案解析（会员专享）----
        # ⚠️ 这是 **GET**：放在这个 do_GET 里。曾经误加进 do_POST，
        #    结果请求一路走到末尾的 404（自测时立刻暴露）。
        if parsed.path == "/api/pay/cet-explain":
            self._handle_cet_explain(parsed)
            return

        # ---- 四六级全卷：领取「原题+答案解析」PDF 的签名链接（会员专享）----
        # ⚠️ 同样是 **GET**，放在 do_GET 里（写成 POST 会一路走到末尾 404，踩过）。
        if parsed.path == "/api/pay/cet-solution-url":
            self._handle_cet_solution_url(parsed)
            return

        # 试卷逐页图片（扫描版）：会员或已解锁才能拿到签名链接
        # ---- 同时查看检测（2026-10-20）----
        if parsed.path == "/api/pay/heartbeat":
            self._handle_heartbeat(parsed)
            return

        if parsed.path == "/api/pay/ban-status":
            self._handle_ban_status()
            return

        # ⚠️ 2026-10-28 审计修复：这里原来有一句 `self._handle_appeal(raw)` —— 但
        # `raw` 只有 do_POST 里才有，do_GET 里根本不存在，所以这条 URL 一被访问就
        # NameError（客户端拿到连接被重置）。申诉是 POST 语义，已挪到 _route_post。
        # 这里只留一个明确的方法提示，告诉误用 GET 的客户端该怎么调。
        if parsed.path == "/api/appeal":
            self._json(405, {"ok": False, "reason": "method_not_allowed",
                             "message": "请用 POST 提交申诉"})
            return

        if parsed.path == "/api/pay/paper-pages":
            self._handle_paper_pages(parsed)
            return

        # AI 学习助手：面板打开时查剩余次数（2026-10-25）
        if parsed.path == "/api/ai/quota":
            ai.handle_quota(self, self._bearer_uid())
            return

        # ---- 人机验证：发一张图形验证码（2026-10-21）----
        # ⚠️ 必须放在 do_GET 里（前端用 <img src> 或 fetch GET 拿）。写成 POST 会一路走到 404。
        if parsed.path == "/api/auth/captcha":
            status, payload = auth_captcha()
            # 验证码不能缓存，否则用户刷新拿到同一张（且答案已消费 → 必然失败）
            payload["_no_cache"] = True
            self._json(status, payload, no_cache=True)
            return

        # ---- 本地登录会话 & 数据读取（2026-10-17 · 阶段 5）----
        if (parsed.path == "/api/auth/session"
                or parsed.path == "/api/auth/devices"
                or parsed.path.startswith("/api/data/")):
            qs = urllib.parse.parse_qs(parsed.query)
            hd = self._lower_headers()
            if parsed.path == "/api/auth/session":
                status, payload = auth_session(hd)
            elif parsed.path == "/api/auth/devices":
                status, payload = auth_devices(hd)
            elif parsed.path == "/api/data/papers":
                status, payload = data_papers(qs, hd)
            elif parsed.path == "/api/data/profile":
                status, payload = data_profile_get(hd)
            elif parsed.path == "/api/data/favorites":
                status, payload = data_favorites_get(hd)
            elif parsed.path == "/api/data/recent":
                status, payload = data_recent_get(hd)
            elif parsed.path == "/api/data/progress":
                status, payload = data_progress_get(hd)
            elif parsed.path == "/api/data/mistakes":
                status, payload = data_mistakes_get(hd)
            elif parsed.path == "/api/data/admin/stats":
                status, payload = data_admin_stats(hd)
            elif parsed.path == "/api/data/my-orders":
                status, payload = data_my_orders(qs, hd)
            elif parsed.path == "/api/data/admin/users":
                status, payload = data_admin_users(hd)
            else:
                status, payload = 404, {"ok": False, "reason": "not_found"}
            self._json(status, payload)
            return

        self._json(404, {"ok": False, "reason": "not_found"})

    def _handle_cet_explain(self, parsed: urllib.parse.ParseResult) -> None:
        """GET /api/pay/cet-explain?slug=… —— 验用户 → 验会员 → 读文件原样返回"""
        headers = {k.lower(): v for k, v in self.headers.items()}
        tok = headers.get("authorization") or ""
        tok = tok[7:].strip() if tok.lower().startswith("bearer ") else ""
        uid = verify_user(tok)
        if not uid:
            self._json(401, {"ok": False, "reason": "not_logged_in"})
            return

        # 会员校验：用**用户自己的身份**调 my_membership（匿名调恒为 false）
        mem = db.rpc("my_membership", {}, uid=uid)
        if not mem.get("is_member"):
            self._json(403, {"ok": False, "reason": "not_a_member"})
            return

        qs = urllib.parse.parse_qs(parsed.query)
        slug = (qs.get("slug") or [""])[0].strip()
        if not _CET_SLUG_RE.match(slug):
            self._json(400, {"ok": False, "reason": "bad_slug"})
            return

        blob = load_cet_explain(slug)
        if blob is None:
            self._json(404, {"ok": False, "reason": "not_found"})
            return

        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(blob)))
        # 会员内容不进任何共享缓存
        self.send_header("Cache-Control", "private, no-store")
        self.end_headers()
        self.wfile.write(blob)

    def _handle_cet_solution_url(self, parsed: urllib.parse.ParseResult) -> None:
        """GET /api/pay/cet-solution-url?slug=… —— 验用户 → 验会员 → 签发签名链接

        与 `/api/pay/sign-media` 同一套路，只是签的是固定形状的解析版 PDF 路径，
        所以这里不收 path 参数，slug 白名单后自己拼，杜绝让调用方指定任意路径。
        """
        headers = {k.lower(): v for k, v in self.headers.items()}
        tok = headers.get("authorization") or ""
        tok = tok[7:].strip() if tok.lower().startswith("bearer ") else ""
        uid = verify_user(tok)
        if not uid:
            self._json(401, {"ok": False, "reason": "not_logged_in"})
            return

        # 会员校验：用**用户自己的身份**调 my_membership（匿名调恒为 false）
        mem = db.rpc("my_membership", {}, uid=uid)
        if not mem.get("is_member"):
            self._json(403, {"ok": False, "reason": "not_a_member"})
            return

        qs = urllib.parse.parse_qs(parsed.query)
        slug = (qs.get("slug") or [""])[0].strip()
        path = cet_solution_relpath(slug)
        if not path:
            self._json(400, {"ok": False, "reason": "bad_slug"})
            return

        if not CFG.get("media_secret"):
            log.error("media_secret 未配置，无法签发解析版 PDF 链接")
            self._json(503, {"ok": False, "reason": "media_not_configured"})
            return

        # 文件不存在就别签了 —— 签了前端也会拿到 404，不如在这里明确说清
        # （上传漏了一套 / 目录权限不对时，这个检查能把问题暴露在日志里）
        local = cet_solution_file(slug)
        if not local or not os.path.isfile(local):
            log.warning("解析版 PDF 不存在：%s", local)
            self._json(404, {"ok": False, "reason": "not_found"})
            return

        expires = int(time.time()) + CET_SOLUTION_TTL_SECONDS
        sig = media_sign(path, expires)
        self._json(200, {
            "ok": True,
            "url": f"{path}?md5={sig}&expires={expires}",
            "expires": expires,
        })


    # ============================================================
    # 同时查看检测（2026-10-20）
    # ============================================================
    def _bearer_uid(self) -> str | None:
        tok = (self.headers.get("Authorization") or "")
        tok = tok[7:].strip() if tok.lower().startswith("bearer ") else ""
        return verify_user(tok)

    def _handle_heartbeat(self, parsed: urllib.parse.ParseResult) -> None:
        """GET /api/pay/heartbeat?device_id=…&resource=…

        前端在阅读页每 30 秒打一次。若同账号另一台设备 90 秒内也在看 → 判并发。
        返回 403 时前端弹「违规处罚」弹窗并中断阅读。
        """
        uid = self._bearer_uid()
        if not uid:
            self._json(401, {"ok": False, "reason": "not_logged_in"})
            return
        # 2026-10-20 用户决定：**取消"两台设备不能同时查看"**。
        # 接口保留（前端仍在打心跳），但不再写入任何记录、不再判定并发。
        # 为什么保留而不是删掉：老版本前端还在发请求，删了会 404 刷错误日志。
        self._json(200, {"ok": True})

    def _handle_ban_status(self) -> None:
        """GET /api/pay/ban-status —— 前端进入阅读页前先问一句，封禁中直接拦。"""
        uid = self._bearer_uid()
        if not uid:
            self._json(401, {"ok": False, "reason": "not_logged_in"})
            return
        # 2026-10-20 取消封禁体系，恒返回未封禁（保留接口以兼容老前端）
        self._json(200, {"ok": True, "banned": False})

    def _handle_appeal(self, raw: str) -> None:
        """POST /api/appeal {reason, message, contact} —— 用户申诉。"""
        uid = self._bearer_uid()
        if not uid:
            self._json(401, {"ok": False, "reason": "not_logged_in"})
            return
        try:
            body = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            self._json(400, {"ok": False, "reason": "bad_json"})
            return
        # 违规处罚体系已取消，申诉入口保留（投稿/误判仍可通过 QQ 联系）
        try:
            db.execute(
                "insert into public.appeals (user_id, reason, message, contact) "
                "values (%s, %s, %s, %s)",
                [uid, str(body.get("reason") or "other")[:40],
                 str(body.get("message") or "")[:2000], str(body.get("contact") or "")[:120]])
        except Exception:
            pass
        self._json(200, {"ok": True})

    def _handle_paper_pages(self, parsed: urllib.parse.ParseResult) -> None:
        """GET /api/pay/paper-pages?paper_id=…&which=paper|answer

        验用户 → 验「会员 或 已解锁」→ 逐页签发图片链接；没有图片版就告诉前端走 PDF。

        为什么授权判定放在这里而不是前端：
          签名链接一旦发出去就是可访问的，前端做多少判断都拦不住直接构造请求。
          所以「能不能看」只在这里判，前端只负责展示。
        """
        headers = {k.lower(): v for k, v in self.headers.items()}
        tok = headers.get("authorization") or ""
        tok = tok[7:].strip() if tok.lower().startswith("bearer ") else ""
        uid = verify_user(tok)
        if not uid:
            self._json(401, {"ok": False, "reason": "not_logged_in"})
            return

        qs = urllib.parse.parse_qs(parsed.query)
        paper_id = (qs.get("paper_id") or [""])[0].strip()
        which = (qs.get("which") or ["paper"])[0].strip()
        # 只接受 UUID 形状，杜绝把任意字符串拼进 SQL 的可能（虽然占位符已经挡住了）
        if not re.fullmatch(r"[0-9a-fA-F-]{36}", paper_id):
            self._json(400, {"ok": False, "reason": "bad_paper_id"})
            return
        if which not in ("paper", "answer"):
            which = "paper"

        if not CFG.get("pages_secret"):
            log.error("pages_secret 未配置，无法签发试卷图片链接")
            self._json(503, {"ok": False, "reason": "pages_not_configured"})
            return

        # ---- 读试卷元数据（走本地库；db.py 是 2026-10-17 新增的访问层）----
        try:
            import db  # 延迟导入：万一 db.py 缺失，也不该让整个支付服务起不来
            rows = db.query(
                "select id, coalesce(file_path,'') as file_path, "
                "coalesce(answer_path,'') as answer_path, page_count "
                "from public.papers where id = %s", [paper_id])
        except Exception as e:
            log.exception("读试卷元数据失败：%s", e)
            self._json(503, {"ok": False, "reason": "db_unavailable"})
            return

        if not rows:
            self._json(404, {"ok": False, "reason": "not_found"})
            return
        row = rows[0]

        # ---- 授权：会员 或 这份已解锁 ----
        try:
            st = db.rpc("my_access_status", {"p_free_limit": 3}, uid=uid) or {}
            is_member = bool(st.get("is_member"))
            if not is_member:
                hit = db.query(
                    "select 1 as x from public.paper_unlocks "
                    "where user_id = %s and paper_id = %s", [uid, paper_id])
                is_member = bool(hit)          # 复用变量名不太好看，但意图是 "allowed"
        except Exception as e:
            log.exception("鉴权查询失败：%s", e)
            self._json(503, {"ok": False, "reason": "db_unavailable"})
            return

        if not is_member:
            self._json(403, {"ok": False, "reason": "not_allowed"})
            return

        # ---- 有没有图片版？没有就告诉前端走 PDF ----
        src_path = row["answer_path"] if which == "answer" else row["file_path"]
        dirname = pages_dir_of(src_path) if src_path else ""
        n = pages_count(dirname)
        if not n:
            # 没图片版（矢量卷：图片化反而更大）。
            # 若这份 PDF 已搬到本机，顺手给一个签名链接 —— 前端优先用它（同城、快），
            # 拿不到（url 为 null）才回退 Supabase，过渡期不会因为没搬全而白屏。
            expires = int(time.time()) + PAGES_URL_TTL
            self._json(200, {
                "ok": True,
                "kind": "pdf",
                "pages": int(row.get("page_count") or 0),
                "url": pdf_sign_url(src_path, expires),
                "expires": expires,
            })
            return

        # ---- 逐页签名 ----
        expires = int(time.time()) + PAGES_URL_TTL
        urls = []
        for i in range(1, n + 1):
            uri = f"/pages/{dirname}/p{i:02d}.webp"
            urls.append(f"{uri}?md5={pages_sign(uri, expires)}&expires={expires}")

        self._json(200, {
            "ok": True,
            "kind": "images",
            "which": which,
            "pages": n,
            "expires": expires,
            "urls": urls,
        })

    def _route_post(self) -> None:
        parsed = urllib.parse.urlparse(self.path)

        # 文件上传是 multipart 二进制流，不能走 _read_body 的 utf-8 解码
        if parsed.path == "/api/data/admin/upload":
            self._handle_admin_upload()
            return

        raw = self._read_body()
        headers = self._lower_headers()

        # ---- 用户申诉（2026-10-28 从 do_GET 挪过来，那边 raw 未定义会 NameError）----
        if parsed.path == "/api/appeal":
            self._handle_appeal(raw)
            return

        # ---- 微信 openid 绑定（2026-10-27）----
        # 第一次授权拿到就存到账号上，之后支付不用再跳授权
        if parsed.path == "/api/pay/bind-openid":
            status, payload = bind_wx_openid(raw, headers)
            self._json(status, payload)
            return

        # ---- 前端诊断上报（2026-10-27 临时，排查 JSAPI 用）----
        # 微信 JSAPI 依赖客户端环境，浏览器模拟不了；出问题时前端到底走到哪一步
        # 只能靠它自己上报。**注意这是 POST**：第一次写进了 do_GET，
        # 前端 POST 过来直接 404 not_found（自测时立刻暴露）。
        # ---- 前端诊断上报（2026-10-27 加，2026-10-28 收紧）----
        # 微信 JSAPI 依赖客户端环境，浏览器模拟不了；出问题时前端到底走到哪一步
        # 只能靠它自己上报。**注意这是 POST**：第一次写进了 do_GET，
        # 前端 POST 过来直接 404 not_found（自测时立刻暴露）。
        # 2026-10-28：这是匿名可写的日志入口 —— 谁都能往 journal 里灌 900 字节。
        # 现在要求登录 + 每 IP 限流，且只接受白名单字段（不再收 location.href 里的查询串）。
        if parsed.path == "/api/pay/diag":
            uid = self._bearer_uid()
            if not uid:
                self._json(401, {"ok": False, "reason": "not_logged_in"})
                return
            blocked, wait = SENSITIVE_FAIL_BY_IP.blocked(f"diag:{_client_ip(self._lower_headers()) or '-'}")
            if blocked:
                self._json(429, {"ok": False, "reason": "too_many_requests", "retry_after": wait})
                return
            SENSITIVE_FAIL_BY_IP.fail(f"diag:{_client_ip(self._lower_headers()) or '-'}")
            try:
                info = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                info = {"_raw": (raw or "")[:200]}
            if isinstance(info, dict):
                info = {k: v for k, v in info.items() if k in _DIAG_ALLOWED_KEYS}
            log.warning("【前端诊断】uid=%s %s", uid[:8], json.dumps(info, ensure_ascii=False)[:600])
            self._json(200, {"ok": True})
            return

        # AI 学习助手：流式问答（2026-10-25）。必须放在 _read_body 之后，
        # 请求体是小 JSON；响应走 NDJSON 流，不能进下面的 self._json 收尾。
        if parsed.path == "/api/ai/ask":
            ai.handle_ask(self, self._bearer_uid(), raw)
            return

        # ---- Supabase Send SMS Hook：Supabase 生成验证码，这里负责发出去 ----
        if parsed.path == "/api/auth/sms":
            if SMS is None:
                self._json(503, {"ok": False, "reason": "sms_not_configured"})
                return

            # 必须验签：否则任何人都能调这个接口刷我们的短信费
            hook_secret = str(CFG.get("supabase_sms_hook_secret") or "")
            if not verify_supabase_hook(
                hook_secret,
                raw.encode("utf-8") if isinstance(raw, str) else raw,
                headers.get("webhook-id", ""),
                headers.get("webhook-timestamp", ""),
                headers.get("webhook-signature", ""),
            ):
                log.warning("短信接口验签失败，来自 %s", self.headers.get("X-Real-IP") or self.address_string())
                self._json(401, {"ok": False, "reason": "bad_signature"})
                return

            try:
                payload = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                self._json(400, {"ok": False, "reason": "bad_json"})
                return

            phone = str((payload.get("user") or {}).get("phone") or "")
            otp = str((payload.get("sms") or {}).get("otp") or "")
            if not phone or not otp:
                self._json(400, {"ok": False, "reason": "missing_phone_or_otp"})
                return

            allowed, why = SMS_LIMITER.check(phone)
            if not allowed:
                # 429 让 Supabase 侧也看到被限流
                self._json(429, {"ok": False, "reason": why})
                return

            resp = SMS.send_code(phone, otp, 5)
            if sms_ok(resp):
                SMS_LIMITER.commit(phone)
                log.info("验证码已发送 → %s", phone[:3] + "****" + phone[-4:])
                self._json(200, {"ok": True})
            else:
                log.error("短信发送失败：%s %s —— %s", resp.get("Code"), resp.get("Message"),
                          explain(resp))
                self._json(502, {"ok": False, "reason": resp.get("Code"), "message": resp.get("Message")})
            return

        if parsed.path == "/api/pay/create":
            try:
                body = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                self._json(400, {"ok": False, "reason": "bad_json"})
                return
            status, payload = handle_create(
                body, headers, self.headers.get("X-Real-IP") or self.address_string()
            )
            self._json(status, payload)
            return

        if parsed.path == "/api/pay/notify/alipay":
            if not ALIPAY:
                self._text(503, "failure")
                return
            status, text = handle_notify_alipay(urllib.parse.parse_qs(raw, keep_blank_values=True))
            self._text(status, text)
            return

        if parsed.path == "/api/pay/notify/epay":
            if not EPAY:
                self._text(503, "fail")
                return
            status, text = handle_notify_epay(
                self._flat(urllib.parse.parse_qs(raw, keep_blank_values=True))
            )
            self._text(status, text)
            return

        if parsed.path == "/api/pay/recheck":
            try:
                body = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                self._json(400, {"ok": False, "reason": "bad_json"})
                return
            status, payload = handle_recheck(body, headers)
            self._json(status, payload)
            return

        if parsed.path == "/api/pay/notify/wechat":
            if not WECHAT:
                self._json(503, {"code": "FAIL", "message": "未配置微信支付"})
                return
            status, payload = handle_notify_wechat(headers, raw)
            self._json(status, payload)
            return

        # ---- 四六级听力：签发受保护音频的短效链接（会员专享）----
        if parsed.path == "/api/pay/sign-media":
            tok = (headers.get("authorization") or "")
            tok = tok[7:].strip() if tok.lower().startswith("bearer ") else ""
            uid = verify_user(tok)
            if not uid:
                self._json(401, {"ok": False, "reason": "not_logged_in"})
                return

            # 会员校验：用**用户自己的身份**调 my_membership（匿名调恒为 false）
            mem = db.rpc("my_membership", {}, uid=uid)
            if not mem.get("is_member"):
                self._json(403, {"ok": False, "reason": "not_a_member"})
                return

            try:
                payload = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                self._json(400, {"ok": False, "reason": "bad_json"})
                return

            path = str(payload.get("path") or "")
            # 白名单：只允许 /media/**/*.mp3，且不允许任何形式的路径穿越
            if not _MEDIA_PATH_RE.match(path) or ".." in path or "//" in path:
                self._json(400, {"ok": False, "reason": "bad_path"})
                return

            if not CFG.get("media_secret"):
                log.error("media_secret 未配置，无法签发听力链接")
                self._json(503, {"ok": False, "reason": "media_not_configured"})
                return

            expires = int(time.time()) + MEDIA_TTL_SECONDS
            sig = media_sign(path, expires)
            self._json(200, {
                "ok": True,
                "url": f"{path}?md5={sig}&expires={expires}",
                "expires": expires,
            })
            return

        # 注：`/api/pay/cet-explain` 与 `/api/pay/cet-solution-url` 都是 GET，
        #    实现放在 do_GET 里（别加到这来，否则请求一路走到 404）

        # ---- 本地登录与数据写入（2026-10-17 · 阶段 5）----
        if parsed.path.startswith("/api/auth/") or parsed.path.startswith("/api/data/"):
            if parsed.path == "/api/auth/signup":
                status, payload = auth_signup(raw, headers)
            elif parsed.path == "/api/auth/signin":
                status, payload = auth_signin(raw, headers)
            elif parsed.path == "/api/auth/signout":
                status, payload = auth_signout(headers)
            elif parsed.path == "/api/auth/devices/revoke":
                status, payload = auth_revoke_device(raw, headers)
            elif parsed.path == "/api/auth/password":
                status, payload = auth_password(raw, headers)
            elif parsed.path == "/api/auth/reset-request":
                status, payload = auth_reset_request(raw, headers)
            elif parsed.path == "/api/auth/email-code":
                status, payload = auth_send_email_code(raw, headers)
            elif parsed.path == "/api/auth/sms-code":
                status, payload = auth_send_sms_code(raw, headers)
            elif parsed.path == "/api/auth/sms-login":
                status, payload = auth_sms_login(raw, headers)
            elif parsed.path == "/api/auth/reset-by-phone":
                status, payload = auth_reset_by_phone(raw, headers)
            elif parsed.path == "/api/data/rpc":
                status, payload = data_rpc(raw, headers)
            elif parsed.path == "/api/data/profile":
                status, payload = data_profile_update(raw, headers)
            elif parsed.path == "/api/data/favorites/toggle":
                status, payload = data_favorites_toggle(raw, headers)
            elif parsed.path == "/api/data/progress":
                status, payload = data_progress_set(raw, headers)
            elif parsed.path == "/api/data/mistakes":
                status, payload = data_mistakes_add(raw, headers)
            elif parsed.path == "/api/data/mistakes/remove":
                status, payload = data_mistakes_remove(raw, headers)
            elif parsed.path == "/api/data/recent":
                status, payload = data_recent_add(raw, headers)
            elif parsed.path == "/api/data/admin/delete":
                status, payload = data_admin_delete(raw, headers)
            else:
                status, payload = 404, {"ok": False, "reason": "not_found"}
            self._json(status, payload)
            return

        self._json(404, {"ok": False, "reason": "not_found"})

    def _handle_admin_upload(self) -> None:
        """POST /api/data/admin/upload —— multipart：file[, answer_file], meta(JSON)

        管理员专用：写文件到 /var/lib/ctbu-pdfs/ 并入库（替代 Supabase Storage）。
        任何一步失败都回滚已写入的文件，避免留孤儿目录。
        """
        headers = self._lower_headers()
        if db is None:
            self._json(503, {"ok": False, "reason": "db_unavailable"})
            return
        uid = verify_user(_bearer(headers))
        if not uid:
            self._json(401, {"ok": False, "reason": "not_logged_in"})
            return
        if not db.rpc("is_admin", {}, uid=uid):
            self._json(403, {"ok": False, "reason": "not_admin"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        # nginx 侧 /api/data/ 的上限是 60m，这里跟着收到 64m（留一点 multipart 开销）。
        # 原来写 80m：nginx 先 413，学生/管理员看到的是网关错误，服务端日志里什么都没有。
        if length <= 0 or length > 64 * 1024 * 1024:
            self._json(413 if length > 0 else 400,
                       {"ok": False, "reason": "bad_size",
                        "message": "文件过大（单份上限 60 MB）" if length > 0 else "缺少文件"})
            return
        body = self.rfile.read(length)
        parts = parse_multipart(body, self.headers.get("Content-Type") or "")
        # 读完就把整包引用丢掉：parse_multipart 已经切好各 part 的 bytes，
        # 早一点释放能让峰值内存少一份（1.9G 的机器上这个差别是实打实的）。
        file_part = parts.get("file")
        meta_part = parts.get("meta")
        ans_part = parts.get("answer_file")
        del body

        # 只认扩展名是不够的：任意内容都会被冠成 .pdf 落盘，再由 nginx 以
        # application/pdf 提供给所有人。这里校验 PDF 头（2026-10-28）。
        for label, part in (("file", file_part), ("answer_file", ans_part)):
            if part and part[0] and not part[1][:5].startswith(b"%PDF-"):
                self._json(400, {"ok": False, "reason": "not_a_pdf",
                                 "message": f"{label} 不是有效的 PDF 文件"})
                return
        if not file_part or not file_part[0] or not meta_part:
            self._json(400, {"ok": False, "reason": "missing_file_or_meta"})
            return
        try:
            meta = json.loads(meta_part[1].decode("utf-8"))
        except Exception:  # noqa: BLE001
            self._json(400, {"ok": False, "reason": "bad_meta"})
            return
        course_id = str(meta.get("course_id") or "")
        if not re.fullmatch(r"[a-z0-9]{2,20}", course_id):
            self._json(400, {"ok": False, "reason": "bad_course_id"})
            return
        safe = re.sub(r"[^\w.\-]+", "_", file_part[0])
        if not safe.lower().endswith(".pdf"):
            safe += ".pdf"
        ts = int(time.time() * 1000)
        file_path = f"{course_id}/{ts}-{safe}"
        saved: list[str] = []
        try:
            saved.append(save_pdf(file_path, file_part[1]))
            answer_path = None
            ans_part = parts.get("answer_file")
            if ans_part and ans_part[0]:
                safe_a = re.sub(r"[^\w.\-]+", "_", ans_part[0])
                if not safe_a.lower().endswith(".pdf"):
                    safe_a += ".pdf"
                answer_path = f"{course_id}/{ts + 1}-{safe_a}"
                saved.append(save_pdf(answer_path, ans_part[1]))
            meta["uploaded_by"] = uid
            row = insert_paper(meta, file_path, len(file_part[1]), answer_path)
        except Exception as e:  # noqa: BLE001
            for d in saved:
                shutil.rmtree(os.path.join(PDFS_DIR, d), ignore_errors=True)
            log.exception("上传入库失败：%s", e)
            self._json(500, {"ok": False, "reason": "upload_failed", "message": "入库失败，已回滚"})
            return
        self._json(200, {"ok": True, "paper": row})


def main() -> None:
    host = CFG["listen_host"]
    port = int(CFG["listen_port"])
    log.info("支付服务启动：http://%s:%s（仅监听本机，由 nginx 反代）｜渠道：易支付=%s 支付宝=%s 微信=%s",
             host, port, EPAY is not None, ALIPAY is not None, WECHAT is not None)
    ThreadingHTTPServer((host, port), Handler).serve_forever()


if __name__ == "__main__":
    main()
