"""支付宝「手机网站支付 / 电脑网站支付」客户端（只用标准库 + cryptography）

为什么是这两个产品，而不是「当面付」：
  当面付是**线下扫码**产品，签约要提交门头照 + 店内照，纯线上站基本过不了。
  手机网站支付 / 电脑网站支付才是给**网站**用的，只要执照 + 备案一致的网站，且**没有年费**。

和微信支付的差异（写代码时最容易踩的点）：
  · 签名用 RSA2( SHA256withRSA )，商户私钥签名、**支付宝公钥**验签
  · 金额单位是【元】的两位小数字符串（"3.80"），**不是分**
  · 待签名串是「按 key 升序拼 k=v&k=v」，不是微信那种固定格式的换行串
  · "跳转支付" = 浏览器跳到支付宝网关（GET 拼参数），不用二维码

需要用到的凭据（支付宝开放平台）：
  app_id             开放平台应用的 APPID（数字）
  app_private_key    应用私钥（自己生成，PKCS8，PEM）
  alipay_public_key  支付宝公钥（配置应用公钥后由支付宝给出）
  notify_url         异步通知地址（必须公网可达，用于自动开通）
  return_url         同步跳回地址（仅用于展示，不可作为开通依据）
"""

from __future__ import annotations

import base64
import json
import time
import urllib.parse
import urllib.request
from typing import Any

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding

GATEWAY = "https://openapi.alipay.com/gateway.do"


class AlipayError(Exception):
    pass


