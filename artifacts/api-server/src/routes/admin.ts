import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable, serversTable, auditLogsTable, nodesTable } from "@workspace/db";
import { eq, ilike, sql, desc, or } from "drizzle-orm";
import { requireAdmin } from "../middleware/auth.js";
import { log } from "../lib/audit.js";
import { getSettings, updateSettings } from "../lib/settings.js";
import { logger } from "../lib/logger.js";
import bcrypt from "bcryptjs";
import { uniqueServerId } from "../lib/serverid.js";
import { serverLogsTable } from "@workspace/db";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

const router = Router();
const DATA_DIR = path.join(process.cwd(), "data", "bots");

function safeUser(u: typeof usersTable.$inferSelect) {
  return {
    id: u.id,
    username: u.username,
    email: u.email ?? null,
    role: u.role,
    isSuspended: u.isSuspended,
    forcePasswordChange: u.forcePasswordChange,
    avatarUrl: u.avatarUrl ?? null,
    theme: u.theme,
    language: u.language,
    createdAt: u.createdAt.toISOString(),
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
  };
}

function formatServer(s: typeof serversTable.$inferSelect, username?: string) {
  return {
    id: s.id,
    serverId: s.serverId,
    name: s.name,
    runtime: s.runtime,
    startupFile: s.startupFile,
    startupCommand: s.startupCommand,
    envVars: (s.envVars as { key: string; value: string }[]) ?? [],
    status: s.status,
    ramLimitMb: s.ramLimitMb,
    cpuLimit: s.cpuLimit,
    diskLimitGb: s.diskLimitGb,
    userId: s.userId,
    username: username ?? null,
    suspendedAt: s.suspendedAt?.toISOString() ?? null,
    suspendUntil: s.suspendUntil?.toISOString() ?? null,
    suspendReason: s.suspendReason ?? null,
    nodeId: s.nodeId ?? null,
    createdAt: s.createdAt.toISOString(),
  };
}

async function addLog(serverId: number, content: string) {
  await db.insert(serverLogsTable).values({ serverId, content });
}

// ───────────────────────────── USERS ──────────────────────────────

