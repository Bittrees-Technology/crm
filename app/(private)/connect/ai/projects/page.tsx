import { notFound } from "next/navigation";
import ProjectConnections from "./projects";
export const dynamic = "force-dynamic";
export default function Page() {
  if (process.env.CRM_LEADS_ENABLED !== "true") notFound();
  return <ProjectConnections />;
}
