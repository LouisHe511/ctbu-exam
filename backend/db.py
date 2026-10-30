#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""本地数据库访问层 —— 替代原来经 Supabase PostgREST 的 `sb_rpc()`。

为什么不用 PostgREST：
  · Ubuntu 源里没有它（只发 GitHub 静态二进制），而服务器拉 GitHub 不稳；
  · 多一个常驻服务 = 多一份内存 + 多一个暴露面，这台机器只有 1.9G 内存；
  · 我们的业务逻辑**本来就是 Postgres 函数**，直接用驱动调它们最省事，
    连参数名都不用重新拼接。

安全要点（这几条是红线，改动前请先想清楚）：
  1. **函数名走白名单** —— 绝不用字符串拼接方式把调用方传来的名字塞进 SQL。
     前端能影响到的只有"调哪个函数"和"参数值"，函数名必须在这里写死。
  2. **参数一律用占位符** —— 值永远不拼进 SQL 文本。
  3. **身份用会话变量注入**，与 Supabase 的做法一致：
     `set_config('request.jwt.claim.sub', <用户id>, true)`
     这样我们那 15 个业务函数里的 `auth.uid()` 一行都不用改。
     `true` 是 is_local：只在当前事务内有效，不会泄漏给下一个请求（**这点很关键**，
     连接池复用连接时必须用 is_local）。
