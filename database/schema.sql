--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: admin_cancel_order(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_cancel_order(p_order_no text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not public.is_admin() then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  update payment_orders set status = 'cancelled' where order_no = p_order_no and status = 'pending';
  return jsonb_build_object('ok', true);
end; $$;


--
-- Name: admin_confirm_order(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_confirm_order(p_order_no text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_uid    uuid := auth.uid();
  o        record;
  v_months integer;
  v_tier   text;
begin
  if not public.is_admin() then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;

  select * into o from payment_orders where order_no = p_order_no for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'order_not_found'); end if;
  if o.status = 'paid' then return jsonb_build_object('ok', false, 'reason', 'already_paid'); end if;

  update payment_orders
     set status = 'paid', paid_at = now(), confirmed_by = v_uid
   where order_no = p_order_no;

  v_months := case o.tier when 'monthly' then 1 when 'yearly' then 12 else null end;
  v_tier   := o.tier;
  perform public.grant_membership(o.user_id, v_tier, v_months, 'purchase', p_order_no, v_uid);

  return jsonb_build_object('ok', true, 'order_no', p_order_no, 'tier', v_tier, 'months', v_months);
end; $$;


--
-- Name: admin_grant_membership(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_grant_membership(p_email text, p_tier text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
declare
  v_uid    uuid := auth.uid();
  v_target uuid;
  v_months integer;
  v_ident  text;
begin
  if not public.is_admin() then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;

  -- 去掉空格、横线、括号（手机号常见写法：191 2212 4417 / 191-2212-4417）
  v_ident := regexp_replace(coalesce(p_email, ''), '[\s\-()]', '', 'g');

  if v_ident ~ '^1[3-9][0-9]{9}$' then
    -- 手机号：auth.users.phone 才是权威来源
    select u.id into v_target
      from auth.users u
     where u.phone = v_ident
     limit 1;
  else
    -- 邮箱（大小写不敏感）
    select id into v_target from profiles where lower(email) = lower(trim(v_ident));
  end if;

  if v_target is null then
    return jsonb_build_object('ok', false, 'reason', 'user_not_found', 'input', v_ident);
  end if;

  v_months := case p_tier when 'monthly' then 1 when 'yearly' then 12 else null end;
  perform public.grant_membership(v_target, p_tier, v_months, 'admin_grant', null, v_uid);

  return jsonb_build_object('ok', true, 'ident', v_ident, 'tier', p_tier);
end; $_$;


--
-- Name: admin_list_members(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_list_members(p_limit integer DEFAULT 100) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not public.is_admin() then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  return jsonb_build_object('ok', true, 'members', coalesce((
    select jsonb_agg(jsonb_build_object(
             'email', t.email, 'phone', t.phone, 'display_name', t.display_name,
             'tier', t.membership_tier,
             'expires_at', t.membership_expires_at,
             'is_founder', t.is_founder, 'joined_at', t.created_at
           ) order by t.created_at desc)
      from (
        select p.*, u.phone
          from public.profiles p
          join auth.users u on u.id = p.id
         where p.membership_expires_at is not null
           and p.membership_expires_at > now()
         order by p.created_at desc          -- ← 关键：先取最新的 N 条
         limit greatest(1, least(p_limit, 500))
      ) t), '[]'::jsonb));
end; $$;


--
-- Name: admin_list_orders(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_list_orders(p_status text DEFAULT 'pending'::text, p_limit integer DEFAULT 50) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not public.is_admin() then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;
  return jsonb_build_object('ok', true, 'orders', coalesce((
    select jsonb_agg(jsonb_build_object(
             'order_no', o.order_no, 'tier', o.tier, 'amount_cents', o.amount_cents,
             'status', o.status, 'created_at', o.created_at, 'paid_at', o.paid_at,
             'payer_note', o.payer_note,
             'email', p.email, 'phone', u.phone, 'display_name', p.display_name
           ) order by o.created_at desc)
      from (select * from public.payment_orders
             where (p_status = 'all' or status = p_status)
             order by created_at desc
             limit greatest(1, least(p_limit, 200))) o
      left join public.profiles p on p.id = o.user_id
      left join auth.users u on u.id = o.user_id), '[]'::jsonb));
end; $$;


--
-- Name: admin_membership_stats(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_membership_stats() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_members   integer;
  v_lifetime  integer;
  v_founders  integer;
  v_pending   integer;
  v_paid      integer;
  v_revenue   integer;
  v_daily     jsonb;
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;

  select count(*) into v_members  from profiles where membership_expires_at is not null and membership_expires_at > now();
  select count(*) into v_lifetime from profiles where membership_expires_at = 'infinity'::timestamptz;
  select count(*) into v_founders from profiles where is_founder;
  select count(*) into v_pending  from payment_orders where status = 'pending';
  select count(*), coalesce(sum(amount_cents),0) into v_paid, v_revenue
    from payment_orders where status = 'paid';

  select coalesce(jsonb_agg(jsonb_build_object('day', d, 'orders', c, 'amount_cents', amt) order by d desc), '[]'::jsonb)
    into v_daily
    from (select date_trunc('day', paid_at)::date d, count(*) c, sum(amount_cents) amt
            from payment_orders where status = 'paid' and paid_at is not null
           group by 1 order by 1 desc limit 30) t;

  return jsonb_build_object(
    'ok', true,
    'members_active', v_members,
    'members_lifetime', v_lifetime,
    'founders', v_founders,
    'orders_pending', v_pending,
    'orders_paid', v_paid,
    'revenue_cents', v_revenue,
    'daily', v_daily
  );
end; $$;


--
-- Name: attach_prepay(text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.attach_prepay(p_order_no text, p_code_url text, p_provider text, p_secret text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_secret text;
  v_row    record;
begin
  select value into v_secret from app_secrets where key = 'pay_callback_secret';
  if v_secret is null or p_secret is distinct from v_secret then
    return jsonb_build_object('ok', false, 'reason', 'bad_secret');
  end if;

  select * into v_row from payment_orders where order_no = p_order_no for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'order_not_found'); end if;
  if v_row.status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'not_pending', 'status', v_row.status);
  end if;

  update payment_orders
     set prepay_code_url = p_code_url,
         prepay_at       = now(),
         provider        = coalesce(p_provider, provider)
   where order_no = p_order_no;

  return jsonb_build_object('ok', true, 'order_no', p_order_no);
end; $$;


--
-- Name: claim_invite_rewards(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_invite_rewards() RETURNS jsonb
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select public.settle_invite_rewards(auth.uid());
$$;


--
-- Name: confirm_payment_auto(text, text, integer, text, text, jsonb, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.confirm_payment_auto(p_order_no text, p_transaction_id text, p_paid_cents integer, p_provider text, p_secret text, p_payload jsonb DEFAULT NULL::jsonb, p_tolerance_cents integer DEFAULT 0, p_tolerance_ppm integer DEFAULT 0) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_secret text;
  o        record;
  v_months integer;
  v_tol    integer;
begin
  select value into v_secret from app_secrets where key = 'pay_callback_secret';
  if v_secret is null or p_secret is distinct from v_secret then
    return jsonb_build_object('ok', false, 'reason', 'bad_secret');
  end if;

  select * into o from payment_orders where order_no = p_order_no for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'order_not_found'); end if;

  -- 幂等：已开通则直接回成功，不重复发放
  if o.status = 'paid' then
    return jsonb_build_object('ok', true, 'reason', 'already_paid', 'order_no', p_order_no);
  end if;
  if o.status <> 'pending' then
    return jsonb_build_object('ok', false, 'reason', 'not_pending', 'status', o.status);
  end if;

  -- 金额校验：实收与订单金额的偏差必须在容差之内
  --   容差 = greatest(绝对下限, 订单金额 × 比例)
  --   两个参数都为 0（默认）→ 必须精确相等，防篡改 / 防少付
  --   第三方通道按比例抽成时由服务端传入比例，上界仍然很小（约 2%）
  v_tol := greatest(
             coalesce(p_tolerance_cents, 0),
             (o.amount_cents::bigint * coalesce(p_tolerance_ppm, 0)) / 1000000
           );

  if p_paid_cents is null
     or abs(p_paid_cents - o.amount_cents) > v_tol then
    update payment_orders
       set notify_at = now(),
           notify_payload = coalesce(p_payload, '{}'::jsonb)
         where order_no = p_order_no;
    return jsonb_build_object(
      'ok', false, 'reason', 'amount_mismatch',
      'expected', o.amount_cents, 'got', p_paid_cents, 'tolerance', v_tol
    );
  end if;

  update payment_orders
     set status            = 'paid',
         paid_at           = now(),
         transaction_id    = p_transaction_id,
         paid_amount_cents = p_paid_cents,
         provider          = coalesce(p_provider, provider),
         notify_at         = now(),
         notify_payload    = coalesce(p_payload, '{}'::jsonb)
   where order_no = p_order_no;

  -- 复用已有的开通逻辑（永久用 months = null）
  v_months := case o.tier when 'monthly' then 1 when 'yearly' then 12 else null end;
  perform public.grant_membership(
    o.user_id, o.tier, v_months, 'purchase', p_order_no, null
  );

  return jsonb_build_object(
    'ok', true, 'reason', 'granted',
    'order_no', p_order_no, 'tier', o.tier, 'months', v_months
  );
end; $$;


--
-- Name: count_login_only_papers(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.count_login_only_papers() RETURNS integer
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select count(*)::integer from public.papers
   where visibility = 'login' and status = 'published';
$$;


--
-- Name: create_payment_order(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_payment_order(p_tier text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_uid     uuid := auth.uid();
  v_amount  integer;
  v_pending integer;
  v_no      text;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'reason', 'not_logged_in'); end if;

  -- 应付金额 = 标价，不加任何尾数（与前端 PLANS 的 priceCents 一一对应）
  -- 2026-10-27 调价：yearly 680→880，lifetime 1280→1680，monthly 保持 380
  v_amount := case p_tier
                when 'monthly'  then 380
                when 'yearly'   then 880
                when 'lifetime' then 1680
                else null end;
  if v_amount is null then return jsonb_build_object('ok', false, 'reason', 'bad_tier'); end if;

  -- 先清理超时未付的订单，避免历史残留把「最多 5 个待支付」的名额占满
  update payment_orders
     set status = 'expired'
   where user_id = v_uid
     and status = 'pending'
     and created_at < now() - interval '30 minutes';

  -- 防止刷单：待支付订单最多 5 个
  select count(*) into v_pending from payment_orders where user_id = v_uid and status = 'pending';
  if v_pending >= 5 then
    return jsonb_build_object('ok', false, 'reason', 'too_many_pending');
  end if;

  -- 订单号里的日期用北京时间（Supabase 是 UTC，直接用 now() 会差一天）
  v_no := 'CTBU' || to_char(now() at time zone 'Asia/Shanghai', 'YYYYMMDD')
          || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));

  insert into payment_orders (order_no, user_id, tier, amount_cents, status, provider)
  values (v_no, v_uid, p_tier, v_amount, 'pending', 'manual');

  return jsonb_build_object('ok', true, 'order_no', v_no, 'tier', p_tier, 'amount_cents', v_amount);
end; $$;


--
-- Name: get_order_for_pay(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_order_for_pay(p_order_no text, p_secret text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_secret text;
  v_row    record;
begin
  select value into v_secret from app_secrets where key = 'pay_callback_secret';
  if v_secret is null or p_secret is distinct from v_secret then
    return jsonb_build_object('ok', false, 'reason', 'bad_secret');
  end if;

  select order_no, user_id, tier, amount_cents, status, provider, prepay_code_url, created_at
    into v_row
    from payment_orders
   where order_no = p_order_no;

  if not found then return jsonb_build_object('ok', false, 'reason', 'order_not_found'); end if;

  return jsonb_build_object(
    'ok', true,
    'order_no',     v_row.order_no,
    'user_id',      v_row.user_id,
    'tier',         v_row.tier,
    'amount_cents', v_row.amount_cents,
    'status',       v_row.status,
    'provider',     v_row.provider,
    'code_url',     v_row.prepay_code_url,
    'created_at',   v_row.created_at
  );
end; $$;


--
-- Name: grant_membership(uuid, text, integer, text, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.grant_membership(p_uid uuid, p_tier text, p_months integer, p_reason text, p_order_no text DEFAULT NULL::text, p_by uuid DEFAULT NULL::uuid) RETURNS timestamp with time zone
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_cur timestamptz;
  v_new timestamptz;
begin
  select membership_expires_at into v_cur from profiles where id = p_uid;
  if not found then return null; end if;

  if p_tier = 'lifetime' then
    v_new := 'infinity'::timestamptz;
  elsif v_cur = 'infinity'::timestamptz then
    v_new := 'infinity'::timestamptz;            -- 已是永久，不再变
  else
    -- 未过期则从原到期时间续期，已过期则从现在算起
    v_new := greatest(coalesce(v_cur, now()), now()) + (p_months || ' month')::interval;
  end if;

  update profiles
     set membership_expires_at = v_new,
         membership_tier = case
           when v_new = 'infinity'::timestamptz then 'lifetime'
           when p_tier = 'lifetime' then 'lifetime'
           else p_tier end
   where id = p_uid;

  insert into membership_logs (user_id, tier, months, reason, order_no, granted_by, expires_after)
  values (p_uid, p_tier, p_months, p_reason, p_order_no, p_by, v_new);

  return v_new;
end; $$;


--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_code       text;
  v_ref_code   text;
  v_ref_uid    uuid;
  v_ordinal    integer;
  v_is_founder boolean := false;
  -- 2026-10-30 用户决定：名额 100 → 200
  v_quota      constant integer := 200;
  v_trial      constant interval := interval '1 month';
  -- 统一截止日：所有创始会员（除付费/手动永久/老账号）到这天为止
  v_founder_floor constant timestamptz := timestamptz '2026-12-31 23:59:59+08';
  v_expires    timestamptz;
begin
  -- 用去掉横线的 uuid 前 8 位当邀请码，天然唯一
  v_code := upper(substr(replace(NEW.id::text, '-', ''), 1, 8));

  insert into public.profiles (id, email, invite_code)
  values (NEW.id, NEW.email, v_code);

  -- 注册时带的邀请码（前端通过 options.data.invite_code 传入）
  v_ref_code := nullif(upper(trim(coalesce(NEW.raw_user_meta_data->>'invite_code', ''))), '');
  if v_ref_code is not null then
    select id into v_ref_uid from public.profiles where invite_code = v_ref_code and id <> NEW.id;
    -- 不允许自己邀请自己
    if v_ref_uid is not null then
      update public.profiles set referred_by = v_ref_uid where id = NEW.id;
    end if;
  end if;

  -- 前 200 名：加事务级锁，避免并发注册同时抢同一个名次
  perform pg_advisory_xact_lock(hashtext('ctbu_founder_rank'));
  -- 只统计"非管理员"的注册顺序：管理员是站主，不该占用名额，
  -- 否则真实学生只能拿到 199 个席位。
  select count(*) + 1 into v_ordinal
    from public.profiles p
    join auth.users u on u.id = p.id
   where p.created_at <= (select created_at from public.profiles where id = NEW.id)
     and coalesce(u.raw_app_meta_data->>'role', '') <> 'admin';

  if v_ordinal <= v_quota then
    v_is_founder := true;

    -- 2026-10-30 改：统一到 v_founder_floor。
    -- 之前是 greatest(now() + 1 month, 12-31)，12 月注册会拿到"次年 1 月"，
    -- 与用户要求的"统一 12-31 截止"不一致。
    if v_founder_floor > now() then
      v_expires := v_founder_floor;
    else
      -- 兜底：年末之后注册的（理论上名额早已满），仍给 1 个月，避免给过去时间
      v_expires := now() + v_trial;
    end if;

    update public.profiles
       set is_founder = true,
           membership_tier = 'founder',
           membership_expires_at = v_expires
     where id = NEW.id;

    insert into public.membership_logs (user_id, tier, months, reason, expires_after)
    values (NEW.id, 'founder', 1, 'founder_trial', v_expires);
  end if;

  -- 结算邀请人的奖励（新用户注册成功即触发）
  if v_ref_uid is not null then
    perform public.settle_invite_rewards(v_ref_uid);
  end if;

  return NEW;
end;
$$;


--
-- Name: increment_paper_view(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_paper_view(p_paper_id uuid) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  update public.papers set view_count = coalesce(view_count, 0) + 1 where id = p_paper_id;
$$;


--
-- Name: is_admin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_admin() RETURNS boolean
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if auth.uid() is null then
    return false;
  end if;
  if to_regclass('public.app_secrets') is null then
    return false;                     -- 建表前一律不是管理员
  end if;
  return exists (
    select 1 from public.app_secrets
     where key = 'admin_user_ids'
       and auth.uid()::text = any (string_to_array(value, ','))
  );
end
$$;


--
-- Name: is_lifetime(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_lifetime(p_uid uuid) RETURNS boolean
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select coalesce((select membership_expires_at = 'infinity'::timestamptz from profiles where id = p_uid), false);
$$;


--
-- Name: mark_order_claimed(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_order_claimed(p_order_no text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'reason', 'not_logged_in'); end if;
  update public.payment_orders set claimed_at = now()
   where order_no = p_order_no and user_id = v_uid and status = 'pending';
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  return jsonb_build_object('ok', true);
end; $$;


--
-- Name: my_access_status(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.my_access_status(p_free_limit integer DEFAULT 3) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_uid     uuid := auth.uid();
  v_member  boolean := false;
  v_until   timestamptz;
  v_used    integer := 0;
begin
  if v_uid is null then
    return jsonb_build_object(
      'logged_in', false, 'is_member', false, 'member_until', null,
      'free_used', 0, 'free_remaining', p_free_limit);
  end if;

  select membership_expires_at into v_until from public.profiles where id = v_uid;
  v_member := coalesce(v_until > now(), false);

  select count(*) into v_used
    from public.paper_unlocks
   where user_id = v_uid and unlock_type = 'free';

  return jsonb_build_object(
    'logged_in', true,
    'is_member', v_member,
    -- ⚠️ 与线上**逐字节一致**：线上对永久会员返回字符串 "infinity"（不转 null）。
    --    我原本"顺手"把它转成 null 更好看，但对拍时发现与线上不符 ——
    --    迁移的第一要求是行为等价，任何"改进"都该另开一轮，不能夹带在搬迁里。
    'member_until', v_until,
    'free_used', v_used,
    'free_remaining', greatest(p_free_limit - v_used, 0)
  );
end
$$;


--
-- Name: my_membership(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.my_membership() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_uid uuid := auth.uid();
  r     record;
begin
  if v_uid is null then return jsonb_build_object('logged_in', false); end if;

  select membership_expires_at, membership_tier, is_founder, invite_code, invite_months_granted, created_at
    into r from public.profiles where id = v_uid;

  return jsonb_build_object(
    'logged_in', true,
    'tier', coalesce(r.membership_tier, 'free'),
    'expires_at', r.membership_expires_at,
    'is_lifetime', r.membership_expires_at = 'infinity'::timestamptz,
    'is_member', r.membership_expires_at is not null and r.membership_expires_at > now(),
    'is_founder', coalesce(r.is_founder, false),
    'invite_code', r.invite_code,
    'invite_months_granted', coalesce(r.invite_months_granted, 0),
    'joined_at', r.created_at,
    'invite', public.settle_invite_rewards(v_uid)
  );
end; $$;


--
-- Name: order_status(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.order_status(p_order_no text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_uid uuid := auth.uid();
  o     record;
begin
  if v_uid is null then return jsonb_build_object('ok', false, 'reason', 'not_logged_in'); end if;

  select order_no, user_id, tier, amount_cents, status, prepay_code_url, paid_at
    into o
    from payment_orders
   where order_no = p_order_no;

  if not found then return jsonb_build_object('ok', false, 'reason', 'order_not_found'); end if;
  if o.user_id <> v_uid then return jsonb_build_object('ok', false, 'reason', 'forbidden'); end if;

  return jsonb_build_object(
    'ok', true,
    'order_no', o.order_no,
    'tier', o.tier,
    'amount_cents', o.amount_cents,
    'status', o.status,
    'code_url', o.prepay_code_url,
    'paid_at', o.paid_at
  );
end; $$;


--
-- Name: settle_invite_rewards(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.settle_invite_rewards(p_uid uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_valid    integer;
  v_should   integer;
  v_granted  integer;
  v_give     integer;
  v_exp      timestamptz;
begin
  -- 有效邀请 = 通过我的邀请码注册、且已确认邮箱的用户
  select count(*) into v_valid
    from public.profiles p
    join auth.users u on u.id = p.id
   where p.referred_by = p_uid
     and u.email_confirmed_at is not null;

  v_should := v_valid / 4;                                  -- 每 4 人 1 个月
  select invite_months_granted into v_granted from public.profiles where id = p_uid;
  if v_granted is null then v_granted := 0; end if;

  v_give := v_should - v_granted;
  if v_give > 0 and not public.is_lifetime(p_uid) then
    v_exp := public.grant_membership(p_uid, 'invite', v_give, 'invite');
    update public.profiles set invite_months_granted = v_should where id = p_uid;
  elsif v_give > 0 then
    update public.profiles set invite_months_granted = v_should where id = p_uid;
  end if;

  return jsonb_build_object(
    'valid_invites', v_valid,
    'months_granted_total', v_should,
    'months_granted_now', greatest(v_give, 0),
    'next_reward_in', 4 - (v_valid % 4)
  );
end; $$;


--
-- Name: unlock_paper(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.unlock_paper(p_paper_id uuid, p_free_limit integer DEFAULT 3) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_uid    uuid := auth.uid();
  v_member boolean := false;
  v_used   integer := 0;
  v_exists boolean := false;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'not_logged_in', 'free_remaining', p_free_limit);
  end if;

  -- 已经解锁过：直接放行，不再消耗额度（幂等）
  select exists (select 1 from public.paper_unlocks
                  where user_id = v_uid and paper_id = p_paper_id) into v_exists;
  if v_exists then
    select count(*) into v_used from public.paper_unlocks
     where user_id = v_uid and unlock_type = 'free';
    return jsonb_build_object('ok', true, 'reason', 'already_unlocked',
                              'free_remaining', greatest(p_free_limit - v_used, 0));
  end if;

  select coalesce(membership_expires_at > now(), false) into v_member
    from public.profiles where id = v_uid;

  if v_member then
    insert into public.paper_unlocks (user_id, paper_id, unlock_type)
    values (v_uid, p_paper_id, 'member') on conflict do nothing;
    select count(*) into v_used from public.paper_unlocks
     where user_id = v_uid and unlock_type = 'free';
    return jsonb_build_object('ok', true, 'reason', 'member',
                              'free_remaining', greatest(p_free_limit - v_used, 0));
  end if;

  select count(*) into v_used from public.paper_unlocks
   where user_id = v_uid and unlock_type = 'free';

  if v_used < p_free_limit then
    insert into public.paper_unlocks (user_id, paper_id, unlock_type)
    values (v_uid, p_paper_id, 'free') on conflict do nothing;
    return jsonb_build_object('ok', true, 'reason', 'free',
                              'free_remaining', greatest(p_free_limit - v_used - 1, 0));
  end if;

  return jsonb_build_object('ok', false, 'reason', 'quota_exceeded', 'free_remaining', 0);
end
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: _backup_founder_expiry_20261023; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public._backup_founder_expiry_20261023 (
    id uuid,
    membership_tier text,
    membership_expires_at timestamp with time zone,
    backed_up_at timestamp with time zone
);


--
-- Name: TABLE _backup_founder_expiry_20261023; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public._backup_founder_expiry_20261023 IS '2026-10-23 延长创始会员试用期前的快照，用于回滚。';


--
-- Name: ai_page_ocr; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_page_ocr (
    paper_id uuid NOT NULL,
    page integer NOT NULL,
    which text DEFAULT 'paper'::text NOT NULL,
    ocr_text text NOT NULL,
    model text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ai_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_usage (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    paper_id uuid,
    page integer,
    which text,
    question text,
    answer_chars integer,
    model text,
    tokens_in integer,
    tokens_out integer,
    ms integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ai_usage_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ai_usage_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ai_usage_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ai_usage_id_seq OWNED BY public.ai_usage.id;


--
-- Name: app_secrets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_secrets (
    key text NOT NULL,
    value text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: appeals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.appeals (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    reason text NOT NULL,
    message text,
    contact text,
    status text DEFAULT 'pending'::text NOT NULL,
    admin_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    handled_at timestamp with time zone
);


--
-- Name: appeals_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.appeals ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.appeals_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: concurrent_violations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.concurrent_violations (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    kind text NOT NULL,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    level integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: concurrent_violations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.concurrent_violations ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.concurrent_violations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: favorites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.favorites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    paper_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: membership_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.membership_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    tier text NOT NULL,
    months integer,
    reason text NOT NULL,
    order_no text,
    granted_by uuid,
    expires_after timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mistakes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mistakes (
    id bigint NOT NULL,
    user_id uuid NOT NULL,
    paper_id uuid NOT NULL,
    page integer DEFAULT 1 NOT NULL,
    question text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mistakes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.mistakes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: mistakes_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.mistakes_id_seq OWNED BY public.mistakes.id;


--
-- Name: paper_unlocks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.paper_unlocks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    paper_id uuid NOT NULL,
    unlock_type text DEFAULT 'free'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: papers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.papers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    course_id text NOT NULL,
    course_name text NOT NULL,
    category text,
    year integer,
    semester text,
    exam_type text,
    source_type text,
    resource_type text,
    source_school text,
    has_answer boolean DEFAULT false NOT NULL,
    has_solution boolean DEFAULT false NOT NULL,
    solution_page integer,
    page_count integer DEFAULT 1 NOT NULL,
    file_path text,
    answer_path text,
    file_size bigint,
    description text,
    view_count integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'published'::text NOT NULL,
    visibility text DEFAULT 'public'::text NOT NULL,
    uploaded_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    title text,
    paper_kind text
);


--
-- Name: COLUMN papers.answer_path; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.papers.answer_path IS '答案/评分标准 PDF 在 papers 私有桶里的路径；与 file_path 配对（试卷在前、答案独立成一份）。为空表示该试卷没有独立答案文件。2026-10-16 新增。';


--
-- Name: payment_alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_alerts (
    id bigint NOT NULL,
    kind text NOT NULL,
    order_no text,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE payment_alerts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.payment_alerts IS '支付异常留痕（2026-10-28）。业务拒绝/迟付/开通失败都会记一行，并触发管理员邮件。';


--
-- Name: payment_alerts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.payment_alerts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: payment_alerts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.payment_alerts_id_seq OWNED BY public.payment_alerts.id;


--
-- Name: payment_orders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_orders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    order_no text NOT NULL,
    user_id uuid NOT NULL,
    tier text NOT NULL,
    amount_cents integer NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    provider text DEFAULT 'manual'::text NOT NULL,
    provider_txn_id text,
    payer_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    paid_at timestamp with time zone,
    confirmed_by uuid,
    claimed_at timestamp with time zone,
    prepay_code_url text,
    prepay_at timestamp with time zone,
    transaction_id text,
    paid_amount_cents integer,
    notify_at timestamp with time zone,
    notify_payload jsonb,
    CONSTRAINT payment_orders_amount_cents_check CHECK ((amount_cents > 0)),
    CONSTRAINT payment_orders_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'paid'::text, 'cancelled'::text, 'expired'::text]))),
    CONSTRAINT payment_orders_tier_check CHECK ((tier = ANY (ARRAY['monthly'::text, 'yearly'::text, 'lifetime'::text])))
);


--
-- Name: COLUMN payment_orders.prepay_code_url; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payment_orders.prepay_code_url IS '支付渠道返回的二维码内容（微信 Native 的 code_url）';


--
-- Name: COLUMN payment_orders.prepay_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payment_orders.prepay_at IS '预支付单生成时间';


--
-- Name: COLUMN payment_orders.transaction_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payment_orders.transaction_id IS '渠道流水号，用于幂等与对账';


--
-- Name: COLUMN payment_orders.paid_amount_cents; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payment_orders.paid_amount_cents IS '渠道回调的实收金额，用于与 amount_cents 比对';


--
-- Name: COLUMN payment_orders.notify_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payment_orders.notify_at IS '收到支付回调的时间';


--
-- Name: COLUMN payment_orders.notify_payload; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payment_orders.notify_payload IS '回调报文（已解密的业务部分，留档备查）';


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    display_name text,
    email text,
    student_id text DEFAULT ''::text,
    school text DEFAULT ''::text,
    college text DEFAULT ''::text,
    membership_tier text DEFAULT 'free'::text NOT NULL,
    membership_expires_at timestamp with time zone,
    is_founder boolean DEFAULT false NOT NULL,
    invite_code text,
    referred_by uuid,
    invite_months_granted integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    ban_level integer DEFAULT 0 NOT NULL,
    ban_until timestamp with time zone,
    ban_reason text,
    wx_openid text,
    max_devices integer
);


--
-- Name: COLUMN profiles.wx_openid; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.wx_openid IS '微信 openid（AppID wx2ff70fcb1bf5fa21）。用于 JSAPI 支付下单，避免每次支付都走 OAuth 授权跳转。2026-10-27 加。';


--
-- Name: COLUMN profiles.max_devices; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.max_devices IS '允许同时在线的设备数：NULL=全局默认(MAX_DEVICES=2)，0=不限，>0=该数字（2026-10-28）';


--
-- Name: reading_progress; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reading_progress (
    user_id uuid NOT NULL,
    paper_id uuid NOT NULL,
    page integer DEFAULT 1 NOT NULL,
    which text DEFAULT 'paper'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: recent_views; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recent_views (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    paper_id text NOT NULL,
    viewed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: security_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.security_logs (
    id bigint NOT NULL,
    user_id uuid,
    kind text NOT NULL,
    detail jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE security_logs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.security_logs IS '安全事件流水：设备超限、异地登录、踢设备等';


--
-- Name: security_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.security_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: security_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.security_logs_id_seq OWNED BY public.security_logs.id;


--
-- Name: view_heartbeats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.view_heartbeats (
    user_id uuid NOT NULL,
    device_id text NOT NULL,
    resource text DEFAULT ''::text NOT NULL,
    ip text,
    seen_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ai_usage id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_usage ALTER COLUMN id SET DEFAULT nextval('public.ai_usage_id_seq'::regclass);


--
-- Name: mistakes id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mistakes ALTER COLUMN id SET DEFAULT nextval('public.mistakes_id_seq'::regclass);


--
-- Name: payment_alerts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_alerts ALTER COLUMN id SET DEFAULT nextval('public.payment_alerts_id_seq'::regclass);


--
-- Name: security_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_logs ALTER COLUMN id SET DEFAULT nextval('public.security_logs_id_seq'::regclass);


--
-- Name: ai_page_ocr ai_page_ocr_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_page_ocr
    ADD CONSTRAINT ai_page_ocr_pkey PRIMARY KEY (paper_id, page, which);


--
-- Name: ai_usage ai_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_usage
    ADD CONSTRAINT ai_usage_pkey PRIMARY KEY (id);


--
-- Name: app_secrets app_secrets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_secrets
    ADD CONSTRAINT app_secrets_pkey PRIMARY KEY (key);


--
-- Name: appeals appeals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appeals
    ADD CONSTRAINT appeals_pkey PRIMARY KEY (id);


--
-- Name: concurrent_violations concurrent_violations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.concurrent_violations
    ADD CONSTRAINT concurrent_violations_pkey PRIMARY KEY (id);


--
-- Name: favorites favorites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.favorites
    ADD CONSTRAINT favorites_pkey PRIMARY KEY (id);


--
-- Name: membership_logs membership_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.membership_logs
    ADD CONSTRAINT membership_logs_pkey PRIMARY KEY (id);


--
-- Name: mistakes mistakes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mistakes
    ADD CONSTRAINT mistakes_pkey PRIMARY KEY (id);


--
-- Name: mistakes mistakes_user_id_paper_id_page_question_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mistakes
    ADD CONSTRAINT mistakes_user_id_paper_id_page_question_key UNIQUE (user_id, paper_id, page, question);


--
-- Name: paper_unlocks paper_unlocks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.paper_unlocks
    ADD CONSTRAINT paper_unlocks_pkey PRIMARY KEY (id);


--
-- Name: papers papers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.papers
    ADD CONSTRAINT papers_pkey PRIMARY KEY (id);


--
-- Name: payment_alerts payment_alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_alerts
    ADD CONSTRAINT payment_alerts_pkey PRIMARY KEY (id);


--
-- Name: payment_orders payment_orders_order_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_orders
    ADD CONSTRAINT payment_orders_order_no_key UNIQUE (order_no);


--
-- Name: payment_orders payment_orders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_orders
    ADD CONSTRAINT payment_orders_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: reading_progress reading_progress_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reading_progress
    ADD CONSTRAINT reading_progress_pkey PRIMARY KEY (user_id, paper_id, which);


--
-- Name: recent_views recent_views_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recent_views
    ADD CONSTRAINT recent_views_pkey PRIMARY KEY (id);


--
-- Name: security_logs security_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_logs
    ADD CONSTRAINT security_logs_pkey PRIMARY KEY (id);


--
-- Name: view_heartbeats view_heartbeats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.view_heartbeats
    ADD CONSTRAINT view_heartbeats_pkey PRIMARY KEY (user_id, device_id);


--
-- Name: appeals_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX appeals_user_idx ON public.appeals USING btree (user_id, created_at DESC);


--
-- Name: cv_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cv_created_idx ON public.concurrent_violations USING btree (created_at DESC);


--
-- Name: cv_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cv_user_idx ON public.concurrent_violations USING btree (user_id, created_at DESC);


--
-- Name: favorites_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX favorites_uniq ON public.favorites USING btree (user_id, paper_id);


--
-- Name: idx_ai_usage_user_day; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_usage_user_day ON public.ai_usage USING btree (user_id, created_at);


--
-- Name: idx_mistakes_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mistakes_user ON public.mistakes USING btree (user_id, created_at DESC);


--
-- Name: idx_profiles_wx_openid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_wx_openid ON public.profiles USING btree (wx_openid) WHERE (wx_openid IS NOT NULL);


--
-- Name: membership_logs_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX membership_logs_user_idx ON public.membership_logs USING btree (user_id, created_at DESC);


--
-- Name: paper_unlocks_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX paper_unlocks_uniq ON public.paper_unlocks USING btree (user_id, paper_id);


--
-- Name: paper_unlocks_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX paper_unlocks_user_idx ON public.paper_unlocks USING btree (user_id, created_at DESC);


--
-- Name: papers_course_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX papers_course_idx ON public.papers USING btree (course_id, status);


--
-- Name: papers_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX papers_created_idx ON public.papers USING btree (created_at DESC);


--
-- Name: papers_visibility_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX papers_visibility_idx ON public.papers USING btree (visibility, status);


--
-- Name: payment_alerts_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_alerts_created_idx ON public.payment_alerts USING btree (created_at DESC);


--
-- Name: payment_alerts_order_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_alerts_order_idx ON public.payment_alerts USING btree (order_no);


--
-- Name: payment_orders_pending_prepay_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_orders_pending_prepay_idx ON public.payment_orders USING btree (created_at) WHERE (status = 'pending'::text);


--
-- Name: payment_orders_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_orders_status_idx ON public.payment_orders USING btree (status, created_at DESC);


--
-- Name: payment_orders_transaction_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX payment_orders_transaction_id_key ON public.payment_orders USING btree (transaction_id) WHERE (transaction_id IS NOT NULL);


--
-- Name: payment_orders_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_orders_user_idx ON public.payment_orders USING btree (user_id, created_at DESC);


--
-- Name: profiles_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX profiles_created_at_idx ON public.profiles USING btree (created_at);


--
-- Name: profiles_invite_code_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX profiles_invite_code_key ON public.profiles USING btree (invite_code) WHERE (invite_code IS NOT NULL);


--
-- Name: profiles_referred_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX profiles_referred_by_idx ON public.profiles USING btree (referred_by);


--
-- Name: recent_views_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX recent_views_uniq ON public.recent_views USING btree (user_id, paper_id);


--
-- Name: recent_views_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX recent_views_user_idx ON public.recent_views USING btree (user_id, viewed_at DESC);


--
-- Name: security_logs_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX security_logs_kind_idx ON public.security_logs USING btree (kind, created_at DESC);


--
-- Name: security_logs_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX security_logs_user_idx ON public.security_logs USING btree (user_id, created_at DESC);


--
-- Name: vh_seen_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX vh_seen_idx ON public.view_heartbeats USING btree (user_id, seen_at DESC);


--
-- Name: appeals appeals_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.appeals
    ADD CONSTRAINT appeals_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: concurrent_violations concurrent_violations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.concurrent_violations
    ADD CONSTRAINT concurrent_violations_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: membership_logs membership_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.membership_logs
    ADD CONSTRAINT membership_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: payment_orders payment_orders_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_orders
    ADD CONSTRAINT payment_orders_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: security_logs security_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.security_logs
    ADD CONSTRAINT security_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: view_heartbeats view_heartbeats_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.view_heartbeats
    ADD CONSTRAINT view_heartbeats_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: app_secrets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.app_secrets ENABLE ROW LEVEL SECURITY;

--
-- Name: membership_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.membership_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: membership_logs mlogs_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY mlogs_select ON public.membership_logs FOR SELECT TO authenticated USING (((user_id = auth.uid()) OR public.is_admin()));


--
-- Name: payment_orders orders_admin_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY orders_admin_update ON public.payment_orders FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());


--
-- Name: payment_orders orders_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY orders_insert_own ON public.payment_orders FOR INSERT TO authenticated WITH CHECK (((user_id = auth.uid()) AND (status = 'pending'::text)));


--
-- Name: payment_orders orders_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY orders_select_own ON public.payment_orders FOR SELECT TO authenticated USING (((user_id = auth.uid()) OR public.is_admin()));


--
-- Name: payment_orders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.payment_orders ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles select_admin_all_profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY select_admin_all_profiles ON public.profiles FOR SELECT TO authenticated USING (public.is_admin());


--
-- Name: profiles update_admin_all_profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY update_admin_all_profiles ON public.profiles FOR UPDATE TO authenticated USING (public.is_admin()) WITH CHECK (public.is_admin());


--
-- PostgreSQL database dump complete
--


