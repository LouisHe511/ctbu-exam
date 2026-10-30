#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
通道在线看门狗 —— 易支付「云端」通道过夜掉线是常态，本脚本负责发现并通知站长。

背景
    「云端」类通道靠平台与站长本人的支付宝/微信账号保持登录，掉线是常态。
    掉线的唯一危害是「学生付不了钱」，但真正的风险是**站长不知道**。
    本脚本定期探针，一旦发现通道不可用就推送提醒。

做三件事
    1. 探针：调用平台 API 下单接口，下一笔 ¥0.01 的「系统自检」订单
       —— 有可用通道 → code=1；无可用通道 → 返回错误
    2. 判态：连续 fail_threshold 次探针都失败 → 判定「掉线」
    3. 告警：状态变化时推送，并遵守静默期，避免半夜轰炸

推送渠道（在 watchdog.json 里配置，任一可用即可）
    · 邮件            —— **首选**：`smtp_*` / `alert_to`。免费、无条数限制、零新账号新 App。
                        复用本站已有的 QQ 邮箱 SMTP（Supabase 注册邮件就走它）。
    · wecom_webhook   —— 备选：企业微信群机器人。免费不限量、腾讯官方接口，
                        但需先在群设置里加「群机器人」拿到 Webhook。
    · pushplus_token  —— 备选：PushPlus。⚠️ 2024-08 起未实名用户所有渠道 0 次，需 3.9 元实名

⚠️ 代价（必须知道）
    每次探针都会在**易支付平台**留下一笔「待支付→支付超时」的订单，
    这会拉低平台侧的「成功率」统计。默认每小时 1 次（24 笔/天），
    觉得太频繁就调大 interval_minutes。

用法
    python3 channel-watchdog.py              # 探一次（cron 用这个）
    python3 channel-watchdog.py --status     # 只看当前状态，不探针
    python3 channel-watchdog.py --test-push  # 只测推送通道能否到达

文件
    配置 /etc/ctbu-pay/watchdog.json     （600, root:www-data）
    状态 /var/lib/ctbu-pay/watchdog-state.json
    日志 /var/log/ctbu-pay-watchdog.log
