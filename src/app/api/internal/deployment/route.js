import { requireInternalApi } from "@/lib/auth/internalApi.js";
import { prepareDeployment } from "@/lib/aiproxy/deployment.js";
import { deploymentRuntime } from "open-sse/services/deployment.js";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const denied = requireInternalApi(request, { deployment: true });
  if (denied) return denied;
  const runtime = deploymentRuntime();
  if (!runtime) return Response.json({ error: "Not a managed release" }, { status: 503 });
  return Response.json(runtime.status());
}

export async function POST(request) {
  const denied = requireInternalApi(request, { deployment: true });
  if (denied) return denied;
  const runtime = deploymentRuntime();
  if (!runtime) return Response.json({ error: "Not a managed release" }, { status: 503 });
  try {
    const { action } = await request.json();
    if (action === "ready") await prepareDeployment();
    else if (action === "promote") runtime.promote();
    else if (action === "drain") runtime.drain();
    else if (action === "standby") runtime.standby();
    else return Response.json({ error: "Unknown deployment action" }, { status: 400 });
    return Response.json(runtime.status());
  } catch (error) {
    console.error("[Deployment] Lifecycle action failed:", error.message);
    return Response.json({ error: error.message, ...runtime.status() }, { status: 409 });
  }
}
