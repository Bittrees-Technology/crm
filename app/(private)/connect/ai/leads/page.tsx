import { notFound } from "next/navigation";
import Leads from "./leads";
export const dynamic = "force-dynamic";
export default function Page() {
  if (process.env.CRM_LEADS_ENABLED !== "true") notFound();
  return <Leads />;
}