"""

from __future__ import annotations

import importlib.util
import json
import os
import smtplib
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone, timedelta
from email.message import EmailMessage

# ---------------------------------------------------------------- 常量

CONFIG_PATH = "/etc/ctbu-pay/watchdog.json"
PAY_CONFIG_PATH = "/etc/ctbu-pay/config.json"
STATE_PATH = "/var/lib/ctbu-pay/watchdog-state.json"
LOG_PATH = "/var/log/ctbu-pay-watchdog.log"
EPAY_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "epay.py")

CST = timezone(timedelta(hours=8))

DEFAULT_CONFIG = {
    "enabled": True,
    "interval_minutes": 60,
    "fail_threshold": 1,      # 连续失败几次算「掉线」
    "silence_hours": 6,       # 同一状态多久内不重复推送
    "probe_types": ["alipay", "wxpay"],
    # —— 推送渠道（任一可用即可，都没配置时只写日志）——
    # ① 邮件（推荐：免费、无条数限制、零新账号）
    "smtp_host": "smtp.qq.com",
    "smtp_port": 465,
    "smtp_user": "",          # 发件邮箱，如 ops@example.com
    "smtp_pass": "",          # QQ 邮箱的 16 位「授权码」（不是登录密码）
    "smtp_from_name": "收款监控",
    "alert_to": "",           # 收件邮箱；留空则发给 smtp_user 自己
    # ② 企业微信群机器人 Webhook（免费不限量，但需先有群机器人入口）
    "wecom_webhook": "",
    # ③ PushPlus（⚠️ 2024-08 起未实名用户所有渠道 0 次，需 3.9 元实名）
    "pushplus_token": "",
    "log_keep_lines": 800,
}


def now_cst() -> datetime:
    return datetime.now(CST)


def log(msg: str) -> None:
    line = f"{now_cst():%Y-%m-%d %H:%M:%S}  {msg}"
    print(line, flush=True)
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        with open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass


def trim_log(keep: int) -> None:
    """日志只保留最近 N 行，防止无限增长。"""
    try:
        with open(LOG_PATH, encoding="utf-8") as fh:
            lines = fh.readlines()
        if len(lines) > keep:
            with open(LOG_PATH, "w", encoding="utf-8") as fh:
                fh.writelines(lines[-keep:])
    except OSError:
        pass


def load_json(path: str, default: dict) -> dict:
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else dict(default)
    except (OSError, ValueError):
        return dict(default)


def save_json(path: str, data: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def load_epay():
    """从同目录加载 epay.py（通用易支付客户端）。

    2026-10-23：原来加载的是旧平台的客户端模块，换到易支付后那个文件已删除，
    看门狗从 2026-10-21 起连续失败 43 次、每小时给站长发一封「通道掉线」邮件
    —— 不是通道真的挂了，是它找的文件根本不存在。这里改成加载 epay.py。
    """
    spec = importlib.util.spec_from_file_location("epay_watchdog", EPAY_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"无法加载 {EPAY_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------- 推送

def push_wechat(token: str, title: str, content: str) -> tuple[bool, str]:
    """通过 PushPlus 推送到微信。返回 (是否成功, 说明)。"""
    if not token:
        return False, "未配置 pushplus_token"
    payload = json.dumps({
        "token": token,
        "title": title,
        "content": content,
        "template": "txt",
    }).encode("utf-8")
    req = urllib.request.Request(
        "https://www.pushplus.plus/send",
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode("utf-8", "ignore")
    except urllib.error.HTTPError as exc:
        return False, f"HTTP {exc.code}"
    except Exception as exc:  # noqa: BLE001 - 网络异常一律降级为推送失败
        return False, f"{type(exc).__name__}: {exc}"

    try:
        parsed = json.loads(body)
    except ValueError:
        return False, f"返回非 JSON：{body[:120]}"
    if str(parsed.get("code")) in ("200", "0"):
        return True, "已推送"
    return False, f"平台返回：{body[:160]}"


def push_email(cfg: dict, title: str, content: str) -> tuple[bool, str]:
    """
    通过 SMTP 发告警邮件（首选渠道）。

    推荐理由：**免费、没有条数限制、不需要新账号新 App**。
    本站已有可用的 QQ 邮箱 SMTP（Supabase 的注册邮件就走它），复用同一套凭据即可。
    手机上 QQ 邮箱 App 会弹推送，微信里的「QQ 邮箱提醒」也能收到。

    ⚠️ smtp_pass 是 QQ 邮箱的 **16 位「授权码」**，不是 QQ 登录密码。
       获取：QQ 邮箱 → 设置 → 账户 → 开启「IMAP/SMTP 服务」→ 生成授权码。
    """
    host = cfg.get("smtp_host") or "smtp.qq.com"
    try:
        port = int(cfg.get("smtp_port") or 465)
    except (TypeError, ValueError):
        port = 465
    user = (cfg.get("smtp_user") or "").strip()
    pwd = (cfg.get("smtp_pass") or "").strip()
    to = (cfg.get("alert_to") or user).strip()

    if not (user and pwd and to):
        return False, "未配置 smtp_user / smtp_pass / alert_to"

    msg = EmailMessage()
    # ⚠️ Python 3.12 起 EmailMessage 用的是新 policy，头部必须传**字符串**，
    #    传 email.header.Header 对象会在序列化时抛 TypeError: 'Header' object is not subscriptable。
    #    非 ASCII 的中文主题/发件人名由 policy.default 自动做 RFC 2047 编码，不用手动包 Header。
    msg["From"] = f"{cfg.get('smtp_from_name') or '收款监控'} <{user}>"
    msg["To"] = to
    msg["Subject"] = title
    msg.set_content(content)

    try:
        if port == 465:
            with smtplib.SMTP_SSL(host, port, timeout=25) as server:
                server.login(user, pwd)
                server.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=25) as server:
                server.starttls()
                server.login(user, pwd)
                server.send_message(msg)
    except smtplib.SMTPAuthenticationError:
        return False, "认证失败（授权码不对，或该邮箱没开启 SMTP 服务）"
    except Exception as exc:  # noqa: BLE001
        return False, f"{type(exc).__name__}: {exc}"

    return True, f"已发送到 {to}"


def push_wecom(webhook: str, title: str, content: str) -> tuple[bool, str]:
    """
    通过企业微信群机器人 Webhook 推送。

    这是首选渠道：企业微信**免费注册**（不用营业执照）、群机器人 **Webhook 免费且不限量**、
    腾讯官方接口，手机上装企业微信 App 即可收到通知。
    频率限制：每个机器人 20 条/分钟 —— 我们一天最多几条，远不会触碰。
    """
    if not webhook:
        return False, "未配置 wecom_webhook"
    if not webhook.startswith("http"):
        return False, "wecom_webhook 必须以 http 开头（应是完整 Webhook 地址）"

    payload = json.dumps({
        "msgtype": "text",
        "text": {"content": f"{title}\n{content}"},
    }).encode("utf-8")
    req = urllib.request.Request(
        webhook, data=payload, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            body = resp.read().decode("utf-8", "ignore")
    except urllib.error.HTTPError as exc:
        return False, f"HTTP {exc.code}"
    except Exception as exc:  # noqa: BLE001
        return False, f"{type(exc).__name__}: {exc}"

    try:
        parsed = json.loads(body)
    except ValueError:
        return False, f"返回非 JSON：{body[:120]}"
    if int(parsed.get("errcode", -1)) == 0:
        return True, "已推送"
    return False, f"企业微信返回：{body[:160]}"


def push_all(cfg: dict, title: str, content: str) -> tuple[bool, str]:
    """
    向所有已配置的渠道推送；任一成功即算成功。
    渠道顺序：邮件（首选）→ 企业微信 → PushPlus。
    都没配置时返回失败，但调用方只记日志、不报错。
    """
    results: list[str] = []
    any_ok = False

    if cfg.get("smtp_user") and cfg.get("smtp_pass"):
        ok, why = push_email(cfg, title, content)
        results.append(f"邮件：{'成功' if ok else '失败（' + why + '）'}")
        any_ok = any_ok or ok

    if cfg.get("wecom_webhook"):
        ok, why = push_wecom(cfg["wecom_webhook"], title, content)
        results.append(f"企业微信：{'成功' if ok else '失败（' + why + '）'}")
        any_ok = any_ok or ok

    if cfg.get("pushplus_token"):
        ok, why = push_wechat(cfg["pushplus_token"], title, content)
        results.append(f"PushPlus：{'成功' if ok else '失败（' + why + '）'}")
        any_ok = any_ok or ok

    if not results:
        return False, "未配置任何推送渠道（邮件 / wecom_webhook / pushplus_token 都是空）"
    return any_ok, "；".join(results)


# ---------------------------------------------------------------- 探针

def probe_one(client, pay_type: str) -> dict:
    """探一个支付方式是否可用。

    判定标准：**平台是否接单**（code == 1），而不是"有没有返回支付链接"。
    原因：有的通道 API 下单不返回链接（要走页面方式），
          但平台接了单就说明**这个通道是活的**。以"必须有链接"为准则会误报。

    无可用通道时，平台会返回 code != 1（实测文案：「没有找到可用支付账号」）。
    """
    order_no = f"SELFTEST{now_cst():%Y%m%d%H%M%S}{pay_type[:2]}"
    try:
        result = client.create_order(order_no, 1, "系统自检", pay_type=pay_type)
    except Exception as exc:  # noqa: BLE001
        # ⚠️ 2026-10-23 修：微信通道**一直是好的**，是这里判错了。
        #
        # 云熠的 mapi.php 对微信只回 `{code:1, msg:success, trade_no, money}`，
        # **不给 payurl / qrcode / urlscheme**（微信走的是页面方式）。
        # 而 Epay.create_order 见到"code=1 但没有支付地址"会抛
        # EpayError(code='no_pay_url')。
        # 原来的逻辑把这当成失败 → 微信每小时被误报"不可用"，
        # 而学生实际点「微信支付」是能正常跳到收银台的。
        #
        # 正确的判据：**平台接单了（code=1）就算通**。
        # no_pay_url 这个错误里带着平台的原始回执，code=1 说明单已建。
        code = getattr(exc, "code", "")
        raw = getattr(exc, "raw", None)
        if code == "no_pay_url" and isinstance(raw, dict) and str(raw.get("code")) == "1":
            return {"type": pay_type, "ok": True,
                    "detail": "ok（已接单，该方式不给 API 链接）"}
        detail = f"{type(exc).__name__}: {exc}"
        return {"type": pay_type, "ok": False, "detail": detail[:200]}

    if str(result.get("code")) == "1":
        has_url = bool(result.get("payurl") or result.get("qrcode") or result.get("urlscheme"))
        return {
            "type": pay_type,
            "ok": True,
            "detail": "ok" if has_url else "ok（已接单，该方式不给 API 链接）",
        }
    return {
        "type": pay_type,
        "ok": False,
        "detail": f"code={result.get('code')} msg={str(result.get('msg'))[:120]}",
    }


def probe_all(cfg: dict) -> tuple[bool, list[dict]]:
    """探所有配置的支付方式。返回 (是否全部可用, 明细)

    判定标准：只要有**任意一种**可用，就算"还有通道在线"；
             全部不可用才算"掉线"。
    """
    pay_cfg = load_json(PAY_CONFIG_PATH, {})
    epay_cfg = pay_cfg.get("epay") or {}
    if not epay_cfg.get("pid") or not epay_cfg.get("key"):
        return False, [{"type": "-", "ok": False,
                        "detail": "支付配置里没有 epay.pid / epay.key"}]

    epay_mod = load_epay()
    client = epay_mod.Epay(epay_cfg)

    types = cfg.get("probe_types") or ["alipay"]
    results = [probe_one(client, t) for t in types]
    return any(r["ok"] for r in results), results


# ---------------------------------------------------------------- 主流程

def fmt_results(results: list[dict]) -> str:
    names = {"alipay": "支付宝", "wxpay": "微信"}
    return " / ".join(
        f"{names.get(r['type'], r['type'])}：{'正常' if r['ok'] else '不可用'}"
        for r in results
    )


def run_once(force_alert: bool = False, force_run: bool = False) -> int:
    cfg = {**DEFAULT_CONFIG, **load_json(CONFIG_PATH, {})}
    if not cfg.get("enabled", True):
        log("看门狗已禁用（watchdog.json enabled=false），跳过")
        return 0

    state = load_json(STATE_PATH, {})
    prev_state = state.get("state", "unknown")
    prev_alert_at = float(state.get("last_alert_at") or 0)
    fail_streak = int(state.get("fail_streak") or 0)

    # 自我节流：cron 可以跑得比 interval_minutes 密，实际频率由配置决定
    last_check = float(state.get("last_check_at") or 0)
    interval_sec = int(cfg.get("interval_minutes", 60)) * 60
    if not force_run and last_check and (time.time() - last_check) < interval_sec - 30:
        return 0

    all_ok, results = probe_all(cfg)
    if all_ok:
        fail_streak = 0
        cur_state = "up"
    else:
        fail_streak += 1
        cur_state = "down" if fail_streak >= int(cfg.get("fail_threshold", 1)) else "up"

    log(f"探针：{fmt_results(results)}｜连续失败 {fail_streak} 次｜状态 {prev_state} → {cur_state}")

    silence_sec = int(cfg.get("silence_hours", 6)) * 3600
    now_ts = time.time()
    changed = cur_state != prev_state
    still_down_overdue = (
        cur_state == "down" and not changed and (now_ts - prev_alert_at) >= silence_sec
    )

    alerted = False
    if cur_state == "down" and (changed or still_down_overdue or force_alert):
        detail = "\n".join(f"· {r['type']}：{r['detail']}" for r in results)
        title = "⚠️ 收款通道掉线了"
        content = (
            f"时间：{now_cst():%Y-%m-%d %H:%M}\n"
            f"状态：{fmt_results(results)}\n\n"
            f"明细：\n{detail}\n\n"
            "处理：登录支付平台后台 → 通道管理，检查对应收款账号是否在线。\n"
            "恢复后本脚本会自动再发一条「已恢复」。"
        )
        ok, why = push_all(cfg, title, content)
        alerted = ok
        log(f"告警推送：{'成功' if ok else '失败'}（{why}）")
        if ok:
            prev_alert_at = now_ts
    elif cur_state == "up" and prev_state == "down":
        ok, why = push_all(
            cfg,
            "✅ 收款通道已恢复",
            f"时间：{now_cst():%Y-%m-%d %H:%M}\n状态：{fmt_results(results)}\n学生可以正常付款了。",
        )
        log(f"恢复推送：{'成功' if ok else '失败'}（{why}）")
        if ok:
            prev_alert_at = now_ts

    save_json(STATE_PATH, {
        "state": cur_state,
        "fail_streak": fail_streak,
        "last_alert_at": prev_alert_at,
        "last_check_at": now_ts,
        "last_results": results,
    })
    trim_log(int(cfg.get("log_keep_lines", 800)))
    return 0 if cur_state == "up" else 1


def show_status() -> int:
    cfg = {**DEFAULT_CONFIG, **load_json(CONFIG_PATH, {})}
    state = load_json(STATE_PATH, {})
    last = state.get("last_check_at")
    safe = {k: v for k, v in cfg.items()
            if k not in ("pushplus_token", "wecom_webhook", "smtp_pass")}
    print("配置：", json.dumps(safe, ensure_ascii=False))
    if cfg.get("smtp_user") and cfg.get("smtp_pass"):
        print("邮件推送：", f"已配置（{cfg['smtp_user']} → {cfg.get('alert_to') or cfg['smtp_user']}）")
    else:
        print("邮件推送：", "未配置")
    print("企业微信 Webhook：", "已配置" if cfg.get("wecom_webhook") else "未配置")
    print("PushPlus token：", "已配置" if cfg.get("pushplus_token") else "未配置")
    print("当前状态：", state.get("state", "（还没跑过）"))
    print("连续失败：", state.get("fail_streak", 0))
    print("上次检查：", f"{datetime.fromtimestamp(last, CST):%Y-%m-%d %H:%M:%S}" if last else "—")
    if state.get("last_results"):
        print("上次结果：", fmt_results(state["last_results"]))
    return 0


def main() -> int:
    args = sys.argv[1:]
    if "--status" in args:
        return show_status()
    if "--test-push" in args:
        cfg = {**DEFAULT_CONFIG, **load_json(CONFIG_PATH, {})}
        ok, why = push_all(
            cfg,
            "🔔 通道看门狗测试",
            f"这是一条测试消息，收到即说明告警链路正常。\n时间：{now_cst():%Y-%m-%d %H:%M}",
        )
        print("推送结果：", "成功" if ok else f"失败（{why}）")
        return 0 if ok else 1
    return run_once(force_alert="--force" in args, force_run="--force" in args or "--now" in args)


if __name__ == "__main__":
    sys.exit(main())
