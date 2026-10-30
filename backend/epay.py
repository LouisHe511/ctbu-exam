#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""易支付（Epay）支付接口 —— 按官方示例包重写，兼容市面绝大多数「易支付」平台。

> 参考样本：`epay.zip`（epay.php / submit.class.php / notify.class.php /
>   md5.function.php / core.function.php / epay.config.php / notify_url.php）
>   2026-10-21 逐行读过，本文件与它的行为**逐条对齐**，差异只在语言。

============================================================
一、与参考包的对应关系（改这份代码前先看这张表）
============================================================
| PHP 原件            | 这里的方法            | 说明 |
|---|---|---|
| `argSort()`         | `_sort()`             | `ksort` = 键名升序（PHP 默认 SORT_REGULAR，**按字符串比较**） |
| `paraFilter()`      | `_filter()`           | 剔除 `sign` / `sign_type` / **空字符串**（注意：`"0"` 不算空） |
| `createLinkstring()`| `_link()`             | 拼 `k=v&k=v`，**值不做 URL 编码** |
| `md5Sign()`         | `sign()`              | `md5(拼串 + key)`，小写 |
| `md5Verify()`       | `verify()`            | 同上，比对大小写不敏感 |
| `AlipaySubmit`      | `build_form()` / `pay_url()` | 跳转支付 |
| `notify.class.php`  | `verify_notify()`     | **GET 参数**参与验签（参考包读的是 `$_GET`） |

**参考包里的三个"坑"，这里都按原样复刻，别"优化"：**
1. `createLinkstring` 用的是 `substr($arg, 0, count($arg)-2)` —— PHP 的 bug
   （`count()` 对字符串返回 1，于是减 2 = -1，实际等于去掉末尾 1 个字符）。
   因为循环里已经多拼了一个 `&`，去掉末尾 1 个正好把 `&` 去掉，**结果是对的**。
   我们的 `_link()` 用 `"&".join()`，天然没有这个问题，结果一致。
2. `paraFilter` 用 `$val == ""` 判断空值 —— PHP 弱比较下 `"0"` == "" 是 **false**，
   所以**值为 `"0"` 的字段要参与签名**。这里用 `!= ""` 严格比较。
3. 跳转地址带 `?_input_charset=utf-8`，是参考包 `buildRequestForm` 拼进去的。
   照抄，别省 —— 有的平台会读这个参数。

============================================================
二、最小可用参数（参考包实际只传这 9 个）
============================================================
    pid           商户 ID
    type          支付方式：alipay / wxpay / qqpay / bank / jdpay
    notify_url    异步通知地址（服务端 → 服务端，必须公网可达）
    return_url    同步跳回地址（用户浏览器，仅展示，不能当开通依据）
    out_trade_no  商户订单号（唯一）
    name          商品名（超 127 字节平台会截断）
    money         金额，**单位元**，两位小数字符串
    sitename      站点名（可选，但参考包传了）
    (sign / sign_type 最后加)

============================================================
三、安全要点（这些都是踩过的真事）
============================================================
· **只认 notify，不认 return**。return_url 是 GET 跳转，用户可伪造；
  notify 带 sign，且我们还会二次主动查单核对金额。
· **notify 要回纯文本 `success`**，否则平台反复重发（有的平台重发 6 次以上）。
· **必须核对 pid**（别人可以拿自己的单打到你的回调地址）。
· **必须核对金额**。参考包 `$srow['money']==$money` 就是干这个的。
  但第三方通道手续费是**内扣**，实收可能略少，所以给一个很小的容差（见 tolerance）。
· **必须幂等**。同一笔单子重发通知不能重复开通（数据库那层 `confirm_payment_auto` 兜）。
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

log = logging.getLogger("ctbu-epay")

# ---------------------------------------------------------------- 常量
# 支付方式取值（参考包 epay.php 直接把前端传的 type 透传，这里做白名单）
PAY_TYPES = ("alipay", "wxpay", "qqpay", "bank", "jdpay", "paypal")
DEVICES = ("pc", "mobile", "qq", "wechat", "alipay")

# 成功回执（平台要求纯文本）
SUCCESS_TEXT = "success"
FAIL_TEXT = "fail"

# 交易成功状态（不同平台有过 TRADE_SUCCESS / SUCCESS 两种写法）
SUCCESS_STATUS = ("TRADE_SUCCESS", "SUCCESS")