// GET /api/admin/users
router.get("/users", requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt((req.query["page"] as string) || "1"));
    const limit = 20;
    const offset = (page - 1) * limit;
    const search = (req.query["search"] as string) || "";

    const where = search
      ? or(
          ilike(usersTable.username, `%${search}%`),
          sql`COALESCE(${usersTable.email}, '') ILIKE ${"%" + search + "%"}`,
        )
      : undefined;

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(usersTable)
      .where(where);

    const users = await db
      .select()
      .from(usersTable)
      .where(where)
      .orderBy(desc(usersTable.createdAt))
      .limit(limit)
      .offset(offset);

    res.json({
      users: users.map(safeUser),
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    logger.error({ err }, "Admin list users error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/admin/users
router.post("/users", requireAdmin, async (req, res) => {
  try {
    const { username, password, email, role = "member" } = req.body as {
      username: string;
      password: string;
      email?: string;
      role?: string;
    };

    if (!username || !password) {
      res.status(400).json({ error: "username and password are required" });
      return;
    }

    const existing = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.username, username))
      .limit(1);

    if (existing.length > 0) {
      res.status(409).json({ error: "Username already taken" });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const [user] = await db
      .insert(usersTable)
      .values({ username, email: email || null, passwordHash, role })
      .returning();

    await log("admin_create_user", {
      userId: req.user!.userId,
      details: `Created user ${username}`,
      req,
    });

    res.status(201).json(safeUser(user));
  } catch (err) {
    logger.error({ err }, "Admin create user error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /api/admin/users/:id
router.patch("/users/:id", requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params["id"] as string);
    const [existing] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const { username, email, role, isSuspended, forcePasswordChange } = req.body as {
      username?: string;
      email?: string;
      role?: string;
      isSuspended?: boolean;
      forcePasswordChange?: boolean;
    };

    const update: Partial<typeof usersTable.$inferInsert> = {};
    if (username !== undefined) update.username = username;
    if (email !== undefined) update.email = email;
    if (role !== undefined) update.role = role;
    if (isSuspended !== undefined) update.isSuspended = isSuspended;
    if (forcePasswordChange !== undefined) update.forcePasswordChange = forcePasswordChange;

    const [updated] = await db
      .update(usersTable)
      .set(update)
      .where(eq(usersTable.id, userId))
      .returning();

    await log("admin_update_user", {
      userId: req.user!.userId,
      details: `Updated user ${existing.username}`,
      req,
    });

    res.json(safeUser(updated));
  } catch (err) {
    logger.error({ err }, "Admin update user error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/admin/users/:id
router.delete("/users/:id", requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params["id"] as string);

    if (userId === req.user!.userId) {
      res.status(400).json({ error: "Cannot delete your own account" });
      return;
    }

    const [existing] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    await db.delete(usersTable).where(eq(usersTable.id, userId));

    await log("admin_delete_user", {
      userId: req.user!.userId,
      details: `Deleted user ${existing.username}`,
      req,
    });

    res.json({ ok: true, message: "User deleted" });
  } catch (err) {
    logger.error({ err }, "Admin delete user error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/admin/users/:id/reset-password
router.post("/users/:id/reset-password", requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params["id"] as string);
    const { newPassword } = req.body as { newPassword: string };

    if (!newPassword || newPassword.length < 8) {
      res.status(400).json({ error: "newPassword must be at least 8 characters" });
      return;
    }

    const [existing] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    if (!existing) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await db
      .update(usersTable)
      .set({ passwordHash, forcePasswordChange: true })
      .where(eq(usersTable.id, userId));

    await log("admin_reset_password", {
      userId: req.user!.userId,
      details: `Reset password for user ${existing.username}`,
      req,
    });

    res.json({ ok: true, message: "Password reset. User will be forced to change it on next login." });
  } catch (err) {
    logger.error({ err }, "Admin reset password error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ───────────────────────────── SERVERS ──────────────────────────────

// GET /api/admin/servers
router.get("/servers", requireAdmin, async (req, res) => {
  try {
    const rows = await db
      .select({
        server: serversTable,
        username: usersTable.username,
      })
      .from(serversTable)
      .leftJoin(usersTable, eq(serversTable.userId, usersTable.id))
      .orderBy(desc(serversTable.createdAt));

    res.json(rows.map((r) => formatServer(r.server, r.username ?? undefined)));
  } catch (err) {
    logger.error({ err }, "Admin list servers error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/admin/users/:userId/servers — create a custom server for a specific user
router.post("/users/:userId/servers", requireAdmin, async (req, res) => {
  try {
    const targetUserId = parseInt(req.params["userId"] as string);

    const [targetUser] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, targetUserId))
      .limit(1);

    if (!targetUser) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const {
      name,
      runtime = "nodejs",
      startupFile = "index.js",
      startupCommand = "",
      envVars = [],
      ramLimitMb,
      cpuLimit,
      diskLimitGb,
      nodeId,
    } = req.body as {
      name: string;
      runtime?: string;
      startupFile?: string;
      startupCommand?: string;
      envVars?: { key: string; value: string }[];
      ramLimitMb?: number;
      cpuLimit?: number;
      diskLimitGb?: number;
      nodeId?: number;
    };

    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }

    if (!["nodejs", "python"].includes(runtime)) {
      res.status(400).json({ error: "runtime must be nodejs or python" });
      return;
    }

    const settings = await getSettings();
    const serverId = await uniqueServerId();
    const filesDir = path.join(DATA_DIR, serverId, "files");
    fs.mkdirSync(filesDir, { recursive: true });

    const [server] = await db
      .insert(serversTable)
      .values({
        serverId,
        userId: targetUserId,
        name,
        runtime,
        startupFile,
        startupCommand,
        envVars,
        status: "stopped",
        ramLimitMb: ramLimitMb ?? settings.freeRamMb,
        cpuLimit: cpuLimit ?? settings.freeCpu,
        diskLimitGb: diskLimitGb ?? settings.freeDiskGb,
        nodeId: nodeId ?? null,
      })
      .returning();

    await addLog(server.id, `[System] Server "${name}" created by admin for user ${targetUser.username}`);
    await log("admin_create_server", {
      userId: req.user!.userId,
      details: `Created server ${serverId} for user ${targetUser.username}`,
      req,
    });

    res.status(201).json(formatServer(server, targetUser.username));
  } catch (err) {
    logger.error({ err }, "Admin create server error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /api/admin/servers/:serverId/specs — update specs (ram/cpu/disk/node)
router.patch("/servers/:serverId/specs", requireAdmin, async (req, res) => {
  try {
    const [existing] = await db
      .select()
      .from(serversTable)
      .where(eq(serversTable.serverId, req.params["serverId"] as string))
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    const { ramLimitMb, cpuLimit, diskLimitGb, nodeId } = req.body as {
      ramLimitMb?: number;
      cpuLimit?: number;
      diskLimitGb?: number;
      nodeId?: number | null;
    };

    const update: Partial<typeof serversTable.$inferInsert> = {};
    if (ramLimitMb !== undefined) update.ramLimitMb = ramLimitMb;
    if (cpuLimit !== undefined) update.cpuLimit = cpuLimit;
    if (diskLimitGb !== undefined) update.diskLimitGb = diskLimitGb;
    if (nodeId !== undefined) update.nodeId = nodeId;

    const [updated] = await db
      .update(serversTable)
      .set(update)
      .where(eq(serversTable.id, existing.id))
      .returning();

    await addLog(existing.id, `[System] Specs updated by admin: RAM=${updated.ramLimitMb}MB CPU=${updated.cpuLimit} Disk=${updated.diskLimitGb}GB`);
    await log("admin_update_specs", {
      userId: req.user!.userId,
      details: `Updated specs for server ${existing.serverId}`,
      req,
    });

    res.json(formatServer(updated));
  } catch (err) {
    logger.error({ err }, "Admin update specs error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/admin/servers/:serverId/suspend
router.post("/servers/:serverId/suspend", requireAdmin, async (req, res) => {
  try {
    const [server] = await db
      .select()
      .from(serversTable)
      .where(eq(serversTable.serverId, req.params["serverId"] as string))
      .limit(1);

    if (!server) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    const { reason, durationMinutes } = req.body as { reason?: string; durationMinutes?: number };
    const suspendUntil = durationMinutes
      ? new Date(Date.now() + durationMinutes * 60 * 1000)
      : null;

    await db
      .update(serversTable)
      .set({
        status: "suspended",
        suspendedAt: new Date(),
        suspendUntil,
        suspendReason: reason ?? "Suspended by admin",
      })
      .where(eq(serversTable.id, server.id));

    await addLog(server.id, `[System] Server suspended by admin. Reason: ${reason ?? "No reason given"}`);
    await log("admin_suspend_server", {
      userId: req.user!.userId,
      details: `Suspended server ${server.serverId}`,
      req,
    });

    res.json({ ok: true, message: "Server suspended" });
  } catch (err) {
    logger.error({ err }, "Admin suspend server error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/admin/servers/:serverId/unsuspend
router.post("/servers/:serverId/unsuspend", requireAdmin, async (req, res) => {
  try {
    const [server] = await db
      .select()
      .from(serversTable)
      .where(eq(serversTable.serverId, req.params["serverId"] as string))
      .limit(1);

    if (!server) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    await db
      .update(serversTable)
      .set({ status: "stopped", suspendedAt: null, suspendUntil: null, suspendReason: null })
      .where(eq(serversTable.id, server.id));

    await addLog(server.id, "[System] Server unsuspended by admin.");
    await log("admin_unsuspend_server", {
      userId: req.user!.userId,
      details: `Unsuspended server ${server.serverId}`,
      req,
    });

    res.json({ ok: true, message: "Server unsuspended" });
  } catch (err) {
    logger.error({ err }, "Admin unsuspend server error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/admin/servers/:serverId — admin force-delete
router.delete("/servers/:serverId", requireAdmin, async (req, res) => {
  try {
    const [server] = await db
      .select()
      .from(serversTable)
      .where(eq(serversTable.serverId, req.params["serverId"] as string))
      .limit(1);

    if (!server) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    const serverDir = path.join(DATA_DIR, server.serverId);
    if (fs.existsSync(serverDir)) {
      fs.rmSync(serverDir, { recursive: true, force: true });
    }

    await db.delete(serversTable).where(eq(serversTable.id, server.id));

    await log("admin_delete_server", {
      userId: req.user!.userId,
      details: `Force-deleted server ${server.serverId} (${server.name})`,
      req,
    });

    res.json({ ok: true, message: "Server deleted" });
  } catch (err) {
    logger.error({ err }, "Admin delete server error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ───────────────────────────── SETTINGS ──────────────────────────────

// GET /api/admin/settings
router.get("/settings", requireAdmin, async (req, res) => {
  try {
    const settings = await getSettings();
    res.json(settings);
  } catch (err) {
    logger.error({ err }, "Get settings error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /api/admin/settings
router.put("/settings", requireAdmin, async (req, res) => {
  try {
    const updated = await updateSettings(req.body);

    await log("admin_update_settings", {
      userId: req.user!.userId,
      req,
    });

    res.json(updated);
  } catch (err) {
    logger.error({ err }, "Update settings error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ───────────────────────────── AUDIT LOGS ──────────────────────────────

// GET /api/admin/logs
router.get("/logs", requireAdmin, async (req, res) => {
  try {
    const page = Math.max(1, parseInt((req.query["page"] as string) || "1"));
    const limit = Math.min(100, parseInt((req.query["limit"] as string) || "50"));
    const offset = (page - 1) * limit;

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(auditLogsTable);

    const logs = await db
      .select({
        id: auditLogsTable.id,
        action: auditLogsTable.action,
        details: auditLogsTable.details,
        ipAddress: auditLogsTable.ipAddress,
        createdAt: auditLogsTable.createdAt,
        username: usersTable.username,
      })
      .from(auditLogsTable)
      .leftJoin(usersTable, eq(auditLogsTable.userId, usersTable.id))
      .orderBy(desc(auditLogsTable.createdAt))
      .limit(limit)
      .offset(offset);

    res.json({
      logs: logs.map((l) => ({
        id: l.id,
        action: l.action,
        details: l.details ?? null,
        username: l.username ?? "System",
        ipAddress: l.ipAddress ?? null,
        createdAt: l.createdAt.toISOString(),
      })),
      total,
      page,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    logger.error({ err }, "Audit logs error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ───────────────────────────── MACHINE LOGS ──────────────────────────────

// GET /api/admin/machine-logs — real-time system journal/log tail
router.get("/machine-logs", requireAdmin, async (req, res) => {
  try {
    const lines = Math.min(500, parseInt((req.query["lines"] as string) || "100"));
    const source = (req.query["source"] as string) || "system";

    let output = "";

    if (source === "system") {
      // Try journalctl, fall back to /var/log/syslog or dmesg
      try {
        output = execSync(`journalctl -n ${lines} --no-pager 2>/dev/null || dmesg | tail -${lines}`, {
          encoding: "utf8",
          timeout: 5000,
        });
      } catch {
        try {
          output = execSync(`tail -${lines} /var/log/syslog 2>/dev/null || tail -${lines} /var/log/messages 2>/dev/null || dmesg | tail -${lines}`, {
            encoding: "utf8",
            timeout: 5000,
          });
        } catch {
          output = "No system logs available in this environment.";
        }
      }
    } else if (source === "process") {
      // List running processes sorted by CPU
      try {
        output = execSync("ps aux --sort=-%cpu | head -30", { encoding: "utf8", timeout: 5000 });
      } catch {
        output = "ps not available.";
      }
    } else if (source === "proot") {
      // Show all proot processes
      try {
        output = execSync("pgrep -a proot 2>/dev/null || echo 'No proot processes running'", {
          encoding: "utf8",
          timeout: 5000,
        });
      } catch {
        output = "No proot processes found.";
      }
    }

    const logLines = output
      .split("\n")
      .filter(Boolean)
      .map((line, i) => ({ id: i + 1, content: line, createdAt: new Date().toISOString() }));

    res.json({ source, lines: logLines });
  } catch (err) {
    logger.error({ err }, "Machine logs error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/admin/machine-stats — host machine resource usage
router.get("/machine-stats", requireAdmin, async (req, res) => {
  try {
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

    let diskInfo = { used: 0, total: 0, free: 0 };
    try {
      const dfOut = execSync("df -BG / 2>/dev/null | tail -1", { encoding: "utf8", timeout: 3000 });
      const parts = dfOut.trim().split(/\s+/);
      diskInfo = {
        total: parseInt(parts[1] ?? "0"),
        used: parseInt(parts[2] ?? "0"),
        free: parseInt(parts[3] ?? "0"),
      };
    } catch {
      // fallback
    }

    let proots = 0;
    try {
      const proot = execSync("pgrep proot 2>/dev/null | wc -l", { encoding: "utf8", timeout: 2000 });
      proots = parseInt(proot.trim()) || 0;
    } catch {
      // ignore
    }

    res.json({
      cpu: Math.round(cpuUsage * 10) / 10,
      cpuCores: cpus.length,
      ramUsedGb: Math.round((usedMem / 1024 / 1024 / 1024) * 100) / 100,
      ramTotalGb: Math.round((totalMem / 1024 / 1024 / 1024) * 100) / 100,
      diskUsedGb: diskInfo.used,
      diskTotalGb: diskInfo.total,
      diskFreeGb: diskInfo.free,
      platform: os.platform(),
      arch: os.arch(),
      hostname: os.hostname(),
      uptime: os.uptime(),
      prootProcesses: proots,
    });
  } catch (err) {
    logger.error({ err }, "Machine stats error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/admin/kill-all-proot — kill all proot processes on the host
router.post("/kill-all-proot", requireAdmin, async (req, res) => {
  try {
    let killed = 0;
    try {
      const pids = execSync("pgrep proot 2>/dev/null || true", { encoding: "utf8" });
      const pidList = pids.trim().split("\n").filter(Boolean);
      for (const pid of pidList) {
        try {
          execSync(`kill -9 ${pid}`, { stdio: "ignore" });
          killed++;
        } catch {
          // already gone
        }
      }
    } catch {
      // no proot
    }

    await log("admin_kill_all_proot", {
      userId: req.user!.userId,
      details: `Killed ${killed} proot processes`,
      req,
    });

    res.json({ ok: true, message: `Killed ${killed} proot process(es)` });
  } catch (err) {
    logger.error({ err }, "Kill all proot error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ───────────────────────────── NODES ──────────────────────────────

// GET /api/admin/nodes
router.get("/nodes", requireAdmin, async (req, res) => {
  try {
    const nodes = await db.select().from(nodesTable).orderBy(desc(nodesTable.createdAt));

    // For each node count servers
    const serverCounts = await db
      .select({ nodeId: serversTable.nodeId, count: sql<number>`count(*)::int` })
      .from(serversTable)
      .groupBy(serversTable.nodeId);

    const countMap: Record<number, number> = {};
    for (const r of serverCounts) {
      if (r.nodeId) countMap[r.nodeId] = r.count;
    }

    res.json(
      nodes.map((n) => ({
        id: n.id,
        name: n.name,
        host: n.host,
        port: n.port,
        sshUser: n.sshUser,
        isOnline: n.isOnline,
        isDefault: n.isDefault,
        ramTotalGb: n.ramTotalGb,
        cpuCores: n.cpuCores,
        diskTotalGb: n.diskTotalGb,
        location: n.location ?? null,
        notes: n.notes ?? null,
        serverCount: countMap[n.id] ?? 0,
        lastPingedAt: n.lastPingedAt?.toISOString() ?? null,
        createdAt: n.createdAt.toISOString(),
      })),
    );
  } catch (err) {
    logger.error({ err }, "List nodes error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/admin/nodes
router.post("/nodes", requireAdmin, async (req, res) => {
  try {
    const {
      name,
      host,
      port = 22,
      sshUser = "root",
      sshKey,
      ramTotalGb = 0,
      cpuCores = 0,
      diskTotalGb = 0,
      location,
      notes,
      isDefault = false,
    } = req.body as {
      name: string;
      host: string;
      port?: number;
      sshUser?: string;
      sshKey?: string;
      ramTotalGb?: number;
      cpuCores?: number;
      diskTotalGb?: number;
      location?: string;
      notes?: string;
      isDefault?: boolean;
    };

    if (!name || !host) {
      res.status(400).json({ error: "name and host are required" });
      return;
    }

    // If this is the default, unset any existing default
    if (isDefault) {
      await db.update(nodesTable).set({ isDefault: false });
    }

    const [node] = await db
      .insert(nodesTable)
      .values({
        name,
        host,
        port,
        sshUser,
        sshKey: sshKey || null,
        ramTotalGb,
        cpuCores,
        diskTotalGb,
        location: location || null,
        notes: notes || null,
        isDefault,
        isOnline: false,
      })
      .returning();

    await log("admin_create_node", {
      userId: req.user!.userId,
      details: `Created node ${name} (${host})`,
      req,
    });

    res.status(201).json({
      id: node.id,
      name: node.name,
      host: node.host,
      port: node.port,
      sshUser: node.sshUser,
      isOnline: node.isOnline,
      isDefault: node.isDefault,
      ramTotalGb: node.ramTotalGb,
      cpuCores: node.cpuCores,
      diskTotalGb: node.diskTotalGb,
      location: node.location ?? null,
      notes: node.notes ?? null,
      serverCount: 0,
      lastPingedAt: null,
      createdAt: node.createdAt.toISOString(),
    });
  } catch (err) {
    logger.error({ err }, "Create node error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /api/admin/nodes/:id
router.patch("/nodes/:id", requireAdmin, async (req, res) => {
  try {
    const nodeId = parseInt(req.params["id"] as string);
    const [existing] = await db.select().from(nodesTable).where(eq(nodesTable.id, nodeId)).limit(1);

    if (!existing) {
      res.status(404).json({ error: "Node not found" });
      return;
    }

    const { name, host, port, sshUser, sshKey, ramTotalGb, cpuCores, diskTotalGb, location, notes, isDefault, isOnline } = req.body as Partial<typeof nodesTable.$inferInsert>;

    const update: Partial<typeof nodesTable.$inferInsert> = {};
    if (name !== undefined) update.name = name;
    if (host !== undefined) update.host = host;
    if (port !== undefined) update.port = port;
    if (sshUser !== undefined) update.sshUser = sshUser;
    if (sshKey !== undefined) update.sshKey = sshKey;
    if (ramTotalGb !== undefined) update.ramTotalGb = ramTotalGb;
    if (cpuCores !== undefined) update.cpuCores = cpuCores;
    if (diskTotalGb !== undefined) update.diskTotalGb = diskTotalGb;
    if (location !== undefined) update.location = location;
    if (notes !== undefined) update.notes = notes;
    if (isOnline !== undefined) update.isOnline = isOnline;
    if (isDefault !== undefined) {
      if (isDefault) await db.update(nodesTable).set({ isDefault: false });
      update.isDefault = isDefault;
    }

    const [updated] = await db.update(nodesTable).set(update).where(eq(nodesTable.id, nodeId)).returning();

    await log("admin_update_node", {
      userId: req.user!.userId,
      details: `Updated node ${existing.name}`,
      req,
    });

    res.json({ id: updated.id, name: updated.name, host: updated.host, port: updated.port, isOnline: updated.isOnline, isDefault: updated.isDefault, location: updated.location ?? null });
  } catch (err) {
    logger.error({ err }, "Update node error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/admin/nodes/:id
router.delete("/nodes/:id", requireAdmin, async (req, res) => {
  try {
    const nodeId = parseInt(req.params["id"] as string);
    const [existing] = await db.select().from(nodesTable).where(eq(nodesTable.id, nodeId)).limit(1);

    if (!existing) {
      res.status(404).json({ error: "Node not found" });
      return;
    }

    // Move servers off this node first (set nodeId = null)
    await db.update(serversTable).set({ nodeId: null }).where(eq(serversTable.nodeId, nodeId));
    await db.delete(nodesTable).where(eq(nodesTable.id, nodeId));

    await log("admin_delete_node", {
      userId: req.user!.userId,
      details: `Deleted node ${existing.name} (${existing.host})`,
      req,
    });

    res.json({ ok: true, message: "Node deleted" });
  } catch (err) {
    logger.error({ err }, "Delete node error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/admin/nodes/:id/ping — check if node is reachable
router.post("/nodes/:id/ping", requireAdmin, async (req, res) => {
  try {
    const nodeId = parseInt(req.params["id"] as string);
    const [node] = await db.select().from(nodesTable).where(eq(nodesTable.id, nodeId)).limit(1);

    if (!node) {
      res.status(404).json({ error: "Node not found" });
      return;
    }

    let isOnline = false;
    let latencyMs: number | null = null;

    try {
      const start = Date.now();
      execSync(`ping -c 1 -W 3 ${node.host} 2>/dev/null`, { timeout: 5000, stdio: "ignore" });
      latencyMs = Date.now() - start;
      isOnline = true;
    } catch {
      isOnline = false;
    }

    await db
      .update(nodesTable)
      .set({ isOnline, lastPingedAt: new Date() })
      .where(eq(nodesTable.id, nodeId));

    res.json({ ok: true, isOnline, latencyMs });
  } catch (err) {
    logger.error({ err }, "Ping node error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
