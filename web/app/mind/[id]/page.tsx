import { notFound } from "next/navigation";
import { gallery, getMind } from "@/lib/minds";
import MindDetail from "@/components/MindDetail";

export function generateStaticParams() {
  return gallery.map((m) => ({ id: String(m.id) }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const mind = getMind(Number(id));
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
  const mind = getMind(Number(id));
  if (!mind) notFound();
  return <MindDetail mind={mind} />;
}
