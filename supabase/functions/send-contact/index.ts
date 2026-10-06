// Supabase Edge Function: send-contact
// Secrets: RESEND_API_KEY, FROM_ADDRESS, optional APP_NAME (default "PETS BEHAVING")
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const when = (d: string) => new Date(d).toLocaleString("en-GB", { dateStyle: "long", timeStyle: "short", timeZone: "Europe/London" });

async function mail(from: string, to: string, subject: string, html: string, idem: string, replyTo?: string) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + Deno.env.get("RESEND_API_KEY"), "Content-Type": "application/json", "Idempotency-Key": idem },
    body: JSON.stringify({ from, to: [to], subject, html, ...(replyTo ? { reply_to: replyTo } : {}) }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || "Email provider error");
  return j.id as string;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: u } = await userClient.auth.getUser();
    if (!u?.user) return json({ error: "Please log in again." }, 401);
    const { id } = await req.json();

    const admin = createClient(url, Deno.env.get("SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const stale = new Date(Date.now() - 5 * 60e3).toISOString();
    // Claim the message so a double click or retry cannot send twice
    const { data: m } = await admin.from("contact_messages").update({ claimed_at: new Date().toISOString() })
      .eq("id", id).eq("user_id", u.user.id).in("status", ["pending", "failed"])
      .or(`claimed_at.is.null,claimed_at.lt.${stale}`).select().maybeSingle();
    if (!m) return json({ owner: "already" });

    const app = Deno.env.get("APP_NAME") ?? "PETS BEHAVING";
    const from = `${app} <${Deno.env.get("FROM_ADDRESS")}>`;
    const log = (kind: string, recipient: string, status: string, mid: string | null, error: string | null) =>
      admin.from("email_log").insert({ kind, recipient, recipient_type: kind === "contact" ? "app_owner" : "sender", status,
        provider_message_id: mid, error, sent_at: status === "sent" ? new Date().toISOString() : null });

    // 1. Message to the owner (recipient was resolved server-side when the message was saved)
    let owner = "failed", copy = "skipped";
    try {
      if (!m.recipient_email) throw new Error("Owner email not configured");
      const html = `<p><b>New contact message</b></p><p>Name: ${esc(m.sender_name)}<br>Email: ${esc(m.sender_email)}<br>Submitted: ${when(m.created_at)}</p><p>${esc(m.message).replace(/\n/g, "<br>")}</p>`;
      const mid = await mail(from, m.recipient_email, `New Contact Message — ${app}`, html, `contact-${m.id}-owner`, m.sender_email);
      await admin.from("contact_messages").update({ status: "sent", sent_at: new Date().toISOString(), provider_message_id: mid, error: null }).eq("id", m.id);
      await log("contact", m.recipient_email, "sent", mid, null);
      owner = "sent";
    } catch (e) {
      console.error("contact owner email failed", e);
      const err = String((e as Error).message).slice(0, 300);
      await admin.from("contact_messages").update({ status: "failed", error: err }).eq("id", m.id);
      await log("contact", m.recipient_email ?? "unknown", "failed", null, err);
    }

    // 2. Confirmation copy to the sender (only if the owner email really went)
    if (owner === "sent") {
      try {
        const html = `<p>Hello ${esc(m.sender_name)},</p><p>Thanks for getting in touch. We've received your message and will reply as soon as we can.</p><p><b>Your message:</b><br>${esc(m.message).replace(/\n/g, "<br>")}</p><p>${esc(app)}</p>`;
        const mid = await mail(from, m.sender_email, "We've received your message", html, `contact-${m.id}-copy`);
        await admin.from("contact_messages").update({ copy_status: "sent", copy_message_id: mid }).eq("id", m.id);
        await log("contact_copy", m.sender_email, "sent", mid, null);
        copy = "sent";
      } catch (e) {
        console.error("contact copy failed", e);
        const err = String((e as Error).message).slice(0, 300);
        await admin.from("contact_messages").update({ copy_status: "failed", copy_error: err }).eq("id", m.id);
        await log("contact_copy", m.sender_email, "failed", null, err);
        copy = "failed";
      }
    }
    return json({ owner, copy });
  } catch (e) {
    console.error(e);
    return json({ error: "Something went wrong." }, 500);
  }
});
