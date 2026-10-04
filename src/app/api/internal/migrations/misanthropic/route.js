import { importMisanthropic } from "@/lib/aiproxy/importMisanthropic.js";
import { requireInternalApi } from "@/lib/auth/internalApi.js";

export async function POST(request) {
  const denied = requireInternalApi(request);
  if (denied) return denied;
  try {
    return Response.json(await importMisanthropic(await request.json()), { status: 201 });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 409 });
  }
}