# 常见路径组合：不同平台命名不一样，用 probe 工具实测，别猜
COMMON_PATHS = (
    ("/submit.php", "/mapi.php", "/api.php"),
    ("/xpay/epay/submit.php", "/xpay/epay/mapi.php", "/xpay/epay/api.php"),
    ("/epay/submit.php", "/epay/mapi.php", "/epay/api.php"),
    ("/pay/submit.php", "/pay/mapi.php", "/pay/api.php"),
)


class EpayError(Exception):
    """业务失败（参数不对 / 平台拒绝 / 网络错误）。"""

    def __init__(self, message: str, code: str = "epay_error", raw: Any = None):
        super().__init__(message)
        self.code = code
        self.raw = raw


# ================================================================
# 签名：完全对齐参考包的 md5.function.php + core.function.php
# ================================================================
def _filter(params: dict[str, Any]) -> dict[str, str]:
    """等价 PHP `paraFilter()`：剔除 sign / sign_type / 空值。

    ⚠️ 空值判定用 `!= ""`（严格）：PHP 的 `$val == ""` 里 `"0"` 是**不相等**的，
    所以值为 `"0"` 的字段必须留下参与签名。用 `if not v` 会把它误删。
    """
    out: dict[str, str] = {}
    for k, v in params.items():
        if k in ("sign", "sign_type"):
            continue
        if v is None:
            continue
        s = str(v)
        if s == "":          # 只剔除真正的空串，不剔除 "0"
            continue
        out[k] = s
    return out


def _sort(params: dict[str, str]) -> dict[str, str]:
    """等价 PHP `argSort()` 的 `ksort()`：按键名升序（字符串比较）。"""
    return {k: params[k] for k in sorted(params.keys())}


def _link(params: dict[str, str]) -> str:
    """等价 PHP `createLinkstring()`：拼 k=v&k=v，**值不 URL 编码**。"""
    return "&".join(f"{k}={v}" for k, v in params.items())


def sign(params: dict[str, Any], key: str) -> str:
    """等价 PHP `md5Sign()`：md5(拼串 + key)，小写十六进制。"""
    return hashlib.md5((_link(_sort(_filter(params))) + key).encode("utf-8")).hexdigest()


def verify_sign(params: dict[str, Any], key: str) -> bool:
    """等价 PHP `md5Verify()`：大小写不敏感比较（用 compare_digest 防时序）。"""
    got = params.get("sign")
    if not got:
        return False
    st = params.get("sign_type")
    if st not in (None, "", "MD5", "md5"):
        return False
    return hmac.compare_digest(str(got).lower(), sign(params, key))


