import { timingSafeEqual } from "node:crypto";

function bearerToken(request) {
  const authorization = request.headers.get("authorization");
  return authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
}

export function internalApiStatus(request) {
  const expected = process.env.AIPROXY_CONTROL_TOKEN;
  if (!expected) {
    return { ok: false, status: 503, error: "AIPROXY_CONTROL_TOKEN is not configured" };
  }
  const presented = bearerToken(request);
  if (!presented) return { ok: false, status: 401, error: "Control token required" };

  const left = Buffer.from(presented, "utf8");
  const right = Buffer.from(expected, "utf8");
  const valid = left.length === right.length && timingSafeEqual(left, right);
  return valid
    ? { ok: true }
    : { ok: false, status: 401, error: "Invalid control token" };
}

export function requireInternalApi(request) {
  const auth = internalApiStatus(request);
  if (auth.ok) return null;
  return Response.json({ error: auth.error }, { status: auth.status });
}
