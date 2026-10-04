import { setDefaultProviderKey } from "@/lib/localDb";
import { requireInternalApi } from "@/lib/auth/internalApi.js";

export async function PUT(request) {
  const denied = requireInternalApi(request);
  if (denied) return denied;
  try {
    const body = await request.json();
    const defaultKey = await setDefaultProviderKey(body?.key);
    return Response.json({ defaultKey });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }
}
