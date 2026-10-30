#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""试卷 AI 学习助手（2026-10-25 · 免费链路优先）

路由（由 pay_service.py 挂进来）：
  POST /api/ai/ask     流式问答（NDJSON 逐行推送事件）
  GET  /api/ai/quota   查今日剩余次数

架构 —— 为什么是「OCR 缓存 + 免费文本模型」，而不是直接调视觉模型：
  · 能直接看卷子的视觉模型里好用的（Qwen3-VL-8B）是付费的，约 1 分/次；
  · PaddleOCR-VL 在硅基流动**完全免费**且转录质量极好，但单页要 ~2 分钟，
    交互等不起；
  · 好在题库是静态的：转录按 (paper, page, which) 缓存进 ai_page_ocr 表，
    用 tools/ai-预热OCR.py 离线把全库跑一遍，之后学生提问 = 查表 +
    免费文本模型（Qwen3-8B）作答 —— 全程 ¥0，延迟只剩文本模型的时间。
  · 付费视觉模型保留在配置里（allow_paid_vision，默认 **false**），
    只在「页面没缓存又想立刻答」的应急场景手动打开。

防滥用三道闸：
  1. 必须登录（会话 token）；
  2. 按会员档位的**每日额度**（2026-10-25 终版）：永久 50 / 年度 20 / 月度 10
     （限期创始按月度档）；无有效会员总共试用 1 次（ai_usage 计数）；
  3. 全站并发闸门 max_concurrent：同时只有这么多路真正在调模型，
     其余排队（流式发 queue 事件，前端显示「前面还有 N 人」）。

不占数据库连接池（坑 55 教训）：鉴权/计数/查转录都是「借连接→执行→立刻归还」
的短查询；流式转发期间不持有任何数据库连接。

