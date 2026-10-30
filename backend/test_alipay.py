#!/usr/bin/env python3
"""支付宝签名与验签的自测（不需要真实开放平台账号）。

做法：自己生成一对 RSA 密钥，用它同时扮演「应用私钥」和「支付宝公钥」，
     把真实的签名 → 待签名串拼装 → 验签 → 跳转 URL 生成 跑一遍。

跑法：python3 test_alipay.py
"""

from __future__ import annotations

import base64
import os
import sys
import tempfile
import urllib.parse

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from alipay import Alipay, AlipayError  # noqa: E402

FAILED = 0


def check(name: str, cond: bool, extra: str = "") -> None:
    global FAILED
    if not cond:
        FAILED += 1
    print(f"  [{'通过' if cond else '失败'}] {name}{('  ' + extra) if extra else ''}")


def build(tmp: str) -> Alipay:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    priv = os.path.join(tmp, "app_private_key.pem")
    with open(priv, "wb") as f:
        f.write(key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ))

    pub = os.path.join(tmp, "alipay_public_key.pem")
    with open(pub, "wb") as f:
        f.write(key.public_key().public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        ))

    return Alipay({
        "app_id": "2021000000000000",
        "app_private_key_path": priv,
        "alipay_public_key_path": pub,
        "notify_url": "https://louisnb.cn/api/pay/notify/alipay",
        "return_url": "https://louisnb.cn/#/membership",
    })


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        ali = build(tmp)

        print("\n1. 待签名串拼装规则")
        msg = Alipay._canonical({"b": "2", "a": "1", "sign": "xxx", "sign_type": "RSA2", "c": ""})
        check("按 key 升序", msg == "a=1&b=2", msg)
        check("剔除 sign / sign_type", "sign" not in msg)
        check("空值不参与", "c=" not in msg)

        print("\n2. 订单跳转 URL")
        url = ali.create_wap_pay("CTBU20261015ABCD1234", 380, "工商真题库 单月会员")
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
        check("走 wap 接口", qs["method"][0] == "alipay.trade.wap.pay")
        check("sign_type 为 RSA2", qs["sign_type"][0] == "RSA2")
        check("charset 为 utf-8", qs["charset"][0] == "utf-8")
        check("带 notify_url", qs["notify_url"][0].endswith("/api/pay/notify/alipay"))
        check("biz_content 含订单号", "CTBU20261015ABCD1234" in qs["biz_content"][0])
        check("金额是元的字符串 3.80", '"total_amount":"3.80"' in qs["biz_content"][0])
        check("product_code 正确", "QUICK_WAP_WAY" in qs["biz_content"][0])

        params = {k: v[0] for k, v in qs.items()}
        sig = params.pop("sign")
        ali._alipay_public_key.verify(
            base64.b64decode(sig), Alipay._canonical(params).encode(),
            padding.PKCS1v15(), hashes.SHA256(),
        )
        check("URL 里的 sign 可被公钥验证", True)

        print("\n3. 电脑网站支付")
        page_url = ali.create_page_pay("CTBU20261015EFGH5678", 1280, "工商真题库 永久会员")
        pqs = urllib.parse.parse_qs(urllib.parse.urlparse(page_url).query)
        check("走 page 接口", pqs["method"][0] == "alipay.trade.page.pay")
        check("金额 12.80", '"total_amount":"12.80"' in pqs["biz_content"][0])
        check("product_code 正确", "FAST_INSTANT_TRADE_PAY" in pqs["biz_content"][0])

        print("\n4. 金额单位换算（分 → 元）")
        check("380 → 3.80", Alipay.cents_to_yuan(380) == "3.80")
        check("680 → 6.80", Alipay.cents_to_yuan(680) == "6.80")
        check("1280 → 12.80", Alipay.cents_to_yuan(1280) == "12.80")
        check("5 → 0.05", Alipay.cents_to_yuan(5) == "0.05")
        check("100 → 1.00", Alipay.cents_to_yuan(100) == "1.00")

        print("\n5. 异步通知验签")
        notify = {
            "app_id": "2021000000000000",
            "out_trade_no": "CTBU20261015ABCD1234",
            "trade_no": "2026101522001400000000000001",
            "trade_status": "TRADE_SUCCESS",
            "total_amount": "3.80",
            "seller_id": "2088000000000000",
            "sign_type": "RSA2",
        }
        notify["sign"] = ali._sign(notify)  # 自测里用应用私钥签字，模拟支付宝签名

        try:
            ali.verify_notify(notify)
            check("正确签名应通过", True)
        except AlipayError as exc:
            check("正确签名应通过", False, str(exc))

        tampered = dict(notify, total_amount="0.01")
        try:
            ali.verify_notify(tampered)
            check("金额被篡改应被拒绝", False)
        except AlipayError:
            check("金额被篡改应被拒绝", True)

        wrong_app = dict(notify, app_id="2021999999999999")
        wrong_app["sign"] = ali._sign(wrong_app)
        try:
            ali.verify_notify(wrong_app)
            check("app_id 不属于本应用应被拒绝", False)
        except AlipayError:
            check("app_id 不属于本应用应被拒绝", True)

        no_sign = {k: v for k, v in notify.items() if k != "sign"}
        try:
            ali.verify_notify(no_sign)
            check("缺少 sign 应被拒绝", False)
        except AlipayError:
            check("缺少 sign 应被拒绝", True)

        print("\n6. 主动查单 URL")
        qurl = urllib.parse.parse_qs(urllib.parse.urlparse(ali.build_query_url("X1")).query)
        check("走 query 接口", qurl["method"][0] == "alipay.trade.query")
        check("biz_content 含订单号", "X1" in qurl["biz_content"][0])

    print()
    if FAILED:
        print(f"结果：{FAILED} 项失败")
        return 1
    print("结果：全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
