import { putProviderKey, removeProviderKey } from "@/lib/aiproxy/providerKeys.js";
import { requireInternalApi } from "@/lib/auth/internalApi.js";

export async function PUT(request, { params }) {
  const denied = requireInternalApi(request);
  if (denied) return denied;
  try {
    const { name } = await params;
    const body = await request.json();
    const key = await putProviderKey(name, body);
    return Response.json(key);
  } catch (error) {
    return Response.json({ error: error.message }, { status: 400 });
  }
}

export async function DELETE(request, { params }) {
  const denied = requireInternalApi(request);
  if (denied) return denied;
  const { name } = await params;
  const removed = await removeProviderKey(name);
  return removed
    ? new Response(null, { status: 204 })
    : Response.json({ error: "Unknown provider key" }, { status: 404 });
}