安全：AI 能看到的试卷内容与 paper-pages 同权限（会员或已解锁），
否则没买的人能借 AI 的嘴把付费卷子的题问出来。
"""

import base64
import json
import logging
import re
import threading
import time
import urllib.error
import urllib.request

log = logging.getLogger("ctbu.ai")

SF_URL = "https://api.siliconflow.cn/v1/chat/completions"

# OCR 转录的提问词（2026-10-25 定稿：VL-32B + 数学 LaTeX 化）
# 旧版给 PaddleOCR-VL 的朴素指令对数学卷是灾难（公式全烂 + 幻觉页脚刷屏），
# 抽查 0/16 全军覆没；换 Qwen3-VL-32B + 这份提示词后，PaddleOCR 转成乱码的
# 行列式被逐字还原成 LaTeX。转录慢没关系——一次性成本，按页缓存后永久复用。
OCR_PROMPT = (
    "请把这页试卷扫描图完整转录成文本：逐字保留题目内容、题号、选项；"
    "数学公式用 LaTeX 表示（行内用 $...$，独立公式用 $$...$$）；"
    "表格用 Markdown 表格；忽略页边的装订线、污渍、印章，页眉页脚只在开头注明一次；"
    "不要添加任何原文没有的内容。只输出转录内容。"
)

# 答题模型的系统提示词（定位：讲思路的助教，不是答案机）
# ⚠️ 2026-10-25 抽查踩坑：旧版「找不到就直说…绝不要编造」过于严厉，
# 转录里题号写的是「5.」而非「第5题」，模型竟据此说「没找到第5题」（去掉
# 系统提示就能答对）。所以这里必须把题号对应关系讲明白，再谈诚实原则。
SYSTEM_PROMPT = (
    "你是嵌在试卷阅读器里的「学习助手」，帮重庆工商大学的学生看懂试卷。"
    "学生会给你当前页的文字转录（OCR 自扫描件，可能有错字、乱序或多余符号，结合上下文理解），"
    "并提出一个问题（通常是「第N题怎么做」）。要求：\n"
    "1. 转录里题号的常见写法是「1.」「一、」「1、」等，它们就是学生说的"
    "「第1题」「第一大题」，先据此定位题目再作答；只有整页反复确认确实没有"
    "该题号时才说明并请学生核对，不要轻易说找不到。\n"
    "1b. 很多试卷分大题（如「一、填空题 1-10」「二、选择题 1-5」「三、解答题」），"
    "每个大题的题号都从 1 重新数，同一页可能出现好几个「第N题」。学生只说"
    "「第N题」时，优先解与问题语境最匹配的那道（题目带 A/B/C/D 选项的多半是"
    "选择题那道），并在回答第一行注明你解的是哪道（如「按【二、选择题·第2题】讲解」）；"
    "实在区分不出时先用一句话问清是哪个大题，不要长篇大论猜着讲。\n"
    "1c. 消息里可能附有「相邻页转录/文字」——那是给跨页题准备的：题目或选项"
    "可能延续到下一页。优先按学生当前页（标注了【当前页转录】的那段）定位"
    "题目；当前页的题没写完（如选项缺了）时，用相邻页内容补全再解。不要把"
    "相邻页里的其他题当成学生问的题。\n"
    "2. 讲解优先：先讲这道题在考什么、解题思路和关键步骤，最后才给答案；"
    "表述简洁，一般 200 字以内。\n"
    "3. 公式用清晰的文本写出来。\n"
    "4. 只回答与这页试卷、课程学习相关的问题，其余话题礼貌拒绝。"
)

# ---- 并发闸门（延迟初始化：配置在 pay_service.CFG 里，导入时还没就绪）----
_GATE: threading.BoundedSemaphore | None = None
_GATE_LOCK = threading.Lock()
_GATE_WAITING = 0                      # 当前排队人数（发 queue 事件用）

# ---- 后台 OCR（免费但要 ~2 分钟，丢线程里慢慢跑）----
_OCR_SEMAPHORE = threading.BoundedSemaphore(2)   # 同时最多 2 页在转录
_OCR_LOCK = threading.Lock()
_OCR_INFLIGHT: set[tuple[str, int, str]] = set()


def _ai_cfg() -> dict:
    """pay_service.CFG 的 ai 段（延迟引用，避免循环导入）。"""
    import pay_service as PS
    return PS.CFG.get("ai") or {}


def _gate(sem_value: int) -> threading.BoundedSemaphore:
    global _GATE
    with _GATE_LOCK:
        if _GATE is None:
            _GATE = threading.BoundedSemaphore(value=max(1, sem_value))
        return _GATE


# ======================================================================
# 硅基流动调用
# ======================================================================

def _sf_headers(key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}


def _sf_call_stream(model: str, messages: list, key: str, *, max_tokens: int,
                    on_delta, temperature: float = 0.3) -> tuple[int, int]:
    """流式调用，逐 delta 回调。返回 (prompt_tokens, completion_tokens)。

    Qwen3 系列默认开「思考」，白白多花 20~30 秒 —— 答疑这种短任务关掉
    （enable_thinking=false 是硅基流动文档支持的参数）。
    """
    body = {"model": model, "messages": messages, "max_tokens": max_tokens,
            "temperature": temperature, "stream": True, "stream_options":
            {"include_usage": True}, "enable_thinking": False}
    req = urllib.request.Request(SF_URL, data=json.dumps(body).encode("utf-8"),
                                 headers=_sf_headers(key))
    usage = {"pt": 0, "ct": 0}
    with urllib.request.urlopen(req, timeout=180) as resp:
        for raw in resp:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                break
            try:
                d = json.loads(payload)
            except json.JSONDecodeError:
                continue
            u = d.get("usage") or {}
            if u.get("prompt_tokens") is not None:
                usage["pt"] = int(u["prompt_tokens"])
                usage["ct"] = int(u.get("completion_tokens") or 0)
            for ch in d.get("choices") or []:
                piece = ((ch.get("delta") or {}).get("content")) or ""
                if piece:
                    on_delta(piece)
    return usage["pt"], usage["ct"]


def _sf_call_once(model: str, messages: list, key: str, *, max_tokens: int,
                  timeout: int = 280) -> str:
    """非流式调用（OCR 用：PaddleOCR-VL 不需要流式，等它转完就是了）。"""
    body = {"model": model, "messages": messages, "max_tokens": max_tokens,
            "stream": False}
    req = urllib.request.Request(SF_URL, data=json.dumps(body).encode("utf-8"),
                                 headers=_sf_headers(key))
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        d = json.loads(resp.read())
    return (d["choices"][0]["message"]["content"] or "").strip()


# ======================================================================
# OCR 缓存与后台转录
# ======================================================================

def get_cached_ocr(paper_id: str, page: int, which: str) -> str | None:
    import db
    rows = db.execute(
        "select ocr_text from public.ai_page_ocr "
        "where paper_id = %s and page = %s and which = %s",
        [paper_id, page, which])
    return rows[0]["ocr_text"] if rows else None


def _image_b64(paper_id: str, page: int, which: str) -> tuple[str, str] | None:
    """读这一页的 webp。返回 (dirname, base64)；页面图不存在 → None。"""
    import os
    import pay_service as PS
    rows = _paper_rows(paper_id)
    if not rows:
        return None
    row = rows[0]
    fp = row["answer_path"] if which == "answer" else row["file_path"]
    if not fp:
        return None
    dirname = PS.pages_dir_of(fp)
    path = os.path.join(PS.PAGES_DIR, dirname, f"p{page:02d}.webp")
    if not os.path.isfile(path):
        # 个别套页数超过 99 时命名是 pNNN —— 命名规则见 入库流水线
        path = os.path.join(PS.PAGES_DIR, dirname, f"p{page:03d}.webp")
        if not os.path.isfile(path):
            return None
    with open(path, "rb") as f:
        return dirname, base64.b64encode(f.read()).decode()


def ocr_page_now(paper_id: str, page: int, which: str,
                 model: str | None = None) -> str | None:
    """同步转录一页（预热/重转脚本复用这里）。

    model 可显式指定（分层策略：数学类卷用 VL-32B，纯文理用免费 PaddleOCR，
    2026-10-25 用户拍板）；默认读配置。
    """
    cfg = _ai_cfg()
    key = str(cfg.get("siliconflow_key") or "")
    if not key:
        return None
    got = _image_b64(paper_id, page, which)
    if not got:
        return None
    _, b64 = got
    use_model = model or str(cfg.get("ocr_model") or "Qwen/Qwen3-VL-32B-Instruct")
    # 免费档（PaddleOCR）指令要朴素；VL 档要 LaTeX 化 —— 提示词跟着模型走
    prompt = (OCR_PROMPT if "VL-32B" in use_model or "VL-8B" in use_model
              else "完整转录这页试卷上的所有文字：保留题号与选项；公式用文本表示；只输出转录内容，不要解释。")
    text = _sf_call_once(
        use_model,
        [{"role": "user", "content": [
            {"type": "image_url", "image_url": {"url": f"data:image/webp;base64,{b64}"}},
            {"type": "text", "text": prompt},
        ]}], key, max_tokens=3500, timeout=300)
    if not text:
        return None
    _save_ocr(paper_id, page, which, text, model=use_model)
    return text


def _save_ocr(paper_id: str, page: int, which: str, text: str,
              model: str = "") -> None:
    import db
    try:
        db.execute(
            "insert into public.ai_page_ocr (paper_id, page, which, ocr_text, model) "
            "values (%s, %s, %s, %s, %s) "
            "on conflict (paper_id, page, which) do update set "
            "ocr_text = excluded.ocr_text, model = excluded.model",
            [paper_id, page, which, text[:20000],
             model or str(_ai_cfg().get("ocr_model") or "")])
    except Exception as e:  # noqa: BLE001
        log.warning("OCR 缓存写入失败：%s", e)


def kick_background_ocr(paper_id: str, page: int, which: str) -> None:
    """缓存未命中时丢到后台慢慢转（免费、~2 分钟），下一个人就能用上。"""
    job = (paper_id, page, which)
    with _OCR_LOCK:
        if job in _OCR_INFLIGHT:
            return
        _OCR_INFLIGHT.add(job)

    def run():
        try:
            with _OCR_SEMAPHORE:
                ocr_page_now(paper_id, page, which)
        except Exception as e:  # noqa: BLE001
            log.warning("后台 OCR 失败 %s p%s(%s)：%s", paper_id[:8], page, which, e)
        finally:
            with _OCR_LOCK:
                _OCR_INFLIGHT.discard(job)

    threading.Thread(target=run, daemon=True, name=f"ocr-{page}").start()


# ======================================================================
# 权限与配额
# ======================================================================

def _paper_rows(paper_id: str) -> list[dict]:
    import db
    return db.query(
        "select id, coalesce(file_path,'') as file_path, "
        "coalesce(answer_path,'') as answer_path, page_count, "
        "coalesce(title,'') as title, coalesce(course_name,'') as course_name, "
        "year, solution_page "
        "from public.papers where id = %s", [paper_id])


def _access_ok(uid: str, paper_id: str) -> bool:
    """与 /api/pay/paper-pages 同一标准：会员 或 这份已解锁。"""
    import db
    try:
        st = db.rpc("my_access_status", {"p_free_limit": 3}, uid=uid) or {}
        if bool(st.get("is_member")):
            return True
        hit = db.query(
            "select 1 as x from public.paper_unlocks "
            "where user_id = %s and paper_id = %s", [uid, paper_id])
        return bool(hit)
    except Exception as e:  # noqa: BLE001
        log.warning("AI 鉴权查询失败：%s", e)
        return False


def _gate_check(uid: str) -> tuple[bool, dict]:
    """功能准入（2026-10-25 用户拍板，当日终版）——按会员档位给每日额度：

      · 永久会员（expires_at=infinity，含 2 位永久创始）50 次/天
      · 年度会员 20 次/天
      · 月度会员 10 次/天；**限期创始会员按月度档**（未付费，只是试用延长，
        想改档改配置 ai.quotas.founder 即可，不用动代码）
      · 无有效会员：总共试用 1 次（不分天），用完引导开通

    所有档位数字都在配置 ai.quotas 里；ai_usage 照常记账。
    """
    import db
    cfg = _ai_cfg()
    quotas = cfg.get("quotas") or {}
    tier, is_inf, expired = None, False, True
    try:
        rows = db.execute(
            "select membership_tier, "
            "membership_expires_at = 'infinity'::timestamptz as is_inf, "
            "(membership_expires_at is null or membership_expires_at <= now()) as expired "
            "from public.profiles where id = %s", [uid])
        if rows:
            tier = rows[0]["membership_tier"]
            is_inf = bool(rows[0]["is_inf"])
            expired = bool(rows[0]["expired"])
    except Exception as e:  # noqa: BLE001
        log.warning("会员档位查询失败（按无会员处理）：%s", e)

    daily: int | None = None
    if is_inf:
        daily = int(quotas.get("lifetime") or 50)
    elif not expired and tier == "yearly":
        daily = int(quotas.get("yearly") or 20)
    elif not expired and tier in ("monthly", "founder"):
        key = "founder" if (tier == "founder" and quotas.get("founder")) else "monthly"
        daily = int(quotas.get(key) or 10)

    if daily:
        try:
            rows = db.execute(
                "select count(*) as n from public.ai_usage "
                "where user_id = %s and created_at >= current_date", [uid])
            used = int(rows[0]["n"]) if rows else 0
        except Exception as e:  # noqa: BLE001
            log.warning("AI 用量查询失败：%s", e)
            return False, {"reason": "db_error", "message": "系统繁忙，请稍后再试"}
        if used >= daily:
            return False, {"reason": "daily_exhausted", "quota": daily, "used": used,
                           "message": f"今日 {daily} 次已用完，明天再来；升级会员档位可获得更多次数"}
        return True, {"tier": tier or "member", "quota": daily,
                      "remaining": max(0, daily - used - 1)}

    # 无有效会员：总共一次试用
    try:
        rows = db.execute(
            "select count(*) as n from public.ai_usage where user_id = %s", [uid])
        used_total = int(rows[0]["n"]) if rows else 0
    except Exception as e:  # noqa: BLE001
        log.warning("AI 试用计数失败：%s", e)
        return False, {"reason": "db_error", "message": "系统繁忙，请稍后再试"}
    if used_total == 0:
        return True, {"trial": True}
    return False, {"reason": "membership_required",
                   "message": "免费试用已用完。开通会员即可每日使用 AI 答疑"}


# ---- 数学类课程判定（2026-10-25 用户授权：数学题用付费模型看图直答）----
# 全量准确率检查显示 8B 文本模型读题没问题、**解题能力不够**（数学/物理类
# 错题集中），故数学类卷子不走"转录文本→文本模型"，改为 VL 直接看原图答题。
MATH_RE = re.compile(r"数学|微积分|概率|线代|线性代数|统计|计量|物理|投资学")  # 仅作兜底：题干定位失败时的保守倾向

# ---- 单题分流（2026-10-25 用户拍板）：不按课程分，按**这道题**要不要看图 ----
# 概念文字题（"简述/下列说法/判断"）→ 免费文本模型；公式/计算/图形题 → VL 看图。
# 依据是转录里这道题的题干（数学页转录是 VL 高质量 LaTeX，信号很强），
# 零额外 API 调用、零延迟。
_QN_IN_Q_RE = re.compile(r"第\s*(\d{1,3})\s*题")
_FIG_RE = re.compile(r"如图|图所示|图示|见图")
_MATH_STEM_RE = re.compile(
    r"\\frac|\\begin|\\int|\\sum|\\lim|\\det|pmatrix|vmatrix|bmatrix|\\sqrt")
_STRONG_MATH_RE = re.compile(
    r"证明|推导|积分|导数|微分|矩阵|行列式|特征值|特征向量|方程组|极限|级数")
_WEAK_KW_RE = re.compile(r"计算|求值|求解|概率|分布函数|方差|协方差|回归")


def _locate_stem(ocr: str | None, question: str) -> str:
    """在转录里找到学生问的那道题的题干片段（定位失败给开头/空串）。"""
    if not ocr:
        return ""
    m = _QN_IN_Q_RE.search(question)
    if not m:
        return ocr[:400]
    qn = m.group(1)
    s = re.search(rf"(?m)^\s*{qn}[\.、．]\s*", ocr) or re.search(rf"{qn}[\.、．]\s*", ocr)
    return ocr[s.end():s.end() + 400] if s else ""


def _question_needs_vision(stem: str, question: str) -> bool:
    """题干/问题里出现：图形引用、LaTeX 公式、或『计算类词 + 数字运算』→ 看图。"""
    both = stem + "　" + question
    if _FIG_RE.search(both):
        return True
    if _MATH_STEM_RE.search(stem) or stem.count("$") >= 4 or stem.count("\\") >= 3:
        return True
    if _STRONG_MATH_RE.search(stem):
        return True
    return bool(_WEAK_KW_RE.search(stem)) and re.search(r"\d\s*[-+*/^=]", stem) is not None

# 看图直答的系统提示词（与转录版分工：这里强调仔细算）
SYSTEM_PROMPT_VISION = (
    "你是嵌在试卷阅读器里的「学习助手」，帮重庆工商大学的学生看懂试卷。"
    "学生会给你当前页的试卷扫描图，并提出一个问题（通常是「第N题怎么做」）。要求：\n"
    "1. 先在图里找到对应题目再作答；图中题号常见写法是「1.」「一、」「1、」。"
    "确实找不到时才说明并请学生核对。\n"
    "1b. 很多试卷分大题（如「一、填空题 1-10」「二、选择题 1-5」「三、解答题」），"
    "每个大题的题号都从 1 重新数，同一页可能有不止一个「第N题」。学生只说"
    "「第N题」时，优先解与问题语境最匹配的那道（带 A/B/C/D 选项的多半是选择题），"
    "并在回答第一行注明你解的是哪道（如「按【二、选择题·第2题】讲解」）；"
    "实在分不清时先用一句话问清是哪个大题。\n"
    "1c. 消息里可能附有「相邻页文字」——那是给跨页题准备的：当前页的题目"
    "或选项可能延续到下一页。当前页的题没写完时，用相邻页文字补全再解，"
    "不要因选项不全而拒答。\n"
    "2. 数学/计算题必须**分步仔细计算**：写出关键步骤，代入数值时逐项核对，"
    "最后才给结论；宁可多推一步，不要跳步心算。\n"
    "3. 讲解优先：先讲这道题在考什么、思路和关键步骤，最后给答案；"
    "表述简洁，一般 250 字以内。\n"
    "4. 只回答与这页试卷、课程学习相关的问题，其余话题礼貌拒绝。"
)

# 运行时轻量体检（2026-10-25 用户底线要求：「用户不能因转录问题遇到任何问题」）
# 只拦「肉眼可见的烂」（乱码/噪声/长度异常）；语义级错误拦不住，靠离线体检+
# 人工抽检兜底。这里宁可放过、不可错杀 —— 误拦会把正常页变成不可用。
_LOC_RE = re.compile(r"<\|LOC_")
_BADCHAR_RE = re.compile(
    r"[^0-9A-Za-z\s\u4e00-\u9fff$\\{}()\[\]=+\-*/^_.,:;!?%｜|<>&#~`'\""
    r"“”‘’（）《》、。，；：！？—…·×÷±≤≥≠√∑∫]")


def ocr_sanity_ok(text: str | None) -> bool:
    if not text or not (100 <= len(text) <= 26000):
        return False
    if _LOC_RE.search(text):
        return False
    bad = len(_BADCHAR_RE.findall(text))
    return bad <= max(40, len(text) * 0.03)


def _is_blank_page(text: str | None) -> bool:
    """短而干净 = 真空白页（实测：全库最短的页只有页码/密封线，转录本来就只有几个字）。
    空白页不该触发「质量差重转」——重转一万次也只有那几个字。"""
    if not text or len(text) >= 100:
        return False
    return (not _LOC_RE.search(text)) and len(_BADCHAR_RE.findall(text)) <= 5


# ======================================================================
# HTTP 处理
# ======================================================================

def _line(handler, obj: dict) -> None:
    """往流里写一行 NDJSON 事件并立刻 flush（前端逐行读）。"""
    try:
        handler.wfile.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
        handler.wfile.flush()
    except (BrokenPipeError, ConnectionResetError):
        raise  # 学生关了面板：让上层停手


def _start_stream(handler) -> None:
    handler.send_response(200)
    handler.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
    # nginx 反代默认缓冲整个响应，必须显式关掉，否则「流式」变「憋到最后一口气」
    handler.send_header("X-Accel-Buffering", "no")
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()


def handle_quota(handler, uid: str | None) -> None:
    """GET /api/ai/quota —— 面板打开时先问一次「能不能用」。"""
    if not uid:
        handler._json(401, {"ok": False, "reason": "not_logged_in"})
        return
    cfg = _ai_cfg()
    if not cfg.get("enabled") or not cfg.get("siliconflow_key"):
        handler._json(503, {"ok": False, "reason": "ai_not_configured"})
        return
    ok_gate, gate_info = _gate_check(uid)
    if not ok_gate:
        handler._json(200, {"ok": True, "allowed": False,
                            "member": False, **gate_info})
        return
    handler._json(200, {"ok": True, "allowed": True,
                        "member": not gate_info.get("trial"), **gate_info})


def _adjacent_ocr(paper_id: str, page: int, which: str) -> str:
    """跨页题兜底：上一页结尾 + 下一页开头。

    题目/选项常被切到下一页（2026-10-25 基准实测踩中）。所有页都已离线
    转录过（数学页是 VL 高质量转录），把相邻页片段作为文字上下文带上，
    两条链路（看图/文本）都能拿到完整题目，成本只是几百个文本 token。
    只查缓存：缺页就跳过（相邻页绝不做现场转录，不拖慢学生等待）。
    """
    parts = []
    if page > 1:
        prev_t = get_cached_ocr(paper_id, page - 1, which)
        if prev_t and len(prev_t) > 120:      # 太短多半是空白页，没信息量
            parts.append(f"——上一页（第 {page - 1} 页）结尾——\n…{prev_t[-800:]}")
    next_t = get_cached_ocr(paper_id, page + 1, which)
    if next_t and len(next_t) > 120:
        parts.append(f"——下一页（第 {page + 1} 页）开头——\n{next_t[:1200]}…")
    return "\n\n".join(parts)


def handle_ask(handler, uid: str | None, raw: str) -> None:
    """POST /api/ai/ask —— 主体见模块头。"""
    global _GATE_WAITING
    cfg = _ai_cfg()
    key = str(cfg.get("siliconflow_key") or "")
    if not cfg.get("enabled") or not key:
        handler._json(503, {"ok": False, "reason": "ai_not_configured"})
        return
    if not uid:
        handler._json(401, {"ok": False, "reason": "not_logged_in"})
        return

    # ---- 解析与校验请求 ----
    try:
        body = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        handler._json(400, {"ok": False, "reason": "bad_json"})
        return
    paper_id = str(body.get("paper_id") or "").strip()
    if not re.fullmatch(r"[0-9a-fA-F-]{36}", paper_id):
        handler._json(400, {"ok": False, "reason": "bad_paper_id"})
        return
    which = str(body.get("which") or "paper")
    if which not in ("paper", "answer"):
        which = "paper"
    try:
        page = int(body.get("page") or 1)
    except (TypeError, ValueError):
        page = 1
    if not 1 <= page <= 500:
        handler._json(400, {"ok": False, "reason": "bad_page"})
        return
    question = str(body.get("question") or "").strip()[:int(cfg.get("max_question_len") or 300)]
    history = []
    for m in (body.get("history") or [])[-4:]:
        if isinstance(m, dict) and m.get("role") in ("user", "assistant") and m.get("content"):
            history.append({"role": m["role"], "content": str(m["content"])[:1500]})
    if not question:
        handler._json(400, {"ok": False, "reason": "empty_question"})
        return

    # ---- 试卷存在 + 内容权限（与 paper-pages 同标准）----
    rows = _paper_rows(paper_id)
    if not rows:
        handler._json(404, {"ok": False, "reason": "not_found"})
        return
    paper = rows[0]
    if not _access_ok(uid, paper_id):
        handler._json(403, {"ok": False, "reason": "no_access"})
        return

    # ---- 功能准入：永久会员专享（或兼容模式的每日限额）----
    ok_gate, gate_info = _gate_check(uid)
    if not ok_gate:
        status = 429 if gate_info.get("reason") == "quota_exhausted" else 403
        handler._json(status, {"ok": False, **gate_info})
        return

    t0 = time.time()
    # ---- 并发闸门：拿不到就排队，排队状态用流式事件告诉前端 ----
    gate = _gate(int(cfg.get("max_concurrent") or 4))
    # 排队上限 90s → 20s（2026-10-28）。排队期间这个请求一直占着一个 HTTP 线程，
    # 而线程数没有硬上限；一个人开几十个标签页排队，就能把整站（题库、登录、支付）
    # 一起拖住。20 秒足够吸收正常的瞬时并发，又不会让人白等一分半。
    queue_wait_s = float(cfg.get("queue_wait_s") or 20)
    _start_stream(handler)
    acquired = gate.acquire(blocking=False)
    if not acquired:
        with _GATE_LOCK:
            _GATE_WAITING += 1
        try:
            deadline = time.time() + queue_wait_s
            while not gate.acquire(blocking=False):
                if time.time() >= deadline:
                    _line(handler, {"t": "error", "reason": "busy",
                                    "message": "现在用的人较多，请稍后再试"})
                    return
                time.sleep(1.5)
                _line(handler, {"t": "queue", "pos": max(1, _GATE_WAITING - 1)})
        except (BrokenPipeError, ConnectionResetError):
            return                      # 排队中学生就关了面板
        finally:
            with _GATE_LOCK:
                _GATE_WAITING -= 1

    try:

        # ---- 单题分流（2026-10-25）：先判这道题要不要看图，再决定链路 ----
        course_math = bool(MATH_RE.search(paper["course_name"] or ""))
        ocr = get_cached_ocr(paper_id, page, which)
        stem = _locate_stem(ocr, question)
        if stem:
            is_math = _question_needs_vision(stem, question)
        else:
            # 题干定位失败：保守起见数学类卷走看图，文理类按题面关键词判
            is_math = course_math or _question_needs_vision("", question)
        if not is_math and ocr is None:
            is_math = True          # 文本链路没转录可用时退回看图，别让学生等补转
        mode = "cached"
        got = None
        if is_math or cfg.get("allow_paid_vision"):
            got = _image_b64(paper_id, page, which)
            if got:
                mode = "vision"
        if mode == "cached" and ocr is None:
            # 免费模式：这页还没转录 —— 后台补转，本次明确告知
            kick_background_ocr(paper_id, page, which)
            _line(handler, {"t": "error", "reason": "page_not_ready",
                            "message": "这一页的转录还在准备中（约需 2 分钟），"
                                       "稍后再问一次即可；可以先翻到其他页试试"})
            return

        # 运行时兜底：缓存里的转录是烂的（乱码/噪声）→ 拦下，不给错答案，
        # 并自动用 VL 重转这页（kick 用配置默认模型 = VL-32B，质量优先）
        if mode == "cached" and not ocr_sanity_ok(ocr):
            if _is_blank_page(ocr):
                _line(handler, {"t": "error", "reason": "blank_page",
                                "message": "这一页是空白页（没有题目内容），翻到有题目的页再问吧"})
                return
            kick_background_ocr(paper_id, page, which)
            _line(handler, {"t": "error", "reason": "page_quality",
                            "message": "这一页扫描质量较差，AI 暂时读不了；"
                                       "已自动安排修复，几分钟后再试即可"})
            return

        meta = {"t": "meta", "mode": mode, "trial": bool(gate_info.get("trial"))}
        if not gate_info.get("trial"):
            meta.update({"remaining": gate_info.get("remaining"),
                         "quota": gate_info.get("quota")})
        _line(handler, meta)

        # ---- 组装消息 ----
        title = paper["title"] or paper["course_name"]
        ctx = (f"【试卷】{title}"
               + (f"（{paper['year']}年）" if paper.get("year") else "")
               + f"　第 {page} 页")
        if paper.get("solution_page"):
            ctx += f"（本卷自带参考解析，从第 {paper['solution_page']} 页开始）"
        answer_model = str(cfg.get("answer_model") or "Qwen/Qwen3-8B")
        if mode == "vision":
            _, b64 = got
            adj = _adjacent_ocr(paper_id, page, which)
            adj_txt = (f"\n\n【相邻页文字（跨页题补全用）】\n{adj}" if adj else "")
            user_content: list | str = [
                {"type": "image_url",
                 "image_url": {"url": f"data:image/webp;base64,{b64}"}},
                {"type": "text", "text": f"{ctx}{adj_txt}\n【学生问题】{question}"},
            ]
            messages = [{"role": "system", "content": SYSTEM_PROMPT_VISION}] + history + [
                {"role": "user", "content": user_content}]
            # 数学类看图直答用最强档（answer_model_math）；应急视觉通道沿用 vision_model
            answer_model = str(
                (cfg.get("answer_model_math") if is_math else cfg.get("vision_model"))
                or cfg.get("answer_model_math") or "Qwen/Qwen3-VL-32B-Instruct")
        else:
            ocr = (ocr or "")[:6000]
            adj = _adjacent_ocr(paper_id, page, which)
            adj_txt = (f"\n\n【相邻页转录（跨页题补全用）】\n{adj}" if adj else "")
            messages = [{"role": "system", "content": SYSTEM_PROMPT}] + history + [
                {"role": "user",
                 "content": f"{ctx}\n【当前页转录】（学生正在看这一页，题目优先从这里找）\n{ocr}{adj_txt}\n\n【学生问题】{question}"}]

        # ---- 流式答题（带断流重试：90s 无任何输出视为断，静默重打一次）----
        buf = {"chars": 0}

        def on_delta(piece: str) -> None:
            # GLM-4.5V 输出 <|begin_of_box|>/<|end_of_box|> 标记，学生看到就是乱码。
            # 流式里标记可能被切成碎块 —— 维护跨片段缓冲，凑齐整个标记后整体删除。
            piece = getattr(on_delta, "_pend", "") + piece
            on_delta._pend = ""
            while True:
                i = piece.find("<|")
                if i == -1:
                    # 尾部可能是被切断的标记开头，扣住最后 12 字符等下一个 delta
                    keep = piece[-12:] if len(piece) >= 12 and ("<" in piece[-12:]) and piece.rfind(">", piece.rfind("<")) == -1 else ""
                    if keep and "<" in keep:
                        on_delta._pend = keep
                        piece = piece[:-len(keep)]
                    break
                j = piece.find("|>", i + 2)
                if j == -1:
                    on_delta._pend = piece[i:]     # 标记未闭合，全部扣住
                    piece = piece[:i]
                    break
                piece = piece[:i] + piece[j + 2:]
            buf["chars"] += len(piece)
            if piece:
                _line(handler, {"t": "delta", "c": piece})

        try:
            try:
                pt, ct = _sf_call_stream(answer_model, messages, key,
                                         max_tokens=900, on_delta=on_delta)
            except (TimeoutError, urllib.error.URLError, ConnectionError) as stale:
                # 断流自救（2026-10-26）：一题都没吐出来就断（如 109s 超时截断），
                # 静默重打一次；已吐过字的断流不重打（避免重复半截答案）。
                if buf["chars"] > 0:
                    raise stale
                log.warning("答题断流（%s），重试一次", stale)
                pt, ct = _sf_call_stream(answer_model, messages, key,
                                         max_tokens=900, on_delta=on_delta)
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", "replace")[:200]
            except Exception:  # noqa: BLE001
                pass
            log.warning("上游模型失败 HTTP%s：%s", e.code, detail)
            _line(handler, {"t": "error", "reason": "upstream_error",
                            "message": "AI 服务暂时不可用，请稍后再试"})
            return

        ms = int((time.time() - t0) * 1000)
        # ---- 记账（流已结束，短写入立刻归还连接）----
        try:
            import db
            db.execute(
                "insert into public.ai_usage "
                "(user_id, paper_id, page, which, question, answer_chars, "
                " model, tokens_in, tokens_out, ms) "
                "values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
                [uid, paper_id, page, which, question, buf["chars"],
                 answer_model, pt, ct, ms])
        except Exception as e:  # noqa: BLE001
            log.warning("AI 用量写入失败：%s", e)

        done = {"t": "done", "ms": ms, "tokens": pt + ct}
        # 试用这一问结束了：当场切到锁定引导态（下一次提问服务端也会拦）
        if gate_info.get("trial"):
            done["trial_used"] = True
        else:
            done["remaining"] = gate_info.get("remaining")
        _line(handler, done)
    except (BrokenPipeError, ConnectionResetError):
        log.info("AI 问答流被客户端中断（关面板/停止），已停止转发")
    finally:
        gate.release()
