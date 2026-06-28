import { db } from "@workspace/db";
import { serversTable } from "@workspace/db";
import { eq } from "drizzle-orm";

function randomSegment(len: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  for (let i = 0; i < len; i++) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return s;
}

export function generateServerId(): string {
  return `${randomSegment(6)}-${randomSegment(6)}-${randomSegment(3)}`;
}

export async function uniqueServerId(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const id = generateServerId();
    const existing = await db
      .select({ id: serversTable.id })
      .from(serversTable)
      .where(eq(serversTable.serverId, id))
      .limit(1);
    if (existing.length === 0) return id;
  }
  throw new Error("Could not generate unique server ID");
}
