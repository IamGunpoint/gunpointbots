import { db } from "@workspace/db";
import { auditLogsTable } from "@workspace/db";
import { Request } from "express";

export async function log(
  action: string,
  options: {
    userId?: number;
    details?: string;
    req?: Request;
  } = {},
) {
  try {
    await db.insert(auditLogsTable).values({
      action,
      userId: options.userId ?? null,
      details: options.details ?? null,
      ipAddress: options.req
        ? (options.req.headers["x-forwarded-for"] as string)?.split(",")[0] ||
          options.req.socket.remoteAddress ||
          null
        : null,
    });
  } catch {
    // non-fatal
  }
}
