import { notFound } from "next/navigation";
import Consent from "./consent";
export const dynamic = "force-dynamic";
export default function Page() {
  if (process.env.AI_CONNECTOR_ENABLED !== "true") notFound();
  return <Consent />;
}
