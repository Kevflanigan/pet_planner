// Supabase Edge Function: send-invoice
// Secrets needed (Edge Functions > Secrets): RESEND_API_KEY, FROM_ADDRESS (an address on your verified Resend domain)
import { createClient } from "npm:@supabase/supabase-js@2";
import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";
import { Buffer } from "node:buffer";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const gbp = (n: number) => "£" + Number(n).toFixed(2);
const day = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

async function makePdf(inv: any): Promise<string> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let y = 790;
  const text = (t: string, x: number, size = 10, f = font) => { page.drawText(t, { x, y, size, font: f, color: rgb(0.08, 0.15, 0.18) }); };
  const line = (t: string, size = 10, f = font, x = 50) => { text(t, x, size, f); y -= size + 6; };
  line(inv.business_name, 20, bold);
  y -= 6;
  line("INVOICE " + inv.invoice_number, 14, bold);
  line("Invoice date: " + day(inv.invoice_date));
  line("Payment terms: " + inv.payment_terms_days + " days");
  line("Due date: " + day(inv.due_date), 11, bold);
  y -= 10;
  line("Bill to", 9, bold);
  line(inv.customer_name);
  if (inv.customer_address) line(inv.customer_address);
  line(inv.customer_email);
  if (inv.pet_names) line("Pets: " + inv.pet_names);
  y -= 10;
  text("Date", 50, 9, bold); text("Description", 160, 9, bold); text("Amount", 480, 9, bold);
  y -= 16;
  for (const l of inv.lines) {
    text(day(l.date).slice(0, 12) + " " + l.time, 50); text(String(l.description).slice(0, 55), 160); text(gbp(l.amount), 480);
    y -= 16;
    if (y < 120) break;
  }
  y -= 8;
  text("Total: " + gbp(inv.total), 440, 12, bold);
  y -= 30;
  if (inv.payment_details) {
    line("Payment details", 9, bold);
    for (const p of String(inv.payment_details).split("\n").slice(0, 6)) line(p);
  }
  return Buffer.from(await doc.save()).toString("base64");
}

async function sendMail(to: string, subject: string, html: string, pdf: string, filename: string, from: string, idemKey: string) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + Deno.env.get("RESEND_API_KEY"), "Content-Type": "application/json", "Idempotency-Key": idemKey },
    body: JSON.stringify({ from, to: [to], subject, html, attachments: [{ filename, content: pdf }] }),
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
    const { invoice_id } = await req.json();
    const { data: inv } = await userClient.from("invoices").select("*").eq("id", invoice_id).maybeSingle(); // RLS: own invoices only
    if (!inv || inv.status === "cancelled") return json({ error: "Invoice not found." }, 404);

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const from = `${String(inv.business_name).replace(/[<>"]/g, "")} <${Deno.env.get("FROM_ADDRESS")}>`;
    const pdf = await makePdf(inv);
    const filename = inv.invoice_number + ".pdf";

    const deliver = async (kind: "invoice_customer" | "invoice_owner", to: string, subject: string, html: string) => {
      await admin.from("email_log").update({ status: "failed", error: "Timed out" }).eq("invoice_id", inv.id).eq("kind", kind)
        .eq("status", "pending").lt("created_at", new Date(Date.now() - 5 * 60e3).toISOString());
      const { data: prev } = await admin.from("email_log").select("attempt").eq("invoice_id", inv.id).eq("kind", kind).order("attempt", { ascending: false }).limit(1);
      const attempt = (prev?.[0]?.attempt ?? 0) + 1;
      const { data: row, error } = await admin.from("email_log").insert({
        user_id: inv.user_id, kind, invoice_id: inv.id, recipient: to, attempt,
        recipient_type: kind === "invoice_customer" ? "customer" : "business_owner",
      }).select("id").single();
      if (error || !row) return "already"; // unique index: already sent or in progress
      try {
        const id = await sendMail(to, subject, html, pdf, filename, from, `inv-${inv.id}-${kind}-${attempt}`);
        await admin.from("email_log").update({ status: "sent", provider_message_id: id, sent_at: new Date().toISOString() }).eq("id", row.id);
        return "sent";
      } catch (e) {
        console.error("send failed", kind, e);
        await admin.from("email_log").update({ status: "failed", error: String((e as Error).message).slice(0, 300) }).eq("id", row.id);
        return "failed";
      }
    };

    const summary = `<p>Invoice: <b>${esc(inv.invoice_number)}</b><br>Amount: <b>${gbp(inv.total)}</b><br>Due date: <b>${day(inv.due_date)}</b></p>`;
    const customerHtml = `<p>Hello ${esc(inv.customer_name)},</p><p>Please find attached your invoice from ${esc(inv.business_name)}.</p>${summary}<p>Thank you.<br>${esc(inv.business_name)}</p>`;
    const ownerHtml = `<p><b>A copy for your records.</b> This invoice was sent to ${esc(inv.customer_name)}.</p>${summary}<p>The same PDF is attached.</p>`;

    const customer = await deliver("invoice_customer", inv.customer_email, "Invoice " + inv.invoice_number, customerHtml);
    let owner = "skipped";
    if (customer === "sent" || customer === "already") {
      owner = await deliver("invoice_owner", inv.business_email, "Copy: Invoice " + inv.invoice_number + " sent to " + inv.customer_name, ownerHtml);
    }
    if (customer === "sent") await admin.from("invoices").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", inv.id).eq("status", "draft");
    return json({ customer, owner });
  } catch (e) {
    console.error(e);
    return json({ error: "Something went wrong sending the invoice." }, 500);
  }
});
