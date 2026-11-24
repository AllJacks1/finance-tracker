import { audit } from "@/server/audit";
import { clearSessionCookie, loadSession, readSessionToken, revokeSession } from "@/server/auth/session";
import { json, route } from "@/server/http";

export const POST = route(async (req) => {
  const r = await loadSession(readSessionToken(req));
  if (r.ok) {
    await revokeSession(r.session.sessionId);
    await audit({ action: "auth.logout", actorUserId: r.session.user.id, targetUserId: r.session.user.id, req });
  }
  const res = json({ ok: true });
  res.headers.append("Set-Cookie", clearSessionCookie());
  return res;
});
