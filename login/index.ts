// A login page that turns a ChatGPT sign-in into the auth.json the code-review action expects.
// The device flow needs no localhost redirect, so it works for users whose repository runs the review elsewhere.
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH = "https://auth.openai.com";
const REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
const VERIFY_URL = process.env.VERIFY_URL ?? "https://auth.openai.com/codex/device";

type Session = { deviceAuthId: string; userCode: string; expiresAt: number };
const sessions = new Map<string, Session>();

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// The action reads account_id from the id_token claims; ChatGPT auth.json stores it at the top level of tokens.
function accountId(idToken: string): string | null {
  const claims = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString());
  return claims["https://api.openai.com/auth"]?.chatgpt_account_id ?? null;
}

async function start() {
  const r = await fetch(`${AUTH}/api/accounts/deviceauth/usercode`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_id: CLIENT_ID }) });
  if (!r.ok) return json({ error: await r.text() }, r.status);
  const { device_auth_id, user_code, interval, expires_at } = await r.json<{ device_auth_id: string; user_code: string; interval: string; expires_at: string }>();
  const session = crypto.randomUUID();
  sessions.set(session, { deviceAuthId: device_auth_id, userCode: user_code, expiresAt: Date.parse(expires_at) });
  return json({ session, userCode: user_code, interval: Number(interval), verifyUrl: VERIFY_URL });
}

async function poll(req: Request) {
  const { session } = await req.json<{ session: string }>();
  const pending = sessions.get(session);
  if (!pending) return json({ error: "This login expired; start again." }, 404);
  // Until someone approves the code, the token endpoint answers with an error; only then is a code exchanged.
  const r = await fetch(`${AUTH}/api/accounts/deviceauth/token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device_auth_id: pending.deviceAuthId, user_code: pending.userCode }) });
  if (!r.ok) return json({ status: "pending" });
  const { authorization_code, code_verifier } = await r.json<{ authorization_code: string; code_verifier: string }>();
  const form = new URLSearchParams({ grant_type: "authorization_code", code: authorization_code, redirect_uri: REDIRECT_URI, client_id: CLIENT_ID, code_verifier });
  const t = await fetch(`${AUTH}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form });
  if (!t.ok) return json({ error: await t.text() }, t.status);
  const tokens = await t.json<{ id_token: string; access_token: string; refresh_token: string }>();
  sessions.delete(session);
  const auth = { OPENAI_API_KEY: null, tokens: { id_token: tokens.id_token, access_token: tokens.access_token, refresh_token: tokens.refresh_token, account_id: accountId(tokens.id_token) }, last_refresh: new Date().toISOString(), auth_mode: "chatgpt" };
  return json({ status: "ok", auth: JSON.stringify(auth) });
}

Bun.serve({
  port: Number(process.env.PORT ?? 8787),
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (req.method === "GET" && pathname === "/") return new Response(Bun.file(new URL("./page.html", import.meta.url)), { headers: { "content-type": "text/html; charset=utf-8" } });
    if (req.method === "POST" && pathname === "/api/start") return start();
    if (req.method === "POST" && pathname === "/api/poll") return poll(req);
    return new Response("Not found", { status: 404 });
  },
});
