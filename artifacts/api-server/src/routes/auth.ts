import { Router } from "express";
import bcrypt from "bcryptjs";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { signToken, requireAuth } from "../middleware/auth.js";
import { log } from "../lib/audit.js";
import { getSettings } from "../lib/settings.js";
import { logger } from "../lib/logger.js";

const router = Router();

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

router.post("/login", async (req, res) => {
  try {
    const { username, password, rememberMe = false } = req.body as {
      username: string;
      password: string;
      rememberMe?: boolean;
    };

    if (!username || !password) {
      res.status(400).json({ error: "Username and password are required" });
      return;
    }

    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.username, username))
      .limit(1);

    if (!user) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    if (user.isSuspended) {
      res.status(403).json({ error: "Account is suspended" });
      return;
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      await log("login_failed", { details: `Failed login for ${username}`, req });
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }

    await db
      .update(usersTable)
      .set({ lastLoginAt: new Date() })
      .where(eq(usersTable.id, user.id));

    await log("login", { userId: user.id, details: `User ${username} logged in`, req });

    const token = signToken(
      { userId: user.id, username: user.username, role: user.role },
      Boolean(rememberMe),
    );

    res.json({
      user: safeUser(user),
      token,
      forcePasswordChange: user.forcePasswordChange,
    });
  } catch (err) {
    logger.error({ err }, "Login error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/register", async (req, res) => {
  try {
    const settings = await getSettings();
    if (!settings.registrationEnabled) {
      res.status(403).json({ error: "Registration is currently disabled" });
      return;
    }

    const { username, password, email } = req.body as {
      username: string;
      password: string;
      email?: string;
    };

    if (!username || !password) {
      res.status(400).json({ error: "Username and password are required" });
      return;
    }

    if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
      res.status(400).json({
        error: "Username must be 3-30 characters and contain only letters, numbers, and underscores",
      });
      return;
    }

    if (password.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters" });
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
      .values({
        username,
        email: email || null,
        passwordHash,
        role: "member",
      })
      .returning();

    await log("register", { userId: user.id, details: `User ${username} registered`, req });

    const token = signToken({ userId: user.id, username: user.username, role: user.role });

    res.status(201).json({
      user: safeUser(user),
      token,
      forcePasswordChange: false,
    });
  } catch (err) {
    logger.error({ err }, "Register error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/logout", requireAuth, async (req, res) => {
  await log("logout", { userId: req.user!.userId, req });
  res.json({ ok: true, message: "Logged out" });
});

router.get("/me", requireAuth, async (req, res) => {
  try {
    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, req.user!.userId))
      .limit(1);

    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }

    if (user.isSuspended) {
      res.status(403).json({ error: "Account is suspended" });
      return;
    }

    res.json(safeUser(user));
  } catch (err) {
    logger.error({ err }, "Get me error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/change-password", requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body as {
      currentPassword: string;
      newPassword: string;
    };

    if (!currentPassword || !newPassword) {
      res.status(400).json({ error: "Both current and new password are required" });
      return;
    }

    if (newPassword.length < 8) {
      res.status(400).json({ error: "New password must be at least 8 characters" });
      return;
    }

    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, req.user!.userId))
      .limit(1);

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) {
      res.status(401).json({ error: "Current password is incorrect" });
      return;
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await db
      .update(usersTable)
      .set({ passwordHash, forcePasswordChange: false })
      .where(eq(usersTable.id, user.id));

    await log("change_password", { userId: user.id, req });

    res.json({ ok: true, message: "Password changed successfully" });
  } catch (err) {
    logger.error({ err }, "Change password error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export { safeUser };
export default router;
