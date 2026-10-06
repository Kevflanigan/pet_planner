// Supabase Edge Function: notify-new-user
// Called by a Database Webhook on INSERT into public.new_user_notifications.
// It only reads the user id, then loads everything from the database itself.
// Secrets: RESEND_API_KEY, FROM_ADDRESS, optional APP_NAME (default "PETS BEHAVING")
import { createClient } from "npm:@supabase/supabase-js@2";

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const when = (d: string) => new Date(d).toLocaleString("en-GB", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/London" });

Deno.serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}));
    const only: string | null = body?.record?.user_id ?? body?.user_id ?? null;
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const app = Deno.env.get("APP_NAME") ?? "PETS BEHAVING";
    const from = `${app} <${Deno.env.get("FROM_ADDRESS")}>`;
    const { data: cfg } = await admin.from("app_config").select("value").eq("key", "owner_email").maybeSingle();
    const owner = cfg?.value as string | undefined;   // resolved server-side, never from the request

    let q = admin.from("new_user_notifications").select("user_id, attempts").in("status", ["pending", "failed"]).lt("attempts", 3).limit(20);
    if (only) q = q.eq("user_id", only);
    const { data: rows } = await q;
    const results: Record<string, string> = {};

    for (const row of rows ?? []) {
      const stale = new Date(Date.now() - 5 * 60e3).toISOString();
      // Claim the row so a duplicate webhook call cannot send a second email
      const { data: claimed } = await admin.from("new_user_notifications")
        .update({ claimed_at: new Date().toISOString(), attempts: row.attempts + 1 })
        .eq("user_id", row.user_id).in("status", ["pending", "failed"]).or(`claimed_at.is.null,claimed_at.lt.${stale}`)
        .select("user_id").maybeSingle();
      if (!claimed) { results[row.user_id] = "already"; continue; }
      try {
        if (!owner) throw new Error("Owner email not configured");
        const { data: au } = await admin.auth.admin.getUserById(row.user_id);
        const { data: pr } = await admin.from("profiles").select("first_name,last_name,business_name").eq("id", row.user_id).maybeSingle();
        const { data: ent } = await admin.rpc("get_user_entitlement", { p_user: row.user_id });
        const e = Array.isArray(ent) ? ent[0] : ent;
        const name = [pr?.first_name, pr?.last_name].filter(Boolean).join(" ") || "Not given";
        const status = e ? `${e.subscription_status} (${e.access_type ?? "none"}), ${e.days_remaining} days left` : "Unknown";
        const html = `<p><b>New user registered</b></p><p>Name: ${esc(name)}<br>Business: ${esc(pr?.business_name ?? "Not given")}<br>Email: ${esc(au?.user?.email)}<br>Registered: ${au?.user?.created_at ? when(au.user.created_at) : "Unknown"}<br>Account ID: ${esc(row.user_id)}<br>Access: ${esc(status)}</p>`;
        const r = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { Authorization: "Bearer " + Deno.env.get("RESEND_API_KEY"), "Content-Type": "application/json", "Idempotency-Key": `new-user-${row.user_id}` },
          body: JSON.stringify({ from, to: [owner], subject: `New user registered — ${app}`, html }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.message || "Email provider error");
        await admin.from("new_user_notifications").update({ status: "sent", sent_at: new Date().toISOString(), provider_message_id: j.id, error: null }).eq("user_id", row.user_id);
        await admin.from("email_log").insert({ kind: "new_user", recipient: owner, recipient_type: "app_owner", status: "sent", provider_message_id: j.id, sent_at: new Date().toISOString() });
        results[row.user_id] = "sent";
      } catch (err) {
        console.error("new-user notification failed", row.user_id, err);
        const msg = String((err as Error).message).slice(0, 300);
        await admin.from("new_user_notifications").update({ status: "failed", error: msg }).eq("user_id", row.user_id);
        await admin.from("email_log").insert({ kind: "new_user", recipient: owner ?? "unknown", recipient_type: "app_owner", status: "failed", error: msg });
        results[row.user_id] = "failed";
      }
    }
    return new Response(JSON.stringify({ results }), { headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: "Something went wrong." }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
