-- PART A: where are we? Run in the Supabase SQL Editor (project kwrfhagijxqsrkjaufzz). Changes nothing. Safe at any time.
with c(area, check_name, result, expected) as (values
 ('1 subscriptions','table exists', (to_regclass('public.subscriptions') is not null)::text, 'true'),
 ('1 subscriptions','6 new columns added by migration.sql', (select count(*) from information_schema.columns where table_schema='public' and table_name='subscriptions' and column_name in ('entitled_until','grace_until','store','product_id','last_event_id','last_event_at'))::text, '6'),
 ('1 subscriptions','one row per user (unique index)', exists(select 1 from pg_indexes where schemaname='public' and tablename='subscriptions' and indexdef ilike '%unique%' and indexdef ilike '%(user_id)%')::text, 'true'),
 ('1 subscriptions','row level security on', coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.subscriptions')), false)::text, 'true'),
 ('1 subscriptions','users can read their own row (policy)', ((select count(*) from pg_policies where schemaname='public' and tablename='subscriptions' and cmd='SELECT') >= 1)::text, 'true'),
 ('1 subscriptions','no policy lets users write (expect 0)', (select count(*) from pg_policies where schemaname='public' and tablename='subscriptions' and cmd in ('INSERT','UPDATE','DELETE','ALL'))::text, '0'),
 ('1 subscriptions','signed-in users and visitors cannot write (privileges)', (not (has_table_privilege('authenticated','public.subscriptions','INSERT') or has_table_privilege('authenticated','public.subscriptions','UPDATE') or has_table_privilege('authenticated','public.subscriptions','DELETE') or has_table_privilege('anon','public.subscriptions','INSERT') or has_table_privilege('anon','public.subscriptions','UPDATE') or has_table_privilege('anon','public.subscriptions','DELETE')))::text, 'true'),
 ('2 functions','entitlement_state exists', (to_regprocedure('public.entitlement_state(text,timestamptz,timestamptz,timestamptz,timestamptz)') is not null)::text, 'true'),
 ('2 functions','get_entitlement exists', (to_regprocedure('public.get_entitlement()') is not null)::text, 'true'),
 ('2 functions','apply_subscription_event exists', (to_regprocedure('public.apply_subscription_event(uuid,text,timestamptz,timestamptz,text,text,text,timestamptz)') is not null)::text, 'true'),
 ('2 functions','get_entitlement: signed-in yes, visitors no', case when to_regprocedure('public.get_entitlement()') is null then 'missing' else (has_function_privilege('authenticated','public.get_entitlement()','EXECUTE') and not has_function_privilege('anon','public.get_entitlement()','EXECUTE'))::text end, 'true'),
 ('2 functions','apply_subscription_event: service role only', case when to_regprocedure('public.apply_subscription_event(uuid,text,timestamptz,timestamptz,text,text,text,timestamptz)') is null then 'missing' else (has_function_privilege('service_role','public.apply_subscription_event(uuid,text,timestamptz,timestamptz,text,text,text,timestamptz)','EXECUTE') and not has_function_privilege('authenticated','public.apply_subscription_event(uuid,text,timestamptz,timestamptz,text,text,text,timestamptz)','EXECUTE') and not has_function_privilege('anon','public.apply_subscription_event(uuid,text,timestamptz,timestamptz,text,text,text,timestamptz)','EXECUTE'))::text end, 'true'),
 ('3 sign-up trial','trigger on_auth_user_created_trial exists', exists(select 1 from pg_trigger where tgrelid='auth.users'::regclass and tgname='on_auth_user_created_trial' and not tgisinternal)::text, 'true'),
 ('3 sign-up trial','trigger function runs with owner rights', coalesce((select prosecdef from pg_proc where proname='create_user_trial' and pronamespace='public'::regnamespace limit 1), false)::text, 'true'),
 ('4 profiles (used by the app)','table exists', (to_regclass('public.profiles') is not null)::text, 'true'),
 ('4 profiles (used by the app)','row level security on', coalesce((select relrowsecurity from pg_class where oid = to_regclass('public.profiles')), false)::text, 'true'),
 ('4 profiles (used by the app)','4 own-row policies', (select count(*) from pg_policies where schemaname='public' and tablename='profiles')::text, '4'),
 ('5 signups (old, unused)','table exists', (to_regclass('public.signups') is not null)::text, '-'),
 ('6 data','accounts', (select count(*) from auth.users)::text, '-'),
 ('6 data','accounts with a subscription row', (select count(distinct user_id) from public.subscriptions)::text, '-'),
 ('6 data','accounts WITHOUT a row (older accounts: fine, they get one when first checked)', (select count(*) from auth.users u where not exists (select 1 from public.subscriptions s where s.user_id = u.id))::text, '-'),
 ('6 data','users with more than one subscription row (expect 0)', (select count(*) from (select user_id from public.subscriptions group by 1 having count(*) > 1) d)::text, '0'),
 ('6 data','trialing rows with no end date (expect 0)', (select count(*) from public.subscriptions where status::text = 'trialing' and trial_ends_at is null)::text, '0'),
 ('6 data','rows by status', coalesce((select string_agg(status::text || ': ' || n, ', ') from (select status, count(*) n from public.subscriptions group by 1) x), 'none'), '-'),
 ('6 data','accounts with a board name saved', (select count(*) from auth.users where raw_user_meta_data ->> 'board_name' is not null)::text, '-'),
 ('6 data','accounts with a household code saved', (select count(*) from public.profiles where household_key is not null)::text, '-')
)
select area, check_name, result, expected,
       case when expected = '-' then 'info' when result = expected then 'PASS' else 'CHECK' end as status
from c order by area, check_name;

-- PART B: does the access rule give the right answers? Run ONLY if Part A shows the 3 functions exist. Changes nothing.
select scenario, result, expected, case when result = expected then 'PASS' else 'CHECK' end as status
from (values
 ('trial still running',               public.entitlement_state('trialing', now() + interval '1 day', null, null), 'trial'),
 ('trial has ended',                   public.entitlement_state('trialing', now() - interval '1 day', null, null), 'expired'),
 ('trial with no end date',            public.entitlement_state('trialing', null, null, null), 'expired'),
 ('paid and renewed',                  public.entitlement_state('active', null, now() + interval '10 days', null), 'paid'),
 ('cancelled, still inside paid time', public.entitlement_state('cancelled', null, now() + interval '10 days', null), 'paid'),
 ('cancelled and ended',               public.entitlement_state('cancelled', null, now() - interval '1 day', null), 'expired'),
 ('payment failed, inside grace',      public.entitlement_state('past_due', null, now() - interval '1 day', now() + interval '2 days'), 'grace'),
 ('payment failed, grace over',        public.entitlement_state('past_due', null, now() - interval '1 day', now() - interval '1 hour'), 'expired')
) as t(scenario, result, expected);

-- PART C: your own accounts and their subscription state (shows email addresses, so blur them before sharing a screenshot).
select u.email, u.created_at, s.status, s.trial_ends_at, s.entitled_until, s.provider
from auth.users u left join public.subscriptions s on s.user_id = u.id
order by u.created_at desc limit 20;
