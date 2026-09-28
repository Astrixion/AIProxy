import {
  createManualAccessToken,
  getAccessTokens,
} from "@/lib/localDb";
import { validateAllowedKeys } from "@/lib/aiproxy/accessControl.js";
import { requireInternalApi } from "@/lib/auth/internalApi.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const denied = requireInternalApi(request);
  if (denied) return denied;
  return Response.json({ tokens: await getAccessTokens() });
}

export async function POST(request) {
  const denied = requireInternalApi(request);
  if (denied) return denied;
  try {
    const body = await request.json();
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name) return Response.json({ error: "name is required" }, { status: 400 });
    const allowedKeys = await validateAllowedKeys(body.allowedKeys);
    const issued = await createManualAccessToken(name, allowedKeys);
    return Response.json({ ...issued.record, token: issued.token }, { status: 201 });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }
}