# ================================================================
# 客户端
# ================================================================
class Epay:
    """一个商户号一个实例。

    cfg 字段（全部来自 /etc/ctbu-pay/config.json 的 epay 段）：
        pid, key, gateway, notify_url, return_url, sitename,
        submit_path / mapi_path / api_path    ← 换平台只改这三个
        pay_types                              ← 后台开了哪些通道
        amount_tolerance_cents / _ppm          ← 金额容差（手续费内扣）
    """

    def __init__(self, cfg: dict[str, Any]):
        for k in ("pid", "key"):
            if not cfg.get(k):
                raise EpayError(f"配置缺少 {k}", "bad_config")
        self.pid = str(cfg["pid"]).strip()
        self.key = str(cfg["key"])
        self.gateway = str(cfg.get("gateway") or "").rstrip("/")
        if not self.gateway:
            raise EpayError("配置缺少 gateway（平台根地址）", "bad_config")
        # 2026-10-28：查单接口用 `pid + key` 明文鉴权（平台协议如此，不是签名），
        # 一旦 gateway 被填成 http://，商户密钥就会明文过公网，
        # 而且查单结果可被中间人伪造 → recheck 会照着假结果开通会员。
        # 宁可启动失败让人看见，也不要静默降级成明文。
        if not self.gateway.startswith("https://"):
            raise EpayError(
                "gateway 必须是 https://（查单接口会明文携带商户密钥）", "bad_config")

        # 三个路径：换平台只改这里
        self.submit_path = str(cfg.get("submit_path") or "/submit.php")
        self.mapi_path = str(cfg.get("mapi_path") or "/mapi.php")
        self.api_path = str(cfg.get("api_path") or "/api.php")

        self.notify_url = str(cfg.get("notify_url") or "")
        self.return_url = str(cfg.get("return_url") or "")
        self.sitename = str(cfg.get("sitename") or "")
        self.platform = str(cfg.get("platform") or "epay")

        types = list(cfg.get("pay_types") or ["alipay"])
        bad = [t for t in types if t not in PAY_TYPES]
        if bad:
            raise EpayError(f"不支持的支付方式 {bad}，可选 {PAY_TYPES}", "bad_config")
        self.pay_types = types

        # 金额容差：第三方通道手续费内扣，实收可能略少。
        # 容差 = max(绝对下限分, 订单金额 × ppm / 1e6)，默认 10 分 + 2%（¥3.80 → 10 分）
        self.tolerance_cents = int(cfg.get("amount_tolerance_cents", 10) or 0)
        self.tolerance_ppm = int(cfg.get("amount_tolerance_ppm", 20000) or 0)

    # ---------------- 签名（实例便捷方法） ----------------
    def sign(self, params: dict[str, Any]) -> str:
        """用自己的 key 签名。等价模块级 `sign(params, key)`，方便调用方少传一个参数。"""
        return sign(params, self.key)

    def verify(self, params: dict[str, Any]) -> bool:
        """只用自己的 key 验签（不含 pid 校验）。"""
        return verify_sign(params, self.key)

    # ---------------- 金额 ----------------
    @staticmethod
    def to_yuan(cents: int) -> str:
        """分 → 元的两位小数字符串。377 → '3.77'（参考包 money 就是字符串）"""
        return f"{cents / 100:.2f}"

    @staticmethod
    def to_cents(yuan: Any) -> int:
        """元 → 分。四舍五入避免浮点尾差（'3.77' → 377）"""
        try:
            return int(round(float(str(yuan).strip()) * 100))
        except (TypeError, ValueError) as exc:
            raise EpayError(f"金额无法解析：{yuan!r}", "bad_amount") from exc

    def tolerance_for(self, amount_cents: int) -> int:
        return max(self.tolerance_cents,
                   amount_cents * self.tolerance_ppm // 1_000_000)

    # ---------------- 下单参数 ----------------
    def build_params(self, order_no: str, amount_cents: int, subject: str,
                     pay_type: str | None = None,
                     device: str | None = None,
                     param: str = "",
                     return_url: str | None = None) -> dict[str, str]:
        """构造**已签名**的下单参数。

        对照参考包 `epay.php` 的 `$parameter` 数组 —— 顺序和字段保持一致，
        只多传 `device`（参考包没传，但多数平台支持，能优化收银台展示）。
        """
        if pay_type is None:
            pay_type = self.pay_types[0]
        if pay_type not in self.pay_types:
            raise EpayError(f"该通道未开通支付方式：{pay_type}", "type_not_enabled")
        if device is not None and device not in DEVICES:
            raise EpayError(f"不支持的设备类型：{device}", "bad_device")

        p: dict[str, str] = {
            "pid": self.pid,
            "type": pay_type,
            "out_trade_no": order_no,
            "name": subject[:127],
            "money": self.to_yuan(amount_cents),
        }
        if self.notify_url:
            p["notify_url"] = self.notify_url
        rt = return_url if return_url is not None else self.return_url
        if rt:
            p["return_url"] = rt
        if self.sitename:
            p["sitename"] = self.sitename
        if device:
            p["device"] = device
        if param:
            p["param"] = param

        # ⚠️ `_input_charset` 必须**参与签名**（2026-10-21 实测）。
        # 参考包 PHP 把它拼在 form action 的 URL 上（`...submit.php?_input_charset=utf-8`），
        # 看起来像"不在参数里"，但服务端验签时会把它算进去 ——
        # 少了它 submit 页直接返回「签名错误」，微信通道尤其会误判成"不可用"。
        p["_input_charset"] = "utf-8"
        p["sign"] = sign(p, self.key)
        p["sign_type"] = "MD5"
        return p

    # ---------------- 跳转支付（对应 buildRequestForm） ----------------
    def pay_url(self, order_no: str, amount_cents: int, subject: str,
                pay_type: str | None = None, device: str | None = None,
                param: str = "", return_url: str | None = None) -> str:
        """拼成可直接 302 的完整 URL（GET 版跳转）。"""
        p = self.build_params(order_no, amount_cents, subject,
                              pay_type, device, param, return_url)
        qs = urllib.parse.urlencode(p, quote_via=urllib.parse.quote)
        return f"{self.gateway}{self.submit_path}?{qs}"

    def build_form(self, order_no: str, amount_cents: int, subject: str,
                   pay_type: str | None = None, device: str | None = None,
                   param: str = "", return_url: str | None = None) -> str:
        """自动提交的 HTML 表单（POST 版）。

        比 GET 稳：金额/中文商品名不受 URL 长度和编码差异影响。
        参考包默认就是 POST（`buildRequestForm($para, 'POST')`）。
        """
        p = self.build_params(order_no, amount_cents, subject,
                              pay_type, device, param, return_url)
        fields = "\n".join(
            f'  <input type="hidden" name="{_esc(k)}" value="{_esc(v)}">'
            for k, v in p.items()
        )
        action = f"{self.gateway}{self.submit_path}"
        return (
            f'<form id="epaysubmit" name="epaysubmit" action="{_esc(action)}" method="POST">\n'
            f"{fields}\n"
            '<input type="submit" value="正在跳转" style="display:none">\n'
            "</form>\n"
            '<script>document.forms["epaysubmit"].submit();</script>'
        )

    # ---------------- 服务端下单（mapi.php，返回 JSON） ----------------
    def create_order(self, order_no: str, amount_cents: int, subject: str,
                     pay_type: str | None = None, device: str | None = None,
                     param: str = "", client_ip: str = "",
                     timeout: int = 15) -> dict[str, Any]:
        """调 mapi.php 拿支付地址。返回 {payurl|qrcode|urlscheme, trade_no, ...}

        什么时候用：不想跳转到平台收银台页（自己控制页面）、或要二维码。
        """
        p = self.build_params(order_no, amount_cents, subject, pay_type, device, param)
        if client_ip:
            p["clientip"] = client_ip

        body = urllib.parse.urlencode(p).encode("utf-8")
        req = urllib.request.Request(
            f"{self.gateway}{self.mapi_path}", data=body, method="POST",
            headers={"Content-Type": "application/x-www-form-urlencoded",
                     "User-Agent": "ctbu-pay/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                text = r.read().decode("utf-8", "ignore").strip()
        except urllib.error.HTTPError as e:
            raise EpayError(f"HTTP {e.code}：{e.read()[:200]!r}", "http_error") from e
        except Exception as e:  # noqa: BLE001
            raise EpayError(f"请求 {self.mapi_path} 失败：{e}", "network_error") from e

        try:
            ret = json.loads(text)
        except json.JSONDecodeError as exc:
            raise EpayError(f"返回不是 JSON：{text[:200]}", "bad_response") from exc

        if int(ret.get("code", 0)) != 1:
            raise EpayError(str(ret.get("msg") or text[:200]), "platform_rejected", ret)

        if not (ret.get("payurl") or ret.get("qrcode") or ret.get("urlscheme")):
            raise EpayError(f"下单成功但无支付地址：{ret}", "no_pay_url", ret)
        return ret

    # ---------------- 主动查单（对应 api.php） ----------------
    def query(self, order_no: str = "", trade_no: str = "", timeout: int = 15) -> dict[str, Any]:
        """POST api.php（act=order）—— 查单。

        2026-10-21 对着云熠（XArrPay）实测校准：
          · 路径不是根目录的 /api.php（那是前端页面兜底），而是 **/xpay/epay/api.php**；
          · 用 **POST** 表单，GET 会被前端路由吃掉；
          · 只靠 `pid` + 通讯密钥 `key` 鉴权，**不签名**；
          · 成功回 `{"code":1,...}`，查不到回 `{"code":0,"msg":"没有找到订单信息"}`。
        """
        qs = {"act": "order", "pid": self.pid, "key": self.key}
        if trade_no:
            qs["trade_no"] = trade_no
        elif order_no:
            qs["out_trade_no"] = order_no
        else:
            raise EpayError("必须给 order_no 或 trade_no", "bad_args")

        url = f"{self.gateway}{self.api_path}"
        body = urllib.parse.urlencode(qs).encode()
        req = urllib.request.Request(
            url, data=body, method="POST",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                text = r.read().decode("utf-8", "ignore").strip()
        except Exception as e:  # noqa: BLE001
            raise EpayError(f"查单失败：{e}", "network_error") from e
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise EpayError(f"查单返回不是 JSON：{text[:200]}", "bad_response") from exc

    @staticmethod
    def _looks_paid(ret: dict[str, Any]) -> bool:
        """判断查单结果是不是"真的付掉了"。

        ⚠️ 这里故意**双重把关**，宁可漏判（=等回调 / 人工补）也不能误判：
        误判 = 没收到钱就开会员，是真金白银的损失。

        验的是两条同时成立：
          1. `endtime` 是真实时间。平台对未支付订单给零值 `1970-01-01 08:00:00`
             （44 笔未付款订单实测全是这个值）；
          2. `status` 落在已支付取值里。**两套约定都认**：
             彩虹易支付 V1 用 1=已支付，XArrPay 原生用 2=已支付。
        """
        if int(ret.get("code", 0) or 0) != 1:
            return False
        end = str(ret.get("endtime") or "").strip()
        if not end or end.startswith("1970-01-01"):
            return False
        return str(ret.get("status") or "").strip() in {"1", "2"}

    def is_paid(self, order_no: str = "", trade_no: str = "") -> tuple[bool, dict[str, Any]]:
        ret = self.query(order_no=order_no, trade_no=trade_no)
        return self._looks_paid(ret), ret

    # ---------------- 异步通知验签 ----------------
    def verify_notify(self, params: dict[str, Any],
                      require_pid: bool = True) -> tuple[bool, str]:
        """校验 notify。返回 (通过, 原因)。

        对照 `notify.class.php::verifyNotify()` + `notify_url.php` 的安全检查：
          1. 参数非空
          2. sign 正确（GET/POST 参数都参与，剔 sign/sign_type/空值）
          3. **pid 必须等于自己的** ← 参考包没做，但必须做
        """
        if not params:
            return False, "empty"
        if not verify_sign(params, self.key):
            return False, "bad_sign"
        if require_pid and params.get("pid") is not None:
            if str(params["pid"]) != self.pid:
                return False, "pid_mismatch"
        return True, "ok"

    @staticmethod
    def is_success_status(status: str | None) -> bool:
        # 参考包只认 TRADE_SUCCESS；有的平台写 SUCCESS，一起认
        return (status or "").upper() in SUCCESS_STATUS

    # ---------------- 支付方式挑选 ----------------
    def prefer_type(self, in_wechat: bool) -> str | None:
        """微信内必须有 wxpay（支付宝跳不出去）；否则优先支付宝。

        返回 None = 当前环境没有可用方式，前端应引导「在浏览器打开」。
        """
        if in_wechat:
            return "wxpay" if "wxpay" in self.pay_types else None
        if "alipay" in self.pay_types:
            return "alipay"
        return self.pay_types[0] if self.pay_types else None


def _esc(v: Any) -> str:
    return (str(v).replace("&", "&amp;").replace('"', "&quot;")
            .replace("<", "&lt;").replace(">", "&gt;"))


# ================================================================
# 自测：不联网，验证与参考包逐条一致
# ================================================================
def _selftest() -> int:
    P = F = 0

    def ok(name, cond, extra=""):
        nonlocal P, F
        if cond:
            P += 1
            print("  ✅", name, extra)
        else:
            F += 1
            print("  ❌", name, extra)

    print("=" * 62)
    print("① 参数过滤（对照 paraFilter）")
    ok("剔 sign", "sign" not in _filter({"sign": "x", "pid": "1"}))
    ok("剔 sign_type", "sign_type" not in _filter({"sign_type": "MD5", "pid": "1"}))
    ok("剔空串", "a" not in _filter({"a": "", "b": "1"}))
    ok('保留 "0"（PHP 弱比较的关键）', _filter({"a": "0"}).get("a") == "0")

    print("\n② 排序（对照 argSort/ksort）")
    s = _sort({"b": "2", "a": "1", "C": "3"})
    ok("ASCII 升序，大写在前", list(s.keys()) == ["C", "a", "b"], str(list(s.keys())))

    print("\n③ 拼串（对照 createLinkstring）")
    ok("k=v&k=v 无编码", _link({"a": "1", "b": "2"}) == "a=1&b=2")
    ok("值含中文不编码", _link({"name": "工商真题库"}) == "name=工商真题库")

    print("\n④ 签名（对照 md5Sign）")
    # 用参考包默认 key 手算一组做交叉验证
    params = {"pid": "1002", "type": "alipay", "out_trade_no": "T1",
              "name": "test", "money": "0.01"}
    expect_pre = "money=0.01&name=test&out_trade_no=T1&pid=1002&type=alipay"
    ok("拼串与预期一致", _link(_sort(_filter(params))) == expect_pre,
       _link(_sort(_filter(params))))
    sig = sign(params, "BVP3LRUB")
    ok("签名 32 位小写", len(sig) == 32 and sig == sig.lower(), sig)
    ok("验签通过", verify_sign({**params, "sign": sig}, "BVP3LRUB"))
    ok("换 key 就失败", not verify_sign({**params, "sign": sig}, "WRONGKEY"))
    ok("改金额就失败", not verify_sign({**params, "money": "9.99", "sign": sig}, "BVP3LRUB"))
    ok("sign_type 非 MD5 拒绝",
       not verify_sign({**params, "sign": sig, "sign_type": "RSA"}, "BVP3LRUB"))

    print("\n⑤ 下单参数（对照 epay.php 的 $parameter）")
    ep = Epay({"pid": "1002", "key": "BVP3LRUB", "gateway": "https://pay.example.com",
               "notify_url": "https://x.cn/notify", "return_url": "https://x.cn/back",
               "sitename": "工商真题库", "pay_types": ["alipay"]})
    p = ep.build_params("CTBU001", 380, "工商真题库会员", "alipay", "pc")
    for k in ("pid", "type", "notify_url", "return_url", "out_trade_no",
              "name", "money", "sitename", "sign", "sign_type"):
        ok(f"含 {k}", k in p)
    ok("金额是元的两位小数", p["money"] == "3.80", p["money"])
    ok("sign_type=MD5", p["sign_type"] == "MD5")

    url = ep.pay_url("CTBU001", 380, "会员", "alipay")
    ok("URL 带 _input_charset 且参与签名",
       "_input_charset=utf-8" in url and "_input_charset" in _link(_sort(_filter(p))),
       url[:90])
    ok("URL 用配置的 submit_path", url.startswith("https://pay.example.com/submit.php"))

    form = ep.build_form("CTBU001", 380, "会员", "alipay")
    ok("表单自动提交", "epaysubmit" in form and ".submit()" in form)

    print("\n⑥ 金额换算")
    ok("377 → 3.77", Epay.to_yuan(377) == "3.77")
    ok("'3.77' → 377", Epay.to_cents("3.77") == 377)
    ok("容差 ¥3.80 = 10 分", ep.tolerance_for(380) == 10, str(ep.tolerance_for(380)))

    print("\n⑦ 通知校验（对照 notify.class.php + notify_url.php）")
    n = {"pid": "1002", "out_trade_no": "CTBU001", "trade_no": "T9",
         "trade_status": "TRADE_SUCCESS", "money": "3.80", "type": "alipay"}
    n["sign"] = sign(n, "BVP3LRUB")
    n["sign_type"] = "MD5"
    ok("正常通知通过", ep.verify_notify(n) == (True, "ok"))
    # 注意：改 pid 会让签名失效（pid 参与签名），所以要**重新签一次**才能测到 pid 检查本身。
    # 真实攻击场景正是这样：攻击者用自己的 pid + 自己的密钥签，签名是"正确"的，
    # 只有 pid 白名单能拦住 —— 所以这个检查必须独立验证。
    fake = {"pid": "9999", "out_trade_no": "CTBU001", "trade_no": "T9",
            "trade_status": "TRADE_SUCCESS", "money": "3.80", "type": "alipay"}
    fake["sign"] = sign(fake, "BVP3LRUB")      # 用同一把 key 签，模拟"签名合法但 pid 不对"
    fake["sign_type"] = "MD5"
    ok("签名合法但 pid 不对 → 仍被拒", ep.verify_notify(fake)[1] == "pid_mismatch")
    ok("原通知（pid 对）仍然通过", ep.verify_notify(n) == (True, "ok"))
    ok("改金额签名失效", ep.verify_notify({**n, "money": "0.01"})[1] == "bad_sign")
    ok("空参数被拒", ep.verify_notify({}) == (False, "empty"))
    ok("TRADE_SUCCESS 算成功", Epay.is_success_status("TRADE_SUCCESS"))
    ok("WAIT_BUYER_PAY 不算", not Epay.is_success_status("WAIT_BUYER_PAY"))

    print("\n⑧ 微信内选支付方式")
    ok("只开支付宝 → 微信内返回 None", ep.prefer_type(True) is None)
    ep2 = Epay({"pid": "1", "key": "k", "gateway": "https://x.cn",
                "pay_types": ["alipay", "wxpay"]})
    ok("开了微信 → 返回 wxpay", ep2.prefer_type(True) == "wxpay")
    ok("浏览器 → 优先支付宝", ep2.prefer_type(False) == "alipay")

    print("\n" + "=" * 62)
    print("通过 %d 项，失败 %d 项" % (P, F))
    return 0 if F == 0 else 1


if __name__ == "__main__":
    import sys
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    sys.exit(_selftest())
