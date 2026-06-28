import { Router } from "express";
import { db } from "@workspace/db";
import { usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middleware/auth.js";
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

router.get("/", requireAuth, async (req, res) => {
  try {
    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, req.user!.userId))
      .limit(1);

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json(safeUser(user));
  } catch (err) {
    logger.error({ err }, "Get profile error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.patch("/", requireAuth, async (req, res) => {
  try {
    const { email, avatarUrl, theme, language } = req.body as {
      email?: string;
      avatarUrl?: string;
      theme?: string;
      language?: string;
    };

    const update: Partial<typeof usersTable.$inferInsert> = {};
    if (email !== undefined) update.email = email || null;
    if (avatarUrl !== undefined) update.avatarUrl = avatarUrl || null;
    if (theme !== undefined) update.theme = theme;
    if (language !== undefined) update.language = language;

    const [updated] = await db
      .update(usersTable)
      .set(update)
      .where(eq(usersTable.id, req.user!.userId))
      .returning();

    res.json(safeUser(updated));
  } catch (err) {
    logger.error({ err }, "Update profile error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
