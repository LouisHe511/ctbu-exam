"""阿里云「短信认证」(号码认证服务 PNVS) 客户端 —— 只做一件事：把验证码发出去。

为什么用「短信认证」而不是「短信服务」：
  个人主体拿不到「短信服务」的签名报备（运营商不受理），而「短信认证」官方明确
  支持个人实名、免资质、免签名模板、免报备，平台预置签名与模板即可对接 API。

配置：/etc/ctbu-pay/aliyun-sms.json（权限 640，含 AccessKey，**绝不进 git**）

安全要点：
  - 只用 RAM 子账号的 AccessKey（已授 AliyunDypnsFullAccess），不是主账号
  - 本模块只调 SendSmsVerifyCode；不碰账号下任何其他资源
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any

log = logging.getLogger("ctbu-sms")

SMS_CONFIG_PATH = os.environ.get("CTBU_SMS_CONFIG", "/etc/ctbu-pay/aliyun-sms.json")


def _percent_encode(s: Any) -> str:
    """阿里云 RPC 签名要求的编码：quote 后再把 + * %7E 换成 %20 %2A ~"""
    return (
        urllib.parse.quote(str(s), safe="~")
        .replace("+", "%20")
        .replace("*", "%2A")
        .replace("%7E", "~")
    )


class AliyunSms:
    def __init__(self, cfg: dict[str, Any]):
        self.ak_id = str(cfg["access_key_id"])
        self.ak_secret = str(cfg["access_key_secret"])
        self.endpoint = str(cfg.get("endpoint", "dypnsapi.aliyuncs.com"))
        self.sign_name = str(cfg["sign_name"])
        self.template_code = str(cfg["template_code"])

    # ---------- 底层：签名并调用 ----------
    def _call(self, action: str, params: dict[str, Any], timeout: int = 20) -> dict[str, Any]:
        p: dict[str, Any] = {
            "Action": action,
            "Version": "2017-05-25",
            "Format": "JSON",
            "AccessKeyId": self.ak_id,
            "SignatureMethod": "HMAC-SHA1",
            "SignatureVersion": "1.0",
            "SignatureNonce": str(uuid.uuid4()),
            "Timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        p.update(params)
        cqs = "&".join(f"{_percent_encode(k)}={_percent_encode(p[k])}" for k in sorted(p))
        string_to_sign = "GET&" + _percent_encode("/") + "&" + _percent_encode(cqs)
        sig = base64.b64encode(
            hmac.new(
                (self.ak_secret + "&").encode(),
                string_to_sign.encode(),
                hashlib.sha1,
            ).digest()
        ).decode()
        url = f"https://{self.endpoint}/?Signature={_percent_encode(sig)}&{cqs}"
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "ignore")
            try:
                return json.loads(body)
            except json.JSONDecodeError:
                return {"Code": "HttpError", "Message": f"{e.code} {body[:200]}"}
        except Exception as e:  # 网络/DNS 等
            return {"Code": "NetworkError", "Message": f"{type(e).__name__}: {e}"}

    # ---------- 对外：发送验证码 ----------
    def send_code(self, phone: str, code: str, valid_minutes: int = 5) -> dict[str, Any]:
        """把指定验证码发到指定手机号。

        用固定的 code 通过 TemplateParam 填入模板；
        同时用 Code 参数告诉阿里云「这是我指定的码」。
        （注意：传了自定义 Code 后，CheckSmsVerifyCode 不再支持校验 ——
          但本项目的校验由 Supabase 负责，我们只需要发出去。）
        """
        return self._call(
            "SendSmsVerifyCode",
            {
                "PhoneNumber": phone,
                "SignName": self.sign_name,
                "TemplateCode": self.template_code,
                "TemplateParam": json.dumps(
                    {"code": code, "min": str(valid_minutes)}, separators=(",", ":")
                ),
                "Code": code,
                "CountryCode": "86",
                "ValidTime": str(valid_minutes),
                "Interval": "60",
            },
        )

    @staticmethod
    def ok(resp: dict[str, Any]) -> bool:
        return bool(resp.get("Success")) and resp.get("Code") == "OK"


def ok(resp: dict[str, Any]) -> bool:
    """模块级便捷函数：判断发送是否成功"""
    return AliyunSms.ok(resp)


# 错误码 → 人话。2026-10-20 加：线上排查时 Code 只给 UNKNOWN，
# 完全看不出根因，查了半天才发现是「签名/模板不是系统赠送的那一对」。
SMS_HINTS: dict[str, str] = {
    "UNKNOWN": "签名或模板不被接受。短信认证（PNVS）**只能用控制台系统赠送的那一对**，"
               "自定义签名/模板、或赠送签名+自定义模板交叉使用都会报这个。"
               "请到 号码认证服务控制台 → 短信认证 → 概览，抄下赠送的「签名名称」与「模板编号」覆盖配置。",
    "biz.FREQUENCY": "发送频率超限（同账号 60 秒内只能发 1 条，Interval=60）。稍等再试。",
    "isv.ValidateFail": "验证码校验失败（凭据与签名本身是有效的）。",
    "isv.BUSINESS_LIMIT_CONTROL": "业务流控，触发运营商/平台限流。",
    "isv.AMOUNT_NOT_ENOUGH": "套餐包余额不足，需在号码认证服务控制台续购。",
    "isv.MOBILE_NUMBER_ILLEGAL": "手机号格式不合法（仅支持中国大陆 86 号段）。",
    "isv.SMS_SIGNATURE_ILLEGAL": "签名不合法：必须是控制台赠送的签名。",
    "isv.SMS_TEMPLATE_ILLEGAL": "模板不合法：必须是控制台赠送的模板。",
    "isv.PARAM_LENGTH_LIMIT": "参数超长（模板变量与赠送模板不匹配时会报）。",
}


def explain(resp: dict[str, Any]) -> str:
    """把阿里云返回的错误翻成人话，写进日志。"""
    code = str(resp.get("Code") or "")
    return SMS_HINTS.get(code) or SMS_HINTS.get("UNKNOWN") if not AliyunSms.ok(resp) else ""


def load_sms() -> AliyunSms | None:
    """读配置；文件不存在或字段缺失则返回 None（服务照常启动，只是短信不可用）"""
    try:
        with open(SMS_CONFIG_PATH, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except FileNotFoundError:
        log.warning("短信配置不存在：%s（短信功能关闭）", SMS_CONFIG_PATH)
        return None
    except Exception as e:
        log.error("短信配置读取失败：%s", e)
        return None

    missing = [k for k in ("access_key_id", "access_key_secret", "sign_name", "template_code") if not cfg.get(k)]
    if missing:
        log.error("短信配置缺字段：%s（短信功能关闭）", ",".join(missing))
        return None
    return AliyunSms(cfg)


# ============================================================
# Supabase Send SMS Hook 的签名校验
#
# Supabase 用 standardwebhooks 规范签名，请求头：
#   webhook-id / webhook-timestamp / webhook-signature
# 签名内容： "<id>.<timestamp>.<原始请求体>"
# 密钥形如 "v1,whsec_<base64>"，验签时取 whsec_ 之后的部分做 base64 解码
# 签名头形如 "v1,<base64 签名>"（可能多个，用空格分隔）
# ============================================================
def verify_supabase_hook(
    secret: str,
    raw_body: bytes,
    webhook_id: str,
    webhook_timestamp: str,
    webhook_signature: str,
    tolerance_seconds: int = 300,
) -> bool:
    if not (secret and webhook_id and webhook_timestamp and webhook_signature):
        return False

    # 时间戳容差：防重放
    try:
        if abs(time.time() - int(webhook_timestamp)) > tolerance_seconds:
            log.warning("hook 时间戳超出容差")
            return False
    except ValueError:
        return False

    # 取密钥本体（去掉 v1,whsec_ 前缀）
    key_b64 = secret.split(",", 1)[1] if secret.startswith("v1,") else secret
    if key_b64.startswith("whsec_"):
        key_b64 = key_b64[len("whsec_"):]
    try:
        key = base64.b64decode(key_b64)
    except Exception:
        return False

    signed = f"{webhook_id}.{webhook_timestamp}.".encode() + raw_body
    expected = base64.b64encode(hmac.new(key, signed, hashlib.sha256).digest()).decode()

    for part in webhook_signature.split():
        candidate = part.split(",", 1)[1] if part.startswith("v1,") else part
        if hmac.compare_digest(candidate, expected):
            return True
    return False


# ============================================================
# 频率限制（内存版，单进程够用）
# 不做这个，短信费会被恶意刷光 —— 这是硬要求
# ============================================================
class RateLimiter:
    """同号 60 秒 1 条；同号每天最多 N 条；全局每天最多 M 条。"""

    def __init__(self, per_phone_interval=60, per_phone_daily=10, global_daily=500):
        self.per_phone_interval = per_phone_interval
        self.per_phone_daily = per_phone_daily
        self.global_daily = global_daily
        self._last_at: dict[str, float] = {}
        self._phone_day: dict[str, tuple[str, int]] = {}
        self._global: tuple[str, int] = ("", 0)

    @staticmethod
    def _today() -> str:
        return time.strftime("%Y-%m-%d")

    def check(self, phone: str) -> tuple[bool, str]:
        now = time.time()
        day = self._today()

        # 1) 同号间隔
        last = self._last_at.get(phone)
        if last is not None and now - last < self.per_phone_interval:
            wait = int(self.per_phone_interval - (now - last))
            return False, f"too_frequent:{wait}"

        # 2) 同号当日
        d, c = self._phone_day.get(phone, (day, 0))
        if d != day:
            c = 0
        if c >= self.per_phone_daily:
            return False, "phone_daily_limit"

        # 3) 全局当日（防被刷）
        gd, gc = self._global
        if gd != day:
            gc = 0
        if gc >= self.global_daily:
            return False, "global_daily_limit"

        return True, ""

    def commit(self, phone: str) -> None:
        day = self._today()
        now = time.time()
        self._last_at[phone] = now
        d, c = self._phone_day.get(phone, (day, 0))
        self._phone_day[phone] = (day, (c + 1) if d == day else 1)
        gd, gc = self._global
        self._global = (day, (gc + 1) if gd == day else 1)
