#!/usr/bin/env python3
"""微信支付加解密与签名的自测（不需要真实商户号）。

做法：自己生成一对 RSA 密钥，用它同时扮演「商户私钥」和「微信支付公钥」，
     跑一遍真实的签名 → 验签 → AES-GCM 加密 → 解密 流程。
     这样能在拿到真实凭据之前就把密码学部分验证正确。

跑法：python3 test_crypto.py
"""

from __future__ import annotations

import base64
import json
import os
import sys
import tempfile
import time
import uuid

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wechatpay import WeChatPay, WeChatPayError  # noqa: E402

FAILED = 0


def check(name: str, cond: bool, extra: str = "") -> None:
    global FAILED
    mark = "通过" if cond else "失败"
    if not cond:
        FAILED += 1
    print(f"  [{mark}] {name}{('  ' + extra) if extra else ''}")


def build_client(tmp: str, api_v3_key: str = "A" * 32) -> WeChatPay:
    """造一个自签环境的客户端：商户私钥与"微信支付公钥"来自同一对密钥。"""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    merchant_key_path = os.path.join(tmp, "apiclient_key.pem")
    with open(merchant_key_path, "wb") as f:
        f.write(key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        ))

    public_key_path = os.path.join(tmp, "pub_key.pem")
    with open(public_key_path, "wb") as f:
        f.write(key.public_key().public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo,
        ))

    return WeChatPay({
        "appid": "wx_test_appid_0001",
        "mchid": "1900000001",
        "api_v3_key": api_v3_key,
        "merchant_serial": "ABCDEF1234567890",
        "merchant_key_path": merchant_key_path,
        "wxpay_public_key_path": public_key_path,
        "notify_url": "https://example.com/api/pay/notify/wechat",
    })


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        wx = build_client(tmp)

        print("\n1. 构造 Authorization 头（商户签名）")
        auth = wx.build_authorization("POST", "/v3/pay/transactions/native", '{"a":1}')
        check("包含 WECHATPAY2-SHA256-RSA2048", auth.startswith("WECHATPAY2-SHA256-RSA2048 "))
        check("包含 mchid", 'mchid="1900000001"' in auth)
        check("包含 serial_no", 'serial_no="ABCDEF1234567890"' in auth)
        check("签名不是空串", 'signature=""' not in auth)
        print(f"       示例：{auth[:96]}...")

        print("\n2. 回调验签")
        body = json.dumps({"id": "evt-1", "event_type": "TRANSACTION.SUCCESS"}, ensure_ascii=False)
        ts = str(int(time.time()))
        nonce = uuid.uuid4().hex.upper()
        message = f"{ts}\n{nonce}\n{body}\n"
        good_sig = wx._sign(message)  # 自测里用商户私钥签字，模拟微信平台签名

        ok_headers = {
            "wechatpay-timestamp": ts,
            "wechatpay-nonce": nonce,
            "wechatpay-signature": good_sig,
        }
        try:
            wx.verify_notify(ok_headers, body)
            check("正确签名应通过", True)
        except WeChatPayError as exc:
            check("正确签名应通过", False, str(exc))

        bad_headers = dict(ok_headers)
        bad_headers["wechatpay-signature"] = base64.b64encode(b"x" * 256).decode()
        try:
            wx.verify_notify(bad_headers, body)
            check("伪造签名应被拒绝", False)
        except WeChatPayError:
            check("伪造签名应被拒绝", True)

        try:
            wx.verify_notify({**ok_headers, "wechatpay-timestamp": str(int(time.time()) - 3600)}, body)
            check("过期时间戳应被拒绝（防重放）", False)
        except WeChatPayError:
            check("过期时间戳应被拒绝（防重放）", True)

        tampered = body.replace("SUCCESS", "FAIL")
        try:
            wx.verify_notify(ok_headers, tampered)
            check("报文被篡改应被拒绝", False)
        except WeChatPayError:
            check("报文被篡改应被拒绝", True)

        print("\n3. 回调资源解密（AEAD_AES_256_GCM）")
        plain = {
            "out_trade_no": "CTBU20261015ABCD1234",
            "transaction_id": "4200001234202610151234567890",
            "trade_state": "SUCCESS",
            "amount": {"total": 380, "payer_total": 380, "currency": "CNY"},
        }
        aad = "transaction"
        res_nonce = uuid.uuid4().hex.upper()[:12]
        ct = AESGCM(wx.api_v3_key).encrypt(
            res_nonce.encode(), json.dumps(plain).encode(), aad.encode()
        )
        resource = {
            "algorithm": "AEAD_AES_256_GCM",
            "original_type": "transaction",
            "ciphertext": base64.b64encode(ct).decode(),
            "associated_data": aad,
            "nonce": res_nonce,
        }
        got = wx.decrypt_resource(resource)
        check("解密结果与原文一致", got == plain)
        check("金额可读出", (got.get("amount") or {}).get("total") == 380)

        wrong = build_client(tmp, api_v3_key="B" * 32)
        try:
            wrong.decrypt_resource(resource)
            check("APIv3 密钥不对时应解密失败", False)
        except WeChatPayError:
            check("APIv3 密钥不对时应解密失败", True)

        print("\n4. JSAPI 二次签名（前端唤起支付用）")
        params = wx.build_jsapi_pay_params("wx1512345678901234567890")
        need = {"appId", "timeStamp", "nonceStr", "package", "signType", "paySign"}
        check("参数齐全", need <= set(params))
        check("package 格式正确", params["package"].startswith("prepay_id="))
        check("signType 为 RSA", params["signType"] == "RSA")

        msg = f"{params['appId']}\n{params['timeStamp']}\n{params['nonceStr']}\n{params['package']}\n"
        wx.wxpay_public_key.verify(
            base64.b64decode(params["paySign"]),
            msg.encode(),
            padding.PKCS1v15(),
            hashes.SHA256(),
        )
        check("paySign 可被公钥验证", True)

        print("\n5. 配置校验")
        try:
            build_client(tmp, api_v3_key="too_short")
            check("APIv3 密钥长度错误应报错", False)
        except WeChatPayError:
            check("APIv3 密钥长度错误应报错", True)

    print()
    if FAILED:
        print(f"结果：{FAILED} 项失败")
        return 1
    print("结果：全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