class Alipay:
    def __init__(self, cfg: dict[str, Any]):
        self.app_id = str(cfg["app_id"])
        self.notify_url = cfg["notify_url"]
        self.return_url = cfg.get("return_url", "")
        self.gateway = cfg.get("gateway", GATEWAY)

        with open(cfg["app_private_key_path"], "rb") as f:
            self._private_key = serialization.load_pem_private_key(f.read(), password=None)
        with open(cfg["alipay_public_key_path"], "rb") as f:
            self._alipay_public_key = serialization.load_pem_public_key(f.read())

    # ------------------------------------------------------------------
    # 签名 / 验签
    # ------------------------------------------------------------------
    @staticmethod
    def _canonical(params: dict[str, Any], *, for_notify: bool = False) -> str:
        """待签名串：按 key 升序拼 k=v&k=v（原始值，不 url-encode，空值不参与）。

        ⚠️ 两处规则**不一样**，2026-10-30 实测踩过一次：

          · **请求签名**（下单、查单、关单）：只剔除 `sign`，**`sign_type` 必须参与**。
            漏掉 sign_type 会得到 `isv.invalid-signature` ——
            支付宝网关会把它的验签串原文回给你，一眼就能看出少了 `&sign_type=RSA2&`。

          · **异步通知验签**：`sign` 与 `sign_type` 都不参与（官方《异步通知验签》口径）。

        这两种口径共用同一个函数，靠 `for_notify` 区分。**改这里之前先把两边都测一遍。**
        """
        skip = {"sign", "sign_type"} if for_notify else {"sign"}
        items = [
            (k, v) for k, v in params.items()
            if k not in skip and v is not None and v != ""
        ]
        items.sort(key=lambda kv: kv[0])
        return "&".join(f"{k}={v}" for k, v in items)

    def _sign(self, params: dict[str, Any]) -> str:
        message = self._canonical(params)
        sig = self._private_key.sign(
            message.encode("utf-8"), padding.PKCS1v15(), hashes.SHA256()
        )
        return base64.b64encode(sig).decode("ascii")

    def verify_notify(self, params: dict[str, str]) -> None:
        """校验异步通知签名，失败抛 AlipayError。

        用两种待签串各试一次（都排除 sign，区别只在 sign_type 参不参与）：
        支付宝不同接口/不同时期对 sign_type 是否参与的口径不完全一致，
        而**任何一种口径下签名都必须能用支付宝公钥验过**，所以两种都试
        不降低安全性，只避免"真付了钱却因为拼串口径不同而没开通"。
        """
        signature = params.get("sign")
        if not signature:
            raise AlipayError("通知缺少 sign 字段")
        if params.get("sign_type") not in (None, "", "RSA2"):
            raise AlipayError(f"不支持的签名类型：{params.get('sign_type')}")

        sig = base64.b64decode(signature)
        last: Exception | None = None
        for for_notify in (True, False):
            message = self._canonical(params, for_notify=for_notify).encode("utf-8")
            try:
                self._alipay_public_key.verify(
                    sig, message, padding.PKCS1v15(), hashes.SHA256()
                )
                break
            except Exception as exc:  # noqa: BLE001
                last = exc
        else:
            raise AlipayError(f"通知验签失败：{last}") from last

        # 通知可能被第三方伪造给你别的应用，必须核对 app_id
        if params.get("app_id") and params["app_id"] != self.app_id:
            raise AlipayError("通知里的 app_id 与本应用不一致")

    # ------------------------------------------------------------------
    # 下单：生成跳转 URL
    # ------------------------------------------------------------------
    @staticmethod
    def cents_to_yuan(cents: int) -> str:
        """支付宝要的是「元」的两位小数字符串，不是分。380 → '3.80'"""
        return f"{cents / 100:.2f}"

    def _build_pay_url(self, method: str, biz: dict[str, Any], product_code: str,
                       out_trade_no: str, amount_cents: int, subject: str) -> str:
        biz_content = {
            "out_trade_no": out_trade_no,
            "total_amount": self.cents_to_yuan(amount_cents),
            "subject": subject,
            "product_code": product_code,
            **biz,
        }
        params: dict[str, Any] = {
            "app_id": self.app_id,
            "method": method,
            "format": "JSON",
            "charset": "utf-8",
            "sign_type": "RSA2",
            "timestamp": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime()),
            "version": "1.0",
            "notify_url": self.notify_url,
            "biz_content": json.dumps(biz_content, ensure_ascii=False, separators=(",", ":")),
        }
        if self.return_url:
            params["return_url"] = self.return_url

        params["sign"] = self._sign(params)
        # quote_via=quote 让空格编码成 %20（支付宝要这个，不是 +）
        return f"{self.gateway}?{urllib.parse.urlencode(params, quote_via=urllib.parse.quote)}"

    def create_wap_pay(self, order_no: str, amount_cents: int, subject: str,
                       quit_url: str = "") -> str:
        """手机网站支付 → 返回跳转 URL（浏览器会跳到支付宝 App 完成付款）"""
        biz = {"quit_url": quit_url} if quit_url else {}
        return self._build_pay_url(
            "alipay.trade.wap.pay", biz, "QUICK_WAP_WAY", order_no, amount_cents, subject
        )

    def create_page_pay(self, order_no: str, amount_cents: int, subject: str) -> str:
        """电脑网站支付 → 返回跳转 URL（跳到 PC 收银台）"""
        return self._build_pay_url(
            "alipay.trade.page.pay", {}, "FAST_INSTANT_TRADE_PAY",
            order_no, amount_cents, subject,
        )

    # ------------------------------------------------------------------
    # 主动查单（回调丢失时兜底）
    # ------------------------------------------------------------------
    def build_query_url(self, order_no: str) -> str:
        """生成 alipay.trade.query 的请求 URL（服务端可直接 GET 拿 JSON 结果）"""
        params: dict[str, Any] = {
            "app_id": self.app_id,
            "method": "alipay.trade.query",
            "format": "JSON",
            "charset": "utf-8",
            "sign_type": "RSA2",
            "timestamp": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime()),
            "version": "1.0",
            "biz_content": json.dumps({"out_trade_no": order_no}, separators=(",", ":")),
        }
        params["sign"] = self._sign(params)
        return f"{self.gateway}?{urllib.parse.urlencode(params, quote_via=urllib.parse.quote)}"

    def query_trade(self, order_no: str) -> dict[str, Any]:
        """主动查单（2026-10-30）。

        为什么必须有：异步通知会丢（网络抖动、服务重启、nginx 502）。
        以前"点我已完成付款"只去问易支付，支付宝的单子永远查不到已付 ——
        学生真付了钱却开不通。现在按订单的 provider 查对应平台。

        返回 `alipay_trade_query_response` 里那段；查不到这笔会有
        `sub_code = ACQ.TRADE_NOT_EXIST`，调用方按"未付"处理即可。
        网络/签名异常直接抛，由调用方决定降级。
        """
        url = self.build_query_url(order_no)
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=12) as resp:
            raw = json.loads(resp.read().decode("utf-8"))
        return raw.get("alipay_trade_query_response") or {}

    @staticmethod
    def is_trade_success(result: dict[str, Any]) -> bool:
        """查单结果是否算"已付款"。"""
        return (result.get("trade_status") or "") in ("TRADE_SUCCESS", "TRADE_FINISHED")
