#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""违规累计与封禁 —— 两类违规共用一个计数器。

政策（2026-10-20 用户第二次修订）：
  · 一个账号最多 **2 台设备**登录；第 3 台尝试登录 → 阻止 + 计一次违规。
  · 这 2 台**不允许同时查看**真题/四六级（120 秒窗口内都有关注心跳即算）。
  · **两类违规共同累计**（多设备登录 / 同时查看）。
  · 处罚阶梯（同一计数器）：
        第 1 次 → 警告（弹窗，不封号）
        第 2 次 → 封 1 天
        第 3 次 → 封 1 周
        第 4 次 → 封 1 年
        第 5 次 → 永久封号
  · 首次警告的文案**只讲"再犯会被封号"，不写封多久** —— 用户明确要求。

检测节奏：
  前端每 **120 秒**打一次心跳；服务端窗口也取 120 秒。
  去重窗口 150 秒（略大于一个心跳周期）：
    · 同一次并发里两台设备各触发一次 → 只算 1 次（不会两倍计）
    · 但「下一次刷新还是两台在线」→ 150 秒后确实算第 2 次（正好落到"封 1 天"）
"""
from __future__ import annotations

import logging
from typing import Any

log = logging.getLogger("ctbu-concur")

# 心跳周期 120s（用户指定）；判定窗口同为 120s
WINDOW_SECONDS = 120
# 去重窗口：比一个心跳周期略长，保证「两台设备同一轮只算一次」，
# 又保证「下一轮仍在并发」能升级到下一档（用户要求的行为）
DEDUPE_SECONDS = 150

# 处罚阶梯：次数 → (等级, interval, 人话)
# level 1 = 警告不封；2..4 = 定时封禁；5 = 永久
PENALTIES = {
    1: (1, None, "警告"),
    2: (2, "1 day", "封禁 1 天"),
    3: (3, "7 days", "封禁 1 周"),
    4: (4, "1 year", "封禁 1 年"),
    5: (5, None, "永久封号"),
}
MAX_STAGE = 5
PERMANENT_UNTIL = "2099-12-31"

# 首次警告的文案：只说后果，不说时长（用户要求）
WARNING_TEXT = (
    "这是第 1 次违规，本次只警告、不封号。"
    "如果再次违反，你的账号将被封号，届时将无法查看任何真题与四六级资料。"
)

APPEAL_NOTE = (
    "如果你认为这是误判（例如同一台手机换浏览器、或网络异常导致记录重复），"
    "可以通过站内「违规申诉」提交，并附上账号邮箱与大致时间。"
)


def current_ban(db, uid: str) -> dict[str, Any] | None:
    """该用户当前是否处于封禁中。返回 {level, until, reason, permanent} 或 None。"""
    if db is None:
        return None
    rows = db.execute(
        "select ban_level, ban_until, ban_reason from public.profiles "
        "where id = %s and ban_until is not null and ban_until > now()", [uid])
    if not rows:
        return None
    r = rows[0]
    return {
        "level": r["ban_level"],
        "until": r["ban_until"],
        "reason": r["ban_reason"],
        "permanent": (r["ban_level"] or 0) >= MAX_STAGE,
    }


def violation_count(db, uid: str) -> int:
    """该用户已累计的违规次数（两类违规共用）。"""
    if db is None:
        return 0
    rows = db.execute(
        "select count(*)::int as n from public.concurrent_violations where user_id = %s", [uid])
    return int(rows[0]["n"]) if rows else 0


def _apply(db, uid: str, kind: str, detail: dict, stage: int) -> dict[str, Any]:
    """落一条违规 + 按阶梯施加处罚。stage 已 clamp 到 1..5。"""
    level, interval, label = PENALTIES[stage]
    db.execute(
        "insert into public.concurrent_violations (user_id, kind, detail, level) "
        "values (%s, %s, %s, %s)",
        [uid, kind, __import__("json").dumps(detail, ensure_ascii=False), level])

    if stage >= MAX_STAGE:
        # 永久：给一个极远的到期时间，并置 level=5 供前端识别
        db.execute(
            "update public.profiles set ban_level = %s, ban_reason = %s, "
            "ban_until = %s::timestamptz where id = %s",
            [level, f"{kind}（第 {stage} 次·永久）", PERMANENT_UNTIL, uid])
    elif interval:
        db.execute(
            "update public.profiles set ban_level = %s, ban_reason = %s, "
            "ban_until = now() + (%s)::interval where id = %s",
            [level, f"{kind}（第 {stage} 次）", interval, uid])

    return {
        "stage": stage,
        "level": level,
        "label": label,
        "permanent": stage >= MAX_STAGE,
        "message": WARNING_TEXT if stage == 1 else f"这是第 {stage} 次违规：{label}。",
        "appeal_hint": APPEAL_NOTE,
    }


def bump(db, uid: str, kind: str, detail: dict) -> dict[str, Any]:
    """记一次违规并升级处罚。**两类违规共用同一个计数器**。

    返回 {stage, level, label, deduped?} —— deduped=True 表示 150 秒内重复触发，
    没有真的加次数（避免一次并发被两台设备各算一遍）。
    """
    if db is None:
        return {"stage": 0, "deduped": True}

    recent = db.execute(
        "select count(*)::int as n from public.concurrent_violations "
        "where user_id = %s and created_at > now() - (%s || ' seconds')::interval",
        [uid, str(DEDUPE_SECONDS)])
    if recent and recent[0]["n"] > 0:
        n = violation_count(db, uid)
        stage = min(max(n, 1), MAX_STAGE)
        level, _, label = PENALTIES[stage]
        return {"stage": stage, "level": level, "label": label,
                "permanent": stage >= MAX_STAGE, "deduped": True,
                "message": WARNING_TEXT if stage == 1 else f"当前累计第 {stage} 次违规：{label}。",
                "appeal_hint": APPEAL_NOTE}

    stage = min(violation_count(db, uid) + 1, MAX_STAGE)
    res = _apply(db, uid, kind, detail, stage)
    log.warning("违规：uid=%s kind=%s 第%d次 → %s", uid[:8], kind, stage, res["label"])
    return res


def heartbeat(db, uid: str, device_id: str, resource: str,
              ip: str | None = None) -> dict[str, Any]:
    """记录一次「正在查看」，并判断是否与另一台设备并发。

    返回：
      {"verdict": "ok"}
      {"verdict": "concurrent", ...处罚内容}     —— 判为同时查看
      {"verdict": "banned", ...}                 —— 处于封禁期
    """
    if db is None:
        return {"verdict": "ok"}

    # ⚠️ 不能先判封禁就 return：否则封禁后永远走不到第 3/4/5 次（2026-10-20 自测抓到）
    banned = current_ban(db, uid)

    device_id = (device_id or "").strip()[:64]
    if not device_id:
        if banned:
            return {"verdict": "banned", **banned, "appeal_hint": APPEAL_NOTE}
        return {"verdict": "ok"}

    db.execute(
        "insert into public.view_heartbeats (user_id, device_id, resource, ip, seen_at) "
        "values (%s, %s, %s, %s, now()) "
        "on conflict (user_id, device_id) do update set "
        "  resource = excluded.resource, ip = excluded.ip, seen_at = now()",
        [uid, device_id, (resource or "")[:80], ip])

    others = db.execute(
        "select device_id, resource, seen_at from public.view_heartbeats "
        "where user_id = %s and device_id <> %s "
        "and seen_at > now() - (%s || ' seconds')::interval "
        "order by seen_at desc limit 1",
        [uid, device_id, str(WINDOW_SECONDS)])

    if not others:
        if banned:
            return {"verdict": "banned", **banned, "appeal_hint": APPEAL_NOTE}
        return {"verdict": "ok"}

    other = others[0]
    res = bump(db, uid, "concurrent_view", {
        "self_device": device_id, "other_device": other["device_id"],
        "other_resource": other["resource"], "ip": ip, "window_s": WINDOW_SECONDS,
    })
    return {"verdict": "concurrent", "other_device": other["device_id"], **res}


def bump_device_login(db, uid: str, device_id: str, ip: str | None = None) -> dict[str, Any]:
    """第 3 台设备尝试登录 —— 阻止，并计一次违规（与同时查看共用计数器）。"""
    return bump(db, uid, "device_overflow", {
        "attempt_device": (device_id or "")[:64], "ip": ip, "max_devices": 2,
    })


def submit_appeal(db, uid: str, reason: str, message: str, contact: str) -> bool:
    """提交申诉。24 小时内只允许一条待处理申诉，防刷。"""
    if db is None:
        return False
    pend = db.execute(
        "select count(*)::int as n from public.appeals "
        "where user_id = %s and status = 'pending' "
        "and created_at > now() - interval '24 hours'", [uid])
    if pend and pend[0]["n"] > 0:
        return False
    db.execute(
        "insert into public.appeals (user_id, reason, message, contact) "
        "values (%s, %s, %s, %s)",
        [uid, (reason or "concurrent_view")[:40], (message or "")[:2000], (contact or "")[:120]])
    return True
