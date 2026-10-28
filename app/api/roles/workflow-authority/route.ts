import { nativeWorkflowAuthority } from "@/lib/native-workflow-authority";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) { return nativeWorkflowAuthority(request); }
