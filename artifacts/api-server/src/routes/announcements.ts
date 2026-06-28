import { Router } from "express";
import { db } from "@workspace/db";
import { announcementsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { logger } from "../lib/logger.js";

const router = Router();

router.get("/", requireAuth, async (req, res) => {
  try {
    const rows = await db
      .select()
      .from(announcementsTable)
      .where(eq(announcementsTable.isActive, true))
      .orderBy(desc(announcementsTable.createdAt))
      .limit(20);

    res.json(
      rows.map((a) => ({
        id: a.id,
        title: a.title,
        message: a.message,
        type: a.type,
        isGlobal: a.isGlobal,
        createdAt: a.createdAt.toISOString(),
      })),
    );
  } catch (err) {
    logger.error({ err }, "List announcements error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/", requireAdmin, async (req, res) => {
  try {
    const { title, message, type = "info", isGlobal = true } = req.body as {
      title: string;
      message: string;
      type?: string;
      isGlobal?: boolean;
    };

    if (!title || !message) {
      res.status(400).json({ error: "title and message are required" });
      return;
    }

    const [a] = await db
      .insert(announcementsTable)
      .values({ title, message, type, isGlobal, createdBy: req.user!.userId })
      .returning();

    res.status(201).json({
      id: a.id,
      title: a.title,
      message: a.message,
      type: a.type,
      isGlobal: a.isGlobal,
      createdAt: a.createdAt.toISOString(),
    });
  } catch (err) {
    logger.error({ err }, "Create announcement error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    const id = parseInt(req.params["id"] as string);
    await db.delete(announcementsTable).where(eq(announcementsTable.id, id));
    res.json({ ok: true, message: "Announcement deleted" });
  } catch (err) {
    logger.error({ err }, "Delete announcement error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
