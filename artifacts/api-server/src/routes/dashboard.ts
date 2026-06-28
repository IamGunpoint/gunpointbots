import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, serversTable, auditLogsTable } from "@workspace/db";
import { eq, sql, desc } from "drizzle-orm";
import { requireAuth } from "../middleware/auth.js";
import { logger } from "../lib/logger.js";
import os from "os";

const router = Router();

function getSystemStats() {
  const cpus = os.cpus();
  const cpuUsage =
    cpus.reduce((acc, cpu) => {
      const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
      const idle = cpu.times.idle;
      return acc + ((total - idle) / total) * 100;
    }, 0) / cpus.length;

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  return {
    cpu: Math.round(cpuUsage * 10) / 10,
    ram: Math.round((usedMem / 1024 / 1024 / 1024) * 100) / 100,
    ramTotal: Math.round((totalMem / 1024 / 1024 / 1024) * 100) / 100,
    disk: 5,
    diskTotal: 20,
    network: Math.round(Math.random() * 50 * 100) / 100,
  };
}

router.get("/stats", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.userId;
    const isAdmin = req.user!.role === "admin";

    const serverQuery = isAdmin
      ? db.select({ status: serversTable.status }).from(serversTable)
      : db
          .select({ status: serversTable.status })
          .from(serversTable)
          .where(eq(serversTable.userId, userId));

    const userServers = await serverQuery;
    const running = userServers.filter((s) => s.status === "running").length;
    const stopped = userServers.filter((s) => s.status !== "running").length;

    const totalUsersResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(usersTable);
    const totalUsers = totalUsersResult[0]?.count ?? 0;

    const sys = getSystemStats();

    res.json({
      totalServers: userServers.length,
      runningServers: running,
      stoppedServers: stopped,
      onlineUsers: Math.max(1, Math.floor(totalUsers * 0.3)),
      totalUsers,
      ...sys,
    });
  } catch (err) {
    logger.error({ err }, "Dashboard stats error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/activity", requireAuth, async (req, res) => {
  try {
    const isAdmin = req.user!.role === "admin";
    const userId = req.user!.userId;

    const rawLogs = await db
      .select({
        id: auditLogsTable.id,
        action: auditLogsTable.action,
        details: auditLogsTable.details,
        userId: auditLogsTable.userId,
        username: usersTable.username,
        createdAt: auditLogsTable.createdAt,
      })
      .from(auditLogsTable)
      .leftJoin(usersTable, eq(auditLogsTable.userId, usersTable.id))
      .orderBy(desc(auditLogsTable.createdAt))
      .limit(20);

    const filtered = isAdmin ? rawLogs : rawLogs.filter((l) => l.userId === userId);

    res.json(
      filtered.map((l) => ({
        id: l.id,
        action: l.action,
        details: l.details ?? null,
        username: l.username ?? "System",
        createdAt: l.createdAt.toISOString(),
      })),
    );
  } catch (err) {
    logger.error({ err }, "Dashboard activity error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
