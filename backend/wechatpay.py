"""微信支付 APIv3 客户端（只用标准库 + cryptography，不引入官方 SDK）

为什么自己实现而不用官方 SDK：
  官方 SDK（wechatpayv3）依赖较多，而服务器是 2 核 2G 的小机器，
  这里只用到签名/验签/解密/下单四个动作，自己实现更可控、依赖更少。

需要用到的凭据（全部来自微信支付商户平台）：
  appid              已认证服务号/公众号的 AppID（wx 开头）
  mchid              商户号
  api_v3_key         32 位 APIv3 密钥（用于解密回调）
  merchant_serial    商户 API 证书序列号
  merchant_key_path  商户 API 证书私钥 apiclient_key.pem
  wxpay_public_key_path  微信支付公钥 pub_key.pem（用于验证回调签名）
  notify_url         回调地址（必须 HTTPS 公网可达）

参考文档：https://pay.weixin.qq.com/wiki/doc/apiv3/
"""

from __future__ import annotations

import base64
import json
import os
import time
import urllib.error
import urllib.request
import uuid
from typing import Any

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

WXPAY_BASE = "https://api.mch.weixin.qq.com"


class WeChatPayError(Exception):
    def __init__(self, message: str, status: int = 0, body: str = ""):
        super().__init__(message)
        self.status = status
        self.body = body


