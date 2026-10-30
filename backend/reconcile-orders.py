#!/usr/bin/env python3
"""对账补偿：把"学生说付了、但回调没到"的订单捞回来（2026-10-28 新增）。

为什么需要它
------------
支付回调可能因为任何原因丢失：平台抖动、nginx 502、我们重启、学生付完就关页面。
回调一旦丢了，`payment_orders` 里那笔就永远停在 `pending`，学生钱付了、会员不开，
而唯一的兜底是"学生自己点『我已完成付款』" —— 大多数人不会点，直接来投诉。

这个脚本每 10 分钟跑一次：
  1. 取最近 6 小时内仍 pending 的订单；
  2. 逐笔去平台查单（易支付 `is_paid`，含 -alipay / -wxpay 两个候选后缀）；
  3. 查到已付 → 调 `confirm_payment_auto` 正常开通（幂等，重复跑安全）；
  4. 金额不符 → 写 payment_alerts 并给管理员发信（不自动开通，避免被少付薅）。

安全性
------
  · 只读平台 + 走我们自己的幂等开通函数，不会重复发放；
  · 单次最多处理 40 笔，避免把平台接口打成压力测试；
  · 全部异常吞掉只记日志 —— 一个坏订单不能让整轮对账中断。

部署
----
    /etc/cron.d/ctbu-reconcile ：  */10 * * * * root /usr/bin/python3 /opt/ctbu-pay/reconcile-orders.py
日志：/var/log/ctbu-reconcile.log

手工跑一次（排查用）：
    sudo python3 /opt/ctbu-pay/reconcile-orders.py --dry-run
"""

from __future__ import annotations

import json
import logging
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import db  # noqa: E402

CONFIG_PATH = os.environ.get("CTBU_PAY_CONFIG", "/etc/ctbu-pay/config.json")
LOOKBACK_HOURS = 6
MAX_ORDERS = 40

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    stream=sys.stdout,
)
log = logging.getLogger("ctbu-reconcile")


def load_cfg() -> dict:
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


def main() -> int:
    dry = "--dry-run" in sys.argv
    cfg = load_cfg()
    db.load_config(CONFIG_PATH)
    db.init_pool(minconn=1, maxconn=3)

    secret = str(cfg.get("callback_secret") or "")
    ep_cfg = cfg.get("epay") or {}
    epay = None
    if ep_cfg.get("pid") and ep_cfg.get("key") and ep_cfg.get("gateway"):
        from epay import Epay
        epay = Epay(ep_cfg)

    rows = db.execute(
        "select order_no, tier, amount_cents, provider, created_at"
        "  from public.payment_orders"
        " where status = 'pending'"
        "   and created_at > now() - make_interval(hours => %s)"
        " order by created_at asc"
        " limit %s", [LOOKBACK_HOURS, MAX_ORDERS])
    if not rows:
        log.info("没有需要核对的订单")
        return 0

    log.info("待核对订单 %d 笔（近 %d 小时）", len(rows), LOOKBACK_HOURS)
    fixed = 0
    for row in rows:
        order_no = row["order_no"]
        try:
            paid, info = _query(epay, order_no)
        except Exception as exc:  # noqa: BLE001
            log.warning("查单失败 %s：%s", order_no, exc)
            continue
        if not paid:
            continue

        # 金额从平台返回值里取；取不到就交给数据库按精确值判断（会走 amount_mismatch 告警）
        paid_cents = _to_cents(info.get("money")) if isinstance(info, dict) else None
        log.warning("对账发现已付款 %s 平台实收=%s 订单金额=%s provider=%s",
                    order_no, paid_cents, row["amount_cents"], row["provider"])
        if dry:
            continue
        try:
            result = db.rpc("confirm_payment_auto", {
                "p_order_no": order_no,
                "p_transaction_id": (info or {}).get("trade_no") or "",
                "p_paid_cents": paid_cents,
                "p_provider": "reconcile",
                "p_secret": secret,
                "p_payload": json.dumps({"source": "reconcile", "info": info},
                                        ensure_ascii=False),
            })
        except Exception as exc:  # noqa: BLE001
            log.error("对账开通失败 %s：%s", order_no, exc)
            continue

        if result.get("ok"):
            fixed += 1
            log.info("对账补开通成功 %s reason=%s", order_no, result.get("reason"))
        else:
            log.error("对账被拒 %s result=%s", order_no, result)
            try:
                db.execute(
                    "insert into public.payment_alerts (kind, order_no, detail)"
                    " values ('reconcile_rejected', %s, %s)",
                    [order_no, json.dumps(result, ensure_ascii=False)])
            except Exception:  # noqa: BLE001
                pass

    log.info("对账结束：处理 %d 笔，补开通 %d 笔", len(rows), fixed)
    return 0


def _query(epay, order_no: str):
    """按候选单号查单。与 pay_service.query_order_variants 保持一致。"""
    if epay is None:
        return False, None
    first = None
    for cand in (order_no, f"{order_no}-alipay", f"{order_no}-wxpay"):
        try:
            paid, ret = epay.is_paid(order_no=cand)
        except Exception as exc:  # noqa: BLE001
            log.warning("查单出错 %s：%s", cand, exc)
            continue
        if paid:
            return True, ret
        first = first or ret
    return False, first


def _to_cents(money) -> int | None:
    try:
        return int(round(float(money) * 100))
    except (TypeError, ValueError):
        return None


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        log.exception("对账脚本异常：%s", exc)
        sys.exit(1)
