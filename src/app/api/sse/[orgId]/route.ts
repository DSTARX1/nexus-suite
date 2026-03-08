import { auth } from "@/server/auth/config";
import { subscribeSSE } from "@/server/services/sse-broadcaster";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ orgId: string }> },
) {
  // Auth check — SSE is a protected route
  const session = await auth();
  if (!session?.user?.organizationId) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { orgId } = await params;

  // Verify session org matches requested org
  if (session.user.organizationId !== orgId) {
    return new Response("Forbidden", { status: 403 });
  }

  const { stream, cleanup } = subscribeSSE(orgId);

  // Clean up on client disconnect
  _req.signal.addEventListener("abort", cleanup);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