class WeChatPay:
    def __init__(self, cfg: dict[str, Any]):
        self.appid = cfg["appid"]
        self.mchid = cfg["mchid"]
        self.api_v3_key = cfg["api_v3_key"].encode("utf-8")
        if len(self.api_v3_key) != 32:
            raise WeChatPayError("api_v3_key 必须是 32 个字符")

        self.merchant_serial = cfg["merchant_serial"]
        with open(cfg["merchant_key_path"], "rb") as f:
            self._merchant_key = serialization.load_pem_private_key(f.read(), password=None)

        self.wxpay_public_key = None
        if cfg.get("wxpay_public_key_path"):
            with open(cfg["wxpay_public_key_path"], "rb") as f:
                self.wxpay_public_key = serialization.load_pem_public_key(f.read())

        self.notify_url = cfg["notify_url"]

    # ------------------------------------------------------------------
    # 签名 / 验签 / 解密
    # ------------------------------------------------------------------
    def _sign(self, message: str) -> str:
        sig = self._merchant_key.sign(
            message.encode("utf-8"),
            padding.PKCS1v15(),
            hashes.SHA256(),
        )
        return base64.b64encode(sig).decode("ascii")

    def build_authorization(self, method: str, url_path: str, body: str) -> str:
        """构造 Authorization 头。

        待签名串（微信规定，末尾必须带换行）：
            HTTP方法\\nURL路径(含query)\\n时间戳\\n随机串\\n请求体\\n
        """
        timestamp = str(int(time.time()))
        nonce = uuid.uuid4().hex.upper()
        message = f"{method}\n{url_path}\n{timestamp}\n{nonce}\n{body}\n"
        signature = self._sign(message)
        return (
            'WECHATPAY2-SHA256-RSA2048 '
            f'mchid="{self.mchid}",'
            f'nonce_str="{nonce}",'
            f'signature="{signature}",'
            f'timestamp="{timestamp}",'
            f'serial_no="{self.merchant_serial}"'
        )

    def verify_notify(self, headers: dict[str, str], body: str) -> None:
        """验证回调签名。失败抛 WeChatPayError。

        待验签串：时间戳\\n随机串\\n请求体\\n
        签名用【微信支付公钥】验证（旧版用平台证书，已弃用）。
        """
        if self.wxpay_public_key is None:
            raise WeChatPayError("未配置微信支付公钥，无法验签")

        ts = headers.get("wechatpay-timestamp", "")
        nonce = headers.get("wechatpay-nonce", "")
        signature = headers.get("wechatpay-signature", "")
        if not (ts and nonce and signature):
            raise WeChatPayError("回调缺少签名头")

        # 防重放：时间戳偏离超过 5 分钟直接拒绝
        try:
            skew = abs(int(time.time()) - int(ts))
        except ValueError:
            raise WeChatPayError("回调时间戳格式错误")
        if skew > 300:
            raise WeChatPayError(f"回调时间戳超出容忍范围（{skew} 秒）")

        message = f"{ts}\n{nonce}\n{body}\n"
        try:
            self.wxpay_public_key.verify(
                base64.b64decode(signature),
                message.encode("utf-8"),
                padding.PKCS1v15(),
                hashes.SHA256(),
            )
        except Exception as exc:  # noqa: BLE001
            raise WeChatPayError(f"回调验签失败：{exc}") from exc

    def decrypt_resource(self, resource: dict[str, Any]) -> dict[str, Any]:
        """解密回调里的 resource（AEAD_AES_256_GCM）。

        ciphertext 是 base64，末尾 16 字节是 GCM tag，cryptography 库会自动处理。
        """
        if resource.get("algorithm") != "AEAD_AES_256_GCM":
            raise WeChatPayError(f"不支持的加密算法：{resource.get('algorithm')}")

        aad = resource.get("associated_data")
        nonce = resource.get("nonce")
        ciphertext = base64.b64decode(resource["ciphertext"])

        aesgcm = AESGCM(self.api_v3_key)
        try:
            plaintext = aesgcm.decrypt(
                nonce.encode("utf-8"),
                ciphertext,
                (aad or "").encode("utf-8"),
            )
        except Exception as exc:  # noqa: BLE001
            raise WeChatPayError(f"回调解密失败（APIv3 密钥可能不对）：{exc}") from exc

        return json.loads(plaintext.decode("utf-8"))

    # ------------------------------------------------------------------
    # HTTP
    # ------------------------------------------------------------------
    def _request(self, method: str, url_path: str, payload: dict | None = None) -> dict[str, Any]:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")) if payload else ""
        req = urllib.request.Request(
            WXPAY_BASE + url_path,
            data=body.encode("utf-8") if body else None,
            method=method,
            headers={
                "Authorization": self.build_authorization(method, url_path, body),
                "Accept": "application/json",
                "Content-Type": "application/json",
                "User-Agent": "ctbu-exam-site/1.0",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as exc:
            raw = exc.read().decode("utf-8", "replace")
            raise WeChatPayError(f"微信支付接口报错 {exc.code}", exc.code, raw) from exc
        except urllib.error.URLError as exc:
            raise WeChatPayError(f"连接微信支付接口失败：{exc.reason}") from exc

    # ------------------------------------------------------------------
    # 下单
    # ------------------------------------------------------------------
    def _base_order(self, order_no: str, amount_cents: int, description: str) -> dict[str, Any]:
        return {
            "appid": self.appid,
            "mchid": self.mchid,
            "description": description,
            "out_trade_no": order_no,
            "notify_url": self.notify_url,
            "amount": {"total": int(amount_cents), "currency": "CNY"},
        }

    def create_native(self, order_no: str, amount_cents: int, description: str) -> dict[str, Any]:
        """PC 网站扫码支付 → 返回 code_url（二维码内容）"""
        return self._request(
            "POST",
            "/v3/pay/transactions/native",
            self._base_order(order_no, amount_cents, description),
        )

    def create_h5(self, order_no: str, amount_cents: int, description: str,
                  client_ip: str = "127.0.0.1",
                  redirect_url: str | None = None) -> dict[str, Any]:
        """手机浏览器跳转支付 → 返回 h5_url（跳转到微信付款页）。

        ⚠️ 微信内打开时不可用，那种情况必须走 JSAPI。

        `redirect_url`（2026-10-30 加）：支付完成后微信会把用户送回这个地址。
        不传的话会返回商户配置的默认页，学生付完可能落在微信的空白页上。
        """
        payload = self._base_order(order_no, amount_cents, description)
        payload["scene_info"] = {
            "payer_client_ip": client_ip,
            "h5_info": {"type": "Wap"},
        }
        if redirect_url:
            payload["scene_info"]["h5_info"]["wap_url"] = redirect_url
            payload["redirect_url"] = redirect_url
        return self._request("POST", "/v3/pay/transactions/h5", payload)

    def create_jsapi(self, order_no: str, amount_cents: int, description: str,
                     openid: str) -> dict[str, Any]:
        """微信内唤起支付 → 返回 prepay_id（还需要二次签名才能给前端）"""
        payload = self._base_order(order_no, amount_cents, description)
        payload["payer"] = {"openid": openid}
        return self._request("POST", "/v3/pay/transactions/jsapi", payload)

    def build_jsapi_pay_params(self, prepay_id: str) -> dict[str, str]:
        """JSAPI 调起支付所需的二次签名参数，交给前端 WeixinJSBridge / JSSDK 使用。

        待签名串：appId\\n时间戳\\n随机串\\nprepay_id=xxx\\n
        """
        timestamp = str(int(time.time()))
        nonce = uuid.uuid4().hex.upper()
        message = f"{self.appid}\n{timestamp}\n{nonce}\nprepay_id={prepay_id}\n"
        return {
            "appId": self.appid,
            "timeStamp": timestamp,
            "nonceStr": nonce,
            "package": f"prepay_id={prepay_id}",
            "signType": "RSA",
            "paySign": self._sign(message),
        }

    def query_order(self, order_no: str) -> dict[str, Any]:
        """主动查单（回调丢失时兜底用）"""
        return self._request("GET", f"/v3/pay/transactions/out-trade-no/{order_no}?mchid={self.mchid}")

    def close_order(self, order_no: str) -> dict[str, Any]:
        return self._request(
            "POST",
            f"/v3/pay/transactions/out-trade-no/{order_no}/close",
            {"mchid": self.mchid},
        )


def safe_join(base: str, *parts: str) -> str:
    return os.path.join(base, *parts)
