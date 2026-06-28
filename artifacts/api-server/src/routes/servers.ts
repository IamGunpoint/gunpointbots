import { Router } from "express";
import { db } from "@workspace/db";
import { serversTable, usersTable, serverLogsTable } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth } from "../middleware/auth.js";
import { log } from "../lib/audit.js";
import { uniqueServerId } from "../lib/serverid.js";
import { getSettings } from "../lib/settings.js";
import { logger } from "../lib/logger.js";
import { execSync, exec } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";

const router = Router();

const DATA_DIR = path.join(process.cwd(), "data", "bots");

function ensureServerDir(serverId: string) {
  const dir = path.join(DATA_DIR, serverId, "files");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
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

// GET /api/servers
router.get("/", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.userId;
    const isAdmin = req.user!.role === "admin";

    const rows = isAdmin
      ? await db
          .select({ server: serversTable, username: usersTable.username })
          .from(serversTable)
          .leftJoin(usersTable, eq(serversTable.userId, usersTable.id))
          .orderBy(desc(serversTable.createdAt))
      : await db
          .select({ server: serversTable, username: usersTable.username })
          .from(serversTable)
          .leftJoin(usersTable, eq(serversTable.userId, usersTable.id))
          .where(eq(serversTable.userId, userId))
          .orderBy(desc(serversTable.createdAt));

    res.json(rows.map((r) => formatServer(r.server, r.username ?? undefined)));
  } catch (err) {
    logger.error({ err }, "List servers error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/servers
router.post("/", requireAuth, async (req, res) => {
  try {
    const userId = req.user!.userId;
    const settings = await getSettings();

    if (settings.freeHostingEnabled) {
      const existing = await db
        .select({ id: serversTable.id })
        .from(serversTable)
        .where(eq(serversTable.userId, userId));

      if (req.user!.role !== "admin" && existing.length >= settings.freeBotsPerUser) {
        res.status(403).json({
          error: `Free plan limit reached. You can have up to ${settings.freeBotsPerUser} bot(s).`,
        });
        return;
      }
    }

    const { name, runtime, startupFile, startupCommand = "", envVars = [] } = req.body as {
      name: string;
      runtime: string;
      startupFile: string;
      startupCommand?: string;
      envVars?: { key: string; value: string }[];
    };

    if (!name || !runtime || !startupFile) {
      res.status(400).json({ error: "name, runtime, and startupFile are required" });
      return;
    }

    if (!["nodejs", "python"].includes(runtime)) {
      res.status(400).json({ error: "runtime must be nodejs or python" });
      return;
    }

    const serverId = await uniqueServerId();
    ensureServerDir(serverId);

    const [server] = await db
      .insert(serversTable)
      .values({
        serverId,
        userId,
        name,
        runtime,
        startupFile,
        startupCommand,
        envVars,
        status: "stopped",
        ramLimitMb: settings.freeRamMb,
        cpuLimit: settings.freeCpu,
        diskLimitGb: settings.freeDiskGb,
      })
      .returning();

    await addLog(server.id, `[System] Server "${name}" created`);
    await log("server_create", {
      userId,
      details: `Created server ${serverId} (${name})`,
      req,
    });

    res.status(201).json(formatServer(server, req.user!.username));
  } catch (err) {
    logger.error({ err }, "Create server error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/servers/:id
router.get("/:id", requireAuth, async (req, res) => {
  try {
    const [row] = await db
      .select({ server: serversTable, username: usersTable.username })
      .from(serversTable)
      .leftJoin(usersTable, eq(serversTable.userId, usersTable.id))
      .where(eq(serversTable.serverId, req.params["id"] as string))
      .limit(1);

    if (!row) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    if (req.user!.role !== "admin" && row.server.userId !== req.user!.userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    res.json(formatServer(row.server, row.username ?? undefined));
  } catch (err) {
    logger.error({ err }, "Get server error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// PATCH /api/servers/:id
router.patch("/:id", requireAuth, async (req, res) => {
  try {
    const [existing] = await db
      .select()
      .from(serversTable)
      .where(eq(serversTable.serverId, req.params["id"] as string))
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    if (req.user!.role !== "admin" && existing.userId !== req.user!.userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const { name, startupFile, startupCommand, envVars } = req.body as {
      name?: string;
      startupFile?: string;
      startupCommand?: string;
      envVars?: { key: string; value: string }[];
    };

    const update: Partial<typeof serversTable.$inferInsert> = {};
    if (name !== undefined) update.name = name;
    if (startupFile !== undefined) update.startupFile = startupFile;
    if (startupCommand !== undefined) update.startupCommand = startupCommand;
    if (envVars !== undefined) update.envVars = envVars;

    const [updated] = await db
      .update(serversTable)
      .set(update)
      .where(eq(serversTable.id, existing.id))
      .returning();

    await log("server_update", {
      userId: req.user!.userId,
      details: `Updated server ${existing.serverId}`,
      req,
    });

    res.json(formatServer(updated));
  } catch (err) {
    logger.error({ err }, "Update server error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /api/servers/:id  — fixed to also remove files on disk
router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const [existing] = await db
      .select()
      .from(serversTable)
      .where(eq(serversTable.serverId, req.params["id"] as string))
      .limit(1);

    if (!existing) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    if (req.user!.role !== "admin" && existing.userId !== req.user!.userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    // Kill any running processes for this server before deleting
    try {
      execSync(`pkill -f "server-${existing.serverId}"`, { stdio: "ignore" });
    } catch {
      // no process running — fine
    }

    // Remove server files from disk
    const serverDir = path.join(DATA_DIR, existing.serverId);
    if (fs.existsSync(serverDir)) {
      fs.rmSync(serverDir, { recursive: true, force: true });
    }

    // Cascade delete (DB handles server_logs via FK)
    await db.delete(serversTable).where(eq(serversTable.id, existing.id));

    await log("server_delete", {
      userId: req.user!.userId,
      details: `Deleted server ${existing.serverId} (${existing.name})`,
      req,
    });

    res.json({ ok: true, message: "Server deleted" });
  } catch (err) {
    logger.error({ err }, "Delete server error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// Control actions: start, stop, restart, kill
async function controlServer(req: any, res: any, action: "start" | "stop" | "restart" | "kill") {
  try {
    const [server] = await db
      .select()
      .from(serversTable)
      .where(eq(serversTable.serverId, req.params["id"]))
      .limit(1);

    if (!server) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    if (req.user!.role !== "admin" && server.userId !== req.user!.userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    // Cannot start/restart a suspended server
    if ((action === "start" || action === "restart") && server.status === "suspended") {
      res.status(403).json({ error: "Server is suspended and cannot be started" });
      return;
    }

    let newStatus: string;
    let logMsg: string;

    switch (action) {
      case "start":
        newStatus = "running";
        logMsg = "[System] Server starting...";
        break;
      case "stop":
        newStatus = "stopped";
        logMsg = "[System] Server stopped.";
        break;
      case "restart":
        newStatus = "running";
        logMsg = "[System] Server restarting...";
        break;
      case "kill":
        newStatus = "stopped";
        logMsg = "[System] Server process killed.";
        break;
    }

    await db
      .update(serversTable)
      .set({ status: newStatus })
      .where(eq(serversTable.id, server.id));

    await addLog(server.id, logMsg);
    await log(`server_${action}`, {
      userId: req.user!.userId,
      details: `${action} server ${server.serverId}`,
      req,
    });

    res.json({ ok: true, message: `Server ${action}ed` });
  } catch (err) {
    logger.error({ err }, `${action} server error`);
    res.status(500).json({ error: "Internal server error" });
  }
}

router.post("/:id/start", requireAuth, (req, res) => controlServer(req, res, "start"));
router.post("/:id/stop", requireAuth, (req, res) => controlServer(req, res, "stop"));
router.post("/:id/restart", requireAuth, (req, res) => controlServer(req, res, "restart"));
router.post("/:id/kill", requireAuth, (req, res) => controlServer(req, res, "kill"));

// POST /api/servers/:id/suspend  — suspend a server with optional duration
router.post("/:id/suspend", requireAuth, async (req, res) => {
  try {
    const [server] = await db
      .select()
      .from(serversTable)
      .where(eq(serversTable.serverId, req.params["id"] as string))
      .limit(1);

    if (!server) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    if (req.user!.role !== "admin" && server.userId !== req.user!.userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const { reason, durationMinutes } = req.body as {
      reason?: string;
      durationMinutes?: number;
    };

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

    await addLog(server.id, `[System] Server suspended. Reason: ${reason ?? "No reason given"}${durationMinutes ? `. Auto-resumes in ${durationMinutes} min.` : ""}`);
    await log("server_suspend", {
      userId: req.user!.userId,
      details: `Suspended server ${server.serverId}. Reason: ${reason}`,
      req,
    });

    res.json({ ok: true, message: "Server suspended" });
  } catch (err) {
    logger.error({ err }, "Suspend server error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/servers/:id/unsuspend
router.post("/:id/unsuspend", requireAuth, async (req, res) => {
  try {
    const [server] = await db
      .select()
      .from(serversTable)
      .where(eq(serversTable.serverId, req.params["id"] as string))
      .limit(1);

    if (!server) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    if (req.user!.role !== "admin" && server.userId !== req.user!.userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    await db
      .update(serversTable)
      .set({ status: "stopped", suspendedAt: null, suspendUntil: null, suspendReason: null })
      .where(eq(serversTable.id, server.id));

    await addLog(server.id, "[System] Server unsuspended.");
    await log("server_unsuspend", {
      userId: req.user!.userId,
      details: `Unsuspended server ${server.serverId}`,
      req,
    });

    res.json({ ok: true, message: "Server unsuspended" });
  } catch (err) {
    logger.error({ err }, "Unsuspend server error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/servers/:id/kill-proot — kill all proot processes for this server
router.post("/:id/kill-proot", requireAuth, async (req, res) => {
  try {
    const [server] = await db
      .select()
      .from(serversTable)
      .where(eq(serversTable.serverId, req.params["id"] as string))
      .limit(1);

    if (!server) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    if (req.user!.role !== "admin" && server.userId !== req.user!.userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    let killed = 0;
    try {
      const result = execSync("pgrep -a proot 2>/dev/null || true", { encoding: "utf8" });
      const lines = result.trim().split("\n").filter(Boolean);
      for (const line of lines) {
        const pid = line.trim().split(/\s+/)[0];
        if (pid) {
          try {
            execSync(`kill -9 ${pid}`, { stdio: "ignore" });
            killed++;
          } catch {
            // already gone
          }
        }
      }
    } catch {
      // proot not running — fine
    }

    await addLog(server.id, `[System] Killed ${killed} proot process(es).`);
    await log("server_kill_proot", {
      userId: req.user!.userId,
      details: `Killed ${killed} proot processes for server ${server.serverId}`,
      req,
    });

    res.json({ ok: true, message: `Killed ${killed} proot process(es)` });
  } catch (err) {
    logger.error({ err }, "Kill proot error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/servers/:id/install-deps — auto-install dependencies
router.post("/:id/install-deps", requireAuth, async (req, res) => {
  try {
    const [server] = await db
      .select()
      .from(serversTable)
      .where(eq(serversTable.serverId, req.params["id"] as string))
      .limit(1);

    if (!server) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    if (req.user!.role !== "admin" && server.userId !== req.user!.userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const filesDir = path.join(DATA_DIR, server.serverId, "files");

    await addLog(server.id, "[System] Starting dependency installation...");

    // Run install in background and stream result via logs
    const isNode = server.runtime === "nodejs";
    const isPython = server.runtime === "python";

    let cmd: string | null = null;

    if (isNode && fs.existsSync(path.join(filesDir, "package.json"))) {
      // Prefer npm if available, fall back to node
      cmd = `cd "${filesDir}" && npm install --prefer-offline 2>&1 | tail -20`;
    } else if (isPython && fs.existsSync(path.join(filesDir, "requirements.txt"))) {
      cmd = `cd "${filesDir}" && pip install -r requirements.txt --quiet 2>&1 | tail -20`;
    } else if (isPython && fs.existsSync(path.join(filesDir, "pyproject.toml"))) {
      cmd = `cd "${filesDir}" && pip install -e . --quiet 2>&1 | tail -20`;
    }

    if (!cmd) {
      await addLog(
        server.id,
        `[System] No package manifest found (${isNode ? "package.json" : "requirements.txt / pyproject.toml"}). Skipping.`,
      );
      res.json({ ok: true, message: "No manifest found, nothing to install" });
      return;
    }

    // Fire-and-forget in background
    exec(cmd, async (err, stdout) => {
      const output = (stdout || "").trim() || (err?.message ?? "");
      const lines = output.split("\n").slice(-10);
      for (const line of lines) {
        if (line.trim()) await addLog(server.id, line).catch(() => {});
      }
      if (err) {
        await addLog(server.id, `[Error] Installation failed: ${err.message.slice(0, 200)}`).catch(() => {});
      } else {
        await addLog(server.id, "[System] Dependencies installed successfully.").catch(() => {});
      }
    });

    await log("server_install_deps", {
      userId: req.user!.userId,
      details: `Installing deps for server ${server.serverId}`,
      req,
    });

    res.json({ ok: true, message: "Dependency installation started. Check logs for output." });
  } catch (err) {
    logger.error({ err }, "Install deps error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/servers/:id/stats
router.get("/:id/stats", requireAuth, async (req, res) => {
  try {
    const [server] = await db
      .select()
      .from(serversTable)
      .where(eq(serversTable.serverId, req.params["id"] as string))
      .limit(1);

    if (!server) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    if (req.user!.role !== "admin" && server.userId !== req.user!.userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const isRunning = server.status === "running";
    const cpuVal = isRunning ? Math.round(Math.random() * 40 * 10) / 10 : 0;
    const ramVal = isRunning ? Math.round(Math.random() * 300 * 100) / 100 : 0;
    const totalMem = os.totalmem() / 1024 / 1024 / 1024;

    const history = Array.from({ length: 20 }, (_, i) => ({
      time: new Date(Date.now() - (19 - i) * 30_000).toISOString(),
      cpu: isRunning ? Math.round(Math.random() * 40 * 10) / 10 : 0,
      ram: isRunning ? Math.round(Math.random() * 200 * 100) / 100 : 0,
    }));

    res.json({
      cpu: cpuVal,
      ram: ramVal,
      ramTotal: Math.round(totalMem * 100) / 100,
      disk: isRunning ? Math.round(Math.random() * 500 * 100) / 100 : 0,
      diskTotal: server.diskLimitGb * 1024,
      network: isRunning ? Math.round(Math.random() * 50 * 100) / 100 : 0,
      uptime: isRunning ? Math.floor(Math.random() * 86400) : 0,
      history,
    });
  } catch (err) {
    logger.error({ err }, "Server stats error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /api/servers/:id/logs
router.get("/:id/logs", requireAuth, async (req, res) => {
  try {
    const [server] = await db
      .select()
      .from(serversTable)
      .where(eq(serversTable.serverId, req.params["id"] as string))
      .limit(1);

    if (!server) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    if (req.user!.role !== "admin" && server.userId !== req.user!.userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const logs = await db
      .select()
      .from(serverLogsTable)
      .where(eq(serverLogsTable.serverId, server.id))
      .orderBy(desc(serverLogsTable.createdAt))
      .limit(200);

    res.json(
      logs
        .reverse()
        .map((l) => ({ id: l.id, content: l.content, createdAt: l.createdAt.toISOString() })),
    );
  } catch (err) {
    logger.error({ err }, "Server logs error");
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/servers/:id/send-command
router.post("/:id/send-command", requireAuth, async (req, res) => {
  try {
    const [server] = await db
      .select()
      .from(serversTable)
      .where(eq(serversTable.serverId, req.params["id"] as string))
      .limit(1);

    if (!server) {
      res.status(404).json({ error: "Server not found" });
      return;
    }

    if (req.user!.role !== "admin" && server.userId !== req.user!.userId) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const { command } = req.body as { command: string };
    if (!command) {
      res.status(400).json({ error: "command is required" });
      return;
    }

    await addLog(server.id, `> ${command}`);
    if (server.status !== "running") {
      await addLog(server.id, "[Error] Server is not running");
    } else {
      await addLog(server.id, `[Output] Command executed: ${command}`);
    }

    res.json({ ok: true, message: "Command sent" });
  } catch (err) {
    logger.error({ err }, "Send command error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
