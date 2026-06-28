import { Router } from "express";
import { db } from "@workspace/db";
import { apiKeysTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { requireAuth } from "../middleware/auth.js";
import { logger } from "../lib/logger.js";
import crypto from "crypto";
import bcrypt from "bcryptjs";

const router = Router();

function generateKey(): string {
  return "gbk_" + crypto.randomBytes(32).toString("hex");
}

router.get("/", requireAuth, async (req, res) => {
  try {
    const keys = await db
      .select()
      .from(apiKeysTable)
      .where(eq(apiKeysTable.userId, req.user!.userId))
      .orderBy(desc(apiKeysTable.createdAt));

    res.json(
      keys.map((k) => ({
        id: k.id,
        name: k.name,
        keyPrefix: k.keyPrefix,
        createdAt: k.createdAt.toISOString(),
        lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
      })),
    );
  } catch (err) {
    logger.error({ err }, "List API keys error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/", requireAuth, async (req, res) => {
  try {
    const { name } = req.body as { name: string };
    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }

    const key = generateKey();
    const keyHash = await bcrypt.hash(key, 10);
    const keyPrefix = key.slice(0, 10);

    const [k] = await db
      .insert(apiKeysTable)
      .values({ userId: req.user!.userId, name, keyHash, keyPrefix })
      .returning();

    res.status(201).json({
      id: k.id,
      name: k.name,
      key,
      createdAt: k.createdAt.toISOString(),
    });
  } catch (err) {
    logger.error({ err }, "Create API key error");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.delete("/:id", requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params["id"] as string);
    const [key] = await db
      .select()
      .from(apiKeysTable)
      .where(eq(apiKeysTable.id, id))
      .limit(1);

    if (!key) {
      res.status(404).json({ error: "API key not found" });
      return;
    }

    if (key.userId !== req.user!.userId && req.user!.role !== "admin") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    await db.delete(apiKeysTable).where(eq(apiKeysTable.id, id));
    res.json({ ok: true, message: "API key deleted" });
  } catch (err) {
    logger.error({ err }, "Delete API key error");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
