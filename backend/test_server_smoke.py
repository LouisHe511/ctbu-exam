#!/usr/bin/env python3
"""支付服务的 HTTP 冒烟测试（不需要真实商户密钥 / 商户号）。

覆盖两种部署形态：
  A. 只配易支付        —— 现在要部署的样子（第三方通道，零门槛）
  B. 易支付 + 支付宝 + 微信 —— 将来备案主体变更、拿到商户号之后

验证：
  · 服务能正常启动、健康检查如实报告已配渠道
  · 无登录态 / 无订单号时正确拒绝
  · 三个渠道的回调「签名不对时必须拒绝」（最关键：绝不能信未验签的报文）
  · 易支付的 GET 与 POST 两种通知方式都要接
  · 未配置的渠道回调返回 503，而不是误判成功

注：配置里的 supabase_url 指向本机一个关闭的端口，
    这样「验签通过后进入业务逻辑」的那几条用例会立刻失败返回，不用等外网超时。

跑法：python3 test_server_smoke.py
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from epay import Epay as Mapay  # noqa: E402  兼容旧测试里的别名

PORT = 4199
FAILED = 0

# 假凭据 —— 只用于本地自测，不对应任何真实商户
MP_PID = "13419"
MP_KEY = "G5o9SmokeTestKeySmokeTestKeynYsB"
# 故意不通的地址：让「验签通过之后」的业务调用立刻失败
DEAD_SUPABASE = "http://127.0.0.1:9"
DEAD_SUPABASE_ANON = "anon_test_key"


def check(name: str, cond: bool, extra: str = "") -> None:
    global FAILED
    if not cond:
        FAILED += 1
    print(f"  [{'通过' if cond else '失败'}] {name}{('  ' + extra) if extra else ''}")


def gen_keypair(tmp: str, tag: str) -> tuple[str, str]:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    priv = os.path.join(tmp, f"{tag}_private.pem")
    pub = os.path.join(tmp, f"{tag}_public.pem")
    with open(priv, "wb") as f:
        f.write(key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        ))
    with open(pub, "wb") as f:
        f.write(key.public_key().public_bytes(
            serialization.Encoding.PEM,
            serialization.PublicFormat.SubjectPublicKeyInfo,
        ))
    return priv, pub


def make_config(tmp: str, with_epay: bool, with_alipay: bool, with_wechat: bool) -> str:
    cfg: dict = {
        "listen_host": "127.0.0.1",
        "listen_port": PORT,
        "supabase_url": DEAD_SUPABASE,
        "supabase_anon_key": DEAD_SUPABASE_ANON,
        "callback_secret": "test_secret_not_real",
    }
    if with_epay:
        cfg["epay"] = {
            "pid": MP_PID,
            "key": MP_KEY,
            "gateway": "https://pay.example.com",
            "notify_url": "http://127.0.0.1/api/pay/notify/epay",
            "return_url": "http://127.0.0.1/#/membership",
            "sitename": "工商真题库",
            "pay_types": ["alipay", "wxpay"],
            "amount_tolerance_cents": 10,
            "amount_tolerance_ppm": 20000,
        }
    if with_alipay:
        priv, pub = gen_keypair(tmp, "ali")
        cfg["alipay"] = {
            "app_id": "2021000000000000",
            "app_private_key_path": priv,
            "alipay_public_key_path": pub,
            "notify_url": "http://127.0.0.1/api/pay/notify/alipay",
            "return_url": "http://127.0.0.1/#/membership",
        }
    if with_wechat:
        priv, pub = gen_keypair(tmp, "wx")
        cfg["wechat"] = {
            "appid": "wx_test_appid_0001",
            "app_secret": "test_app_secret",
            "mchid": "1900000001",
            "api_v3_key": "A" * 32,
            "merchant_serial": "ABCDEF1234567890",
            "merchant_key_path": priv,
            "wxpay_public_key_path": pub,
            "notify_url": "http://127.0.0.1/api/pay/notify/wechat",
        }
    path = os.path.join(tmp, "config.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False)
    return path


def get(path: str):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}{path}", timeout=10) as r:
            text = r.read().decode()
            try:
                return r.status, json.loads(text or "{}")
            except json.JSONDecodeError:
                return r.status, {"text": text}
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(text)
        except json.JSONDecodeError:
            return exc.code, {"text": text}


def post(path: str, payload=None, headers=None, raw: str | None = None):
    if raw is None:
        body = json.dumps(payload or {}).encode()
        ctype = "application/json"
    else:
        body = raw.encode()
        ctype = "application/x-www-form-urlencoded"
    req = urllib.request.Request(
        f"http://127.0.0.1:{PORT}{path}", data=body, method="POST",
        headers={"Content-Type": ctype, **(headers or {})},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            text = resp.read().decode()
            try:
                return resp.status, json.loads(text or "{}")
            except json.JSONDecodeError:
                return resp.status, {"text": text}
    except urllib.error.HTTPError as exc:
        text = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(text)
        except json.JSONDecodeError:
            return exc.code, {"text": text}


def epay_notify_params(_force_sign: str | None = None, **over) -> dict[str, str]:
    """造一份易支付通知报文（默认签名正确）。

    _force_sign：显式指定一个错误的 sign，用来测「验签必须拦住」。
                 必须在算完正确签名之后再覆盖，否则会被盖回去。
    """
    p: dict[str, str] = {
        "pid": MP_PID,
        "trade_no": "2026101500001",
        "out_trade_no": "CTBU202610150406AAAA1111",
        "type": "alipay",
        "name": "工商真题库 单月会员",
        "money": "3.77",
        "trade_status": "TRADE_SUCCESS",
        "param": "",
    }
    p.update({k: v for k, v in over.items() if v is not None})
    signer = Mapay({"pid": MP_PID, "key": MP_KEY, "gateway": "https://pay.example.com"})
    p["sign"] = signer.sign(p)
    p["sign_type"] = "MD5"
    if _force_sign:
        p["sign"] = _force_sign
    return p


def run_case(label: str, tmp: str, with_epay: bool, with_alipay: bool, with_wechat: bool) -> None:
    print(f"\n{'='*58}\n场景：{label}\n{'='*58}")
    cfg_path = make_config(tmp, with_epay, with_alipay, with_wechat)
    proc = subprocess.Popen(
        [sys.executable, os.path.join(HERE, "pay_service.py")],
        env={**os.environ, "CTBU_PAY_CONFIG": cfg_path},
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )
    try:
        for _ in range(40):
            try:
                st, _d = get("/api/pay/health")
                if st == 200:
                    break
            except Exception:  # noqa: BLE001
                pass
            time.sleep(0.25)
        else:
            print("服务未能启动")
            global FAILED
            FAILED += 1
            return

        print("\n1. 健康检查如实报告渠道")
        _st, d = get("/api/pay/health")
        ch = d.get("channels", {})
        check(f"epay 应报告为 {with_epay}", ch.get("epay") is with_epay, str(ch))
        check(f"alipay 应报告为 {with_alipay}", ch.get("alipay") is with_alipay, str(ch))
        check(f"wechat 应报告为 {with_wechat}", ch.get("wechat") is with_wechat, str(ch))
        if with_epay:
            check("健康检查带出已开通支付方式",
                  d.get("epay_types") == ["alipay", "wxpay"], str(d.get("epay_types")))

        print("\n2. 创建支付 —— 异常入参")
        st, d = post("/api/pay/create", {})
        check("缺订单号 → 400", st == 400 and d.get("reason") == "missing_order_no", f"HTTP {st}")
        st, d = post("/api/pay/create", {"order_no": "CTBU202610150406AAAA1111"})
        check("无登录态 → 401", st == 401 and d.get("reason") == "not_logged_in", f"HTTP {st}")

        print("\n3. 易支付通知 —— 验签必须拦住（POST）")
        if with_epay:
            st, d = post("/api/pay/notify/epay", raw=urllib.parse.urlencode(
                {k: v for k, v in epay_notify_params(_force_sign="deadbeef" * 4).items()}))
            check("伪造 sign → 400 fail", st == 400 and d.get("text") == "fail", f"HTTP {st}")

            body = epay_notify_params()
            body.pop("sign")
            st, d = post("/api/pay/notify/epay", raw=urllib.parse.urlencode(body))
            check("缺 sign → 400 fail", st == 400 and d.get("text") == "fail", f"HTTP {st}")

            # 签名正确但 pid 不是本商户：别的商户的通知不能开通我们的单
            bad_pid = epay_notify_params(pid="99999")
            st, d = post("/api/pay/notify/epay", raw=urllib.parse.urlencode(bad_pid))
            check("别人的 pid → 400 fail", st == 400 and d.get("text") == "fail", f"HTTP {st}")

            # 签名正确 → 通过验签进入业务；此时数据库不可达，应返回 500 fail
            # （HTTP 400 → 500 的差别正好证明「签名被接受了」）
            good = epay_notify_params()
            st, d = post("/api/pay/notify/epay", raw=urllib.parse.urlencode(good))
            check("签名正确 → 通过验签（业务失败回 500 fail）",
                  st == 500 and d.get("text") == "fail", f"HTTP {st}")

            print("\n4. 易支付通知 —— GET 方式也要接")
            qs = urllib.parse.urlencode(epay_notify_params(_force_sign="deadbeef" * 4))
            st, d = get(f"/api/pay/notify/epay?{qs}")
            check("GET 伪造 sign → 400 fail", st == 400 and d.get("text") == "fail", f"HTTP {st}")
            qs = urllib.parse.urlencode(epay_notify_params())
            st, d = get(f"/api/pay/notify/epay?{qs}")
            check("GET 签名正确 → 通过验签", st == 500 and d.get("text") == "fail", f"HTTP {st}")
        else:
            st, d = post("/api/pay/notify/epay", raw="pid=1")
            check("未配易支付 → 503 fail", st == 503 and d.get("text") == "fail", f"HTTP {st}")

        print("\n5. 支付宝异步通知 —— 验签必须拦住")
        form = urllib.parse.urlencode({
            "app_id": "2021000000000000", "out_trade_no": "X",
            "trade_status": "TRADE_SUCCESS", "total_amount": "3.80",
            "sign_type": "RSA2",
            "sign": base64.b64encode(b"fake" * 100).decode(),
        })
        st, d = post("/api/pay/notify/alipay", raw=form)
        if with_alipay:
            check("伪造签名 → 400 failure", st == 400 and d.get("text") == "failure", f"HTTP {st}")
        else:
            check("未配支付宝 → 503 failure", st == 503 and d.get("text") == "failure", f"HTTP {st}")

        print("\n6. 微信回调 —— 验签必须拦住")
        body = {"id": "evt", "event_type": "TRANSACTION.SUCCESS", "resource": {}}
        st, d = post("/api/pay/notify/wechat", body, {
            "Wechatpay-Timestamp": str(int(time.time())),
            "Wechatpay-Nonce": uuid.uuid4().hex.upper(),
            "Wechatpay-Signature": base64.b64encode(b"fake" * 100).decode(),
        })
        if with_wechat:
            check("伪造签名 → 401 且 FAIL", st == 401 and d.get("code") == "FAIL", f"HTTP {st}")
        else:
            check("未配微信 → 503 且 FAIL", st == 503 and d.get("code") == "FAIL", f"HTTP {st}")

        print("\n7. 主动查单兜底 /api/pay/recheck")
        st, d = post("/api/pay/recheck", {})
        expect = "missing_order_no" if with_epay else "epay_not_configured"
        check(f"缺订单号 → 400 {expect}",
              st == 400 and d.get("reason") == expect, f"HTTP {st} {d.get('reason')}")
        st, d = post("/api/pay/recheck", {"order_no": "CTBU202610150406AAAA1111"})
        expect = "not_logged_in" if with_epay else "epay_not_configured"
        check(f"无登录态 → 401 {expect}",
              st == 401 and d.get("reason") == expect, f"HTTP {st} {d.get('reason')}")

        print("\n8. 未知路径")
        st, _d = post("/api/pay/nope", {})
        check("未知路径 → 404", st == 404, f"HTTP {st}")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        run_case("A. 只配易支付（现在要部署的形态）", tmp,
                 with_epay=True, with_alipay=False, with_wechat=False)
        run_case("B. 易支付 + 支付宝 + 微信（将来）", tmp,
                 with_epay=True, with_alipay=True, with_wechat=True)

    print()
    if FAILED:
        print(f"结果：{FAILED} 项失败")
        return 1
    print("结果：全部通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