"""

import os
import json
import logging
import re
import time
from contextlib import contextmanager

import psycopg2
import psycopg2.extras
import psycopg2.pool

log = logging.getLogger("ctbu.db")

# ----------------------------------------------------------------------
# 只允许调用这些函数。
# 与前端 `supabase.rpc(...)` 的 15 个调用点 + pay-service 自己用到的，
# 一一对应；新增函数必须同时加到这里，否则调不通（这是**故意的**）。
# ----------------------------------------------------------------------
ALLOWED_RPC = {
    # 会员与额度
    "my_membership",
    "my_access_status",
    # unlock_paper：**保留**，但参数在 data_rpc 里被裁剪过 —— 只允许传 p_paper_id，
    # 免费额度由服务端固定，调用方传 p_free_limit=999999 也无效（2026-10-28）。
    "unlock_paper",
    "is_admin",
    "is_lifetime",
    "count_login_only_papers",
    "increment_paper_view",
    # 邀请
    "claim_invite_rewards",
    "settle_invite_rewards",
    # 订单（用户侧）
    "create_payment_order",
    "mark_order_claimed",
    "order_status",
    # 订单（管理侧）—— 这些函数**内部**都有 `if not public.is_admin()` 兜底，
    # 所以放进白名单不会越权（详见 sql/2026-10-14-会员系统-补充.sql:18）
    "admin_list_orders",
    "admin_list_members",
    "admin_membership_stats",
    "admin_confirm_order",
    "admin_cancel_order",
    "admin_grant_membership",
    # 支付链路（服务端专用）
    "get_order_for_pay",
    "attach_prepay",
    "confirm_payment_auto",
}

# ----------------------------------------------------------------------
# 2026-10-28 安全修复（审计发现，**不要加回来**）
#
# 下面两个函数曾经在上面这个白名单里，而 `/api/data/rpc` 是**匿名可调**的：
#
#   grant_membership(p_uid, p_tier, p_months, ...)
#     → security definer 且函数体内没有任何 is_admin 判断。
#       任何人 POST {"fn":"grant_membership",
#                   "args":{"p_uid":"<自己的 uuid>","p_tier":"lifetime",...}}
#       就能给自己（或任意人）开永久会员。已实测接口会真的执行该函数。
#
#   unlock_paper(p_paper_id, p_free_limit default 3)
#     → 免费额度是**参数**，调用方传 p_free_limit=999999 即可把全库解锁。
#
# 二者在前端与 pay-service 里**都没有任何调用点**（grep 过：src/ 与
# pay-service/*.py 零引用），属于 Supabase 时代遗留的暴露面，删掉零风险。
# 若将来要恢复，必须改成 `_admin_xxx` 形式并在函数体内加 is_admin 判断。
# ----------------------------------------------------------------------
RPC_DENIED_FOREVER = {
    "grant_membership",
}

# 客户端可传的参数白名单（2026-10-28）。
#
# 有些函数把"额度/上限"做成了参数（unlock_paper 的 p_free_limit），
# 这些参数**只能由服务端决定**：前端传 999999 就等于免费解锁全库。
# 这里按函数裁剪参数，不在 SQL 里改签名（改签名要动老数据/老函数，风险更大）。
RPC_ALLOWED_ARGS: dict[str, set[str]] = {
    "unlock_paper": {"p_paper_id"},
    "my_access_status": set(),
    "increment_paper_view": {"p_paper_id"},
    "count_login_only_papers": set(),
}

# 只允许查这些表（给需要读表的地方用）
ALLOWED_TABLES = {
    "papers", "profiles", "paper_unlocks", "payment_orders",
    "membership_logs", "favorites", "recent_views",
}

_pool = None
_cfg = None


def load_config(path=None):
    """从 /etc/ctbu-pay/config.json 读 local_db 段。"""
    global _cfg
    path = path or os.environ.get("CTBU_PAY_CONFIG", "/etc/ctbu-pay/config.json")
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
    _cfg = cfg.get("local_db") or {}
    if not _cfg.get("password"):
        raise RuntimeError("config.json 里缺 local_db.password")
    return _cfg


def init_pool(minconn=2, maxconn=12):
    """建连接池。

    ⚠️ 2026-10-20 事故复盘：原来 maxconn=4，用户**快速连点多个试卷**时
    每个请求都要占一个连接（登录校验 / 额度 / 签名 / 心跳），4 个瞬间被占满
    → `psycopg2.pool.PoolError: connection pool exhausted`
    → 前端看到「校验查看权限失败：查询失败，请稍后重试」。
    日志实证：`WARNING 会话校验失败：connection pool exhausted`。

    现在 maxconn=12：Postgres 每连接约 5~10MB，12 个约 120MB，
    这台 1.9G 机器完全撑得住；同时由 `_getconn_with_wait()` 做短暂等待，
    把"瞬时尖峰"摊平而不是直接报错。
    """
    global _pool
    if _pool is not None:
        return _pool
    cfg = _cfg or load_config()
    _pool = psycopg2.pool.ThreadedConnectionPool(
        minconn, maxconn,
        host=cfg.get("host", "127.0.0.1"),
        port=int(cfg.get("port", 5432)),
        dbname=cfg.get("dbname", "ctbu"),
        user=cfg.get("user", "ctbu"),
        password=cfg["password"],
        # 连接用完不残留在事务里
        options="-c statement_timeout=15000",
    )
    log.info("数据库连接池已建立（%s...@%s/%s）", cfg.get("user"), cfg.get("host"), cfg.get("dbname"))
    return _pool


def _getconn_with_wait(pool, timeout: float = 3.0):
    """借连接；池满时短暂等待而不是立刻抛 PoolError。

    为什么需要：`ThreadedConnectionPool.getconn()` 一满就抛异常，
    而真实场景里"池满"往往只是几百毫秒的尖峰（用户连点、心跳与阅读请求撞在一起）。
    等一小会儿几乎总能拿到，用户体验上就是"慢一点"而不是"报错"。
    """
    deadline = time.monotonic() + timeout
    delay = 0.02
    while True:
        try:
            return pool.getconn()
        except psycopg2.pool.PoolError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(delay)
            delay = min(delay * 2, 0.2)


@contextmanager
def conn(uid=None):
    """借一个连接；uid 非空时注入会话身份（仅当前事务有效）。"""
    pool = _pool or init_pool()
    c = _getconn_with_wait(pool)
    try:
        c.autocommit = False
        with c.cursor() as cur:
            # is_local=true → 只作用于当前事务；连接归还池子后不会带着上一个人的身份
            cur.execute("select set_config('request.jwt.claim.sub', %s, true)",
                        (str(uid) if uid else "",))
        yield c
        c.commit()
    except Exception:
        try:
            c.rollback()
        except Exception:
            pass
        raise
    finally:
        pool.putconn(c)


def rpc(fn, payload=None, uid=None):
    """调一个白名单内的 Postgres 函数，返回它的返回值。

    返回类型自动处理：jsonb → dict/list，标量 → 原样。
    """
    if fn not in ALLOWED_RPC:
        raise ValueError(f"函数不在白名单内：{fn}")
    payload = payload or {}
    # 按函数裁剪参数：额度/上限这类参数不能由前端决定（见 RPC_ALLOWED_ARGS）
    allowed_args = RPC_ALLOWED_ARGS.get(fn)
    if allowed_args is not None:
        payload = {k: v for k, v in payload.items() if k in allowed_args}
    if not all(k.isidentifier() for k in payload):
        raise ValueError("参数名不合法")

    # 具名参数调用：fn(a => %s, b => %s) —— 参数名来自白名单校验过的 payload
    arg_sql = ", ".join(f"{k} => %s" for k in payload)
    sql = f"select public.{fn}({arg_sql})"          # fn 已被白名单限制，非用户输入
    with conn(uid) as c:
        with c.cursor() as cur:
            cur.execute(sql, list(payload.values()))
            row = cur.fetchone()
    return row[0] if row else None


_TABLE_REF_RE = re.compile(r"\b(?:from|join|into|update)\s+(?:[a-z_][a-z0-9_]*\.)?([a-z_][a-z0-9_]*)",
                           re.IGNORECASE)


def query(sql, params=None, uid=None, table_guard=True):
    """只读查询（给少数需要直接读表的场景）。表名必须出现在 SQL 里且在白名单内。

    2026-10-28 改：原来用 `t in sql.lower()` 做子串匹配 —— `papers_secret` 里含
    `papers`、`join app_secrets ... papers` 也能过，等于一层"看起来有、实际没有"的防护。
    现在要求**紧跟 from / join / into / update 的那个标识符**在白名单里。
    """
    if table_guard:
        refs = {m.group(1).lower() for m in _TABLE_REF_RE.finditer(sql)}
        if not refs & set(ALLOWED_TABLES):
            raise ValueError("查询未引用白名单内的表，拒绝执行")
        unknown = refs - set(ALLOWED_TABLES)
        if unknown:
            raise ValueError(f"查询引用了白名单外的表：{', '.join(sorted(unknown))}")
    with conn(uid) as c:
        with c.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params or [])
            return cur.fetchall()


def execute(sql, params=None, uid=None):
    """写操作 / 非白名单表查询（服务端专用，2026-10-17 阶段 5 新增）。

    ⚠️ 安全红线：SQL 必须**写死在服务端代码里**，参数永远走占位符；
    绝不接受前端传来的 SQL、表名或列名。表名白名单（ALLOWED_TABLES）
    不适用于这里 —— 因此本函数只允许服务端内部调用，别把它接到任何路由上。

    有返回值（INSERT ... RETURNING / SELECT）时返回 RealDict 行列表，否则返回 None。
    """
    with conn(uid) as c:
        with c.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(sql, params or [])
            if cur.description:
                return cur.fetchall()
            return None


def health():
    """给 /api/pay/health 用的探活。"""
    try:
        with conn() as c:
            with c.cursor() as cur:
                cur.execute("select 1")
                cur.fetchone()
        return True, "ok"
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"
