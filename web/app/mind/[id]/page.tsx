import { notFound } from "next/navigation";
import { loadMind } from "@/lib/live";
import MindDetail from "@/components/MindDetail";

// Live mode resolves each id against the chain per request; preview resolves samples.
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { mind } = await loadMind(Number(id));
  return {
    title: mind ? `${mind.name} — a Hungry Mind` : "Hungry Minds",
  };
}

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { mind, live } = await loadMind(Number(id));
  if (!mind) notFound();
  return <MindDetail mind={mind} live={live} />;
}
