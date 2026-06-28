import { Router } from "express";
import { db } from "@workspace/db";
import { serversTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireAuth } from "../middleware/auth.js";
import { logger } from "../lib/logger.js";
import multer from "multer";
import fs from "fs";
import path from "path";
import { createReadStream, createWriteStream } from "fs";
import archiver from "archiver";

const router = Router({ mergeParams: true });

const DATA_DIR = path.join(process.cwd(), "data", "bots");

function getServerFilesDir(serverId: string): string {
  return path.join(DATA_DIR, serverId, "files");
}

function safePath(base: string, userPath: string): string {
  const resolved = path.resolve(base, userPath.replace(/^\/+/, ""));
  if (!resolved.startsWith(path.resolve(base))) {
    throw new Error("Path traversal attempt detected");
  }
  return resolved;
}

async function getServerOrFail(serverId: string, userId: number, role: string) {
  const [server] = await db
    .select()
    .from(serversTable)
    .where(eq(serversTable.serverId, serverId))
    .limit(1);

  if (!server) throw Object.assign(new Error("Server not found"), { status: 404 });
  if (role !== "admin" && server.userId !== userId)
    throw Object.assign(new Error("Forbidden"), { status: 403 });

  const filesDir = getServerFilesDir(serverId);
  fs.mkdirSync(filesDir, { recursive: true });
  return { server, filesDir };
}

function getExtension(filename: string): string | null {
  const ext = path.extname(filename);
  return ext ? ext.slice(1).toLowerCase() : null;
}

function formatEntry(filePath: string, stat: fs.Stats, base: string) {
  const rel = "/" + path.relative(base, filePath).replace(/\\/g, "/");
  return {
    name: path.basename(filePath),
    path: rel,
    type: stat.isDirectory() ? "directory" : "file",
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    extension: stat.isDirectory() ? null : getExtension(path.basename(filePath)),
  };
}

// Multer: store uploaded files in memory temporarily
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB per file
});

// GET /api/servers/:id/files?path=...
router.get("/", requireAuth, async (req, res) => {
  try {
    const { server, filesDir } = await getServerOrFail(
      req.params["id"] as string,
      req.user!.userId,
      req.user!.role,
    );
    void server;

    const userPath = (req.query["path"] as string) || "/";
    const targetDir = safePath(filesDir, userPath);

    if (!fs.existsSync(targetDir)) {
      res.json([]);
      return;
    }

    const entries = fs.readdirSync(targetDir);
    const result = entries
      .map((entry) => {
        const fullPath = path.join(targetDir, entry);
        try {
          const stat = fs.statSync(fullPath);
          return formatEntry(fullPath, stat, filesDir);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    res.json(result);
  } catch (err: any) {
    logger.error({ err }, "List files error");
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// GET /api/servers/:id/files/content?path=...
router.get("/content", requireAuth, async (req, res) => {
  try {
    const { filesDir } = await getServerOrFail(
      req.params["id"] as string,
      req.user!.userId,
      req.user!.role,
    );

    const userPath = (req.query["path"] as string) || "";
    if (!userPath) {
      res.status(400).json({ error: "path is required" });
      return;
    }

    const targetFile = safePath(filesDir, userPath);
    if (!fs.existsSync(targetFile) || fs.statSync(targetFile).isDirectory()) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const stat = fs.statSync(targetFile);
    if (stat.size > 2 * 1024 * 1024) {
      res.status(413).json({ error: "File too large to edit (max 2MB)" });
      return;
    }

    const content = fs.readFileSync(targetFile, "utf8");
    res.json({ path: userPath, content, size: stat.size });
  } catch (err: any) {
    logger.error({ err }, "Get file content error");
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// PUT /api/servers/:id/files/content
router.put("/content", requireAuth, async (req, res) => {
  try {
    const { filesDir } = await getServerOrFail(
      req.params["id"] as string,
      req.user!.userId,
      req.user!.role,
    );

    const { path: userPath, content } = req.body as { path: string; content: string };
    if (!userPath) {
      res.status(400).json({ error: "path is required" });
      return;
    }

    const targetFile = safePath(filesDir, userPath);
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, content ?? "", "utf8");
    res.json({ ok: true, message: "File saved" });
  } catch (err: any) {
    logger.error({ err }, "Save file content error");
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// POST /api/servers/:id/files/mkdir
router.post("/mkdir", requireAuth, async (req, res) => {
  try {
    const { filesDir } = await getServerOrFail(
      req.params["id"] as string,
      req.user!.userId,
      req.user!.role,
    );

    const { path: userPath } = req.body as { path: string };
    if (!userPath) {
      res.status(400).json({ error: "path is required" });
      return;
    }

    const targetDir = safePath(filesDir, userPath);
    fs.mkdirSync(targetDir, { recursive: true });
    res.json({ ok: true, message: "Directory created" });
  } catch (err: any) {
    logger.error({ err }, "Create directory error");
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// DELETE /api/servers/:id/files/delete?path=...
router.delete("/delete", requireAuth, async (req, res) => {
  try {
    const { filesDir } = await getServerOrFail(
      req.params["id"] as string,
      req.user!.userId,
      req.user!.role,
    );

    const userPath = (req.query["path"] as string) || (req.body as any)?.path || "";
    if (!userPath) {
      res.status(400).json({ error: "path is required" });
      return;
    }

    const targetPath = safePath(filesDir, userPath);
    if (!fs.existsSync(targetPath)) {
      res.status(404).json({ error: "File or directory not found" });
      return;
    }

    const stat = fs.statSync(targetPath);
    if (stat.isDirectory()) {
      fs.rmSync(targetPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(targetPath);
    }

    res.json({ ok: true, message: "Deleted" });
  } catch (err: any) {
    logger.error({ err }, "Delete file error");
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// POST /api/servers/:id/files/rename
router.post("/rename", requireAuth, async (req, res) => {
  try {
    const { filesDir } = await getServerOrFail(
      req.params["id"] as string,
      req.user!.userId,
      req.user!.role,
    );

    const { path: oldPath, newName } = req.body as { path: string; newName: string };
    if (!oldPath || !newName) {
      res.status(400).json({ error: "path and newName are required" });
      return;
    }

    // Prevent path separators in newName
    if (newName.includes("/") || newName.includes("\\")) {
      res.status(400).json({ error: "newName must not contain path separators" });
      return;
    }

    const source = safePath(filesDir, oldPath);
    const dest = safePath(filesDir, path.join(path.dirname(oldPath), newName));

    if (!fs.existsSync(source)) {
      res.status(404).json({ error: "Source not found" });
      return;
    }

    if (fs.existsSync(dest)) {
      res.status(409).json({ error: "A file or directory with that name already exists" });
      return;
    }

    fs.renameSync(source, dest);
    res.json({ ok: true, message: "Renamed", newPath: "/" + path.relative(filesDir, dest).replace(/\\/g, "/") });
  } catch (err: any) {
    logger.error({ err }, "Rename file error");
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// POST /api/servers/:id/files/move
router.post("/move", requireAuth, async (req, res) => {
  try {
    const { filesDir } = await getServerOrFail(
      req.params["id"] as string,
      req.user!.userId,
      req.user!.role,
    );

    const { path: srcPath, destDir } = req.body as { path: string; destDir: string };
    if (!srcPath || !destDir) {
      res.status(400).json({ error: "path and destDir are required" });
      return;
    }

    const source = safePath(filesDir, srcPath);
    const targetDir = safePath(filesDir, destDir);
    const dest = path.join(targetDir, path.basename(source));

    if (!fs.existsSync(source)) {
      res.status(404).json({ error: "Source not found" });
      return;
    }

    fs.mkdirSync(targetDir, { recursive: true });

    if (fs.existsSync(dest)) {
      res.status(409).json({ error: "Destination already exists" });
      return;
    }

    fs.renameSync(source, dest);
    res.json({ ok: true, message: "Moved", newPath: "/" + path.relative(filesDir, dest).replace(/\\/g, "/") });
  } catch (err: any) {
    logger.error({ err }, "Move file error");
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// POST /api/servers/:id/files/upload — multipart upload
router.post("/upload", requireAuth, upload.array("files", 50), async (req, res) => {
  try {
    const { filesDir } = await getServerOrFail(
      req.params["id"] as string,
      req.user!.userId,
      req.user!.role,
    );

    const uploadPath = (req.body as any)?.path || "/";
    const targetDir = safePath(filesDir, uploadPath);
    fs.mkdirSync(targetDir, { recursive: true });

    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      res.status(400).json({ error: "No files uploaded" });
      return;
    }

    const saved: string[] = [];
    for (const file of files) {
      const dest = safePath(targetDir, file.originalname);
      fs.writeFileSync(dest, file.buffer);
      saved.push("/" + path.relative(filesDir, dest).replace(/\\/g, "/"));
    }

    res.json({ ok: true, uploaded: saved });
  } catch (err: any) {
    logger.error({ err }, "Upload file error");
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// GET /api/servers/:id/files/download?path=...
router.get("/download", requireAuth, async (req, res) => {
  try {
    const { filesDir } = await getServerOrFail(
      req.params["id"] as string,
      req.user!.userId,
      req.user!.role,
    );

    const userPath = (req.query["path"] as string) || "";
    if (!userPath) {
      res.status(400).json({ error: "path is required" });
      return;
    }

    const targetPath = safePath(filesDir, userPath);
    if (!fs.existsSync(targetPath)) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const stat = fs.statSync(targetPath);

    if (stat.isDirectory()) {
      // Zip the directory on the fly
      res.setHeader("Content-Type", "application/zip");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${path.basename(targetPath)}.zip"`,
      );
      const archive = archiver("zip", { zlib: { level: 5 } });
      archive.on("error", (err) => { logger.error({ err }, "Archive error"); });
      archive.pipe(res);
      archive.directory(targetPath, path.basename(targetPath));
      await archive.finalize();
    } else {
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${path.basename(targetPath)}"`,
      );
      res.setHeader("Content-Length", stat.size.toString());
      createReadStream(targetPath).pipe(res);
    }
  } catch (err: any) {
    logger.error({ err }, "Download file error");
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

// POST /api/servers/:id/files/compress — zip selected paths
router.post("/compress", requireAuth, async (req, res) => {
  try {
    const { filesDir } = await getServerOrFail(
      req.params["id"] as string,
      req.user!.userId,
      req.user!.role,
    );

    const { paths, destName } = req.body as { paths: string[]; destName?: string };
    if (!paths || paths.length === 0) {
      res.status(400).json({ error: "paths array is required" });
      return;
    }

    const zipName = (destName || "archive").replace(/[^a-zA-Z0-9_\-. ]/g, "_") + ".zip";
    const destPath = safePath(filesDir, "/" + zipName);

    const output = createWriteStream(destPath);
    const archive = archiver("zip", { zlib: { level: 6 } });

    await new Promise<void>((resolve, reject) => {
      archive.on("error", reject);
      output.on("close", resolve);
      archive.pipe(output);

      for (const p of paths) {
        try {
          const fullPath = safePath(filesDir, p);
          if (!fs.existsSync(fullPath)) continue;
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            archive.directory(fullPath, path.basename(fullPath));
          } else {
            archive.file(fullPath, { name: path.basename(fullPath) });
          }
        } catch {
          // skip invalid paths
        }
      }
      archive.finalize();
    });

    res.json({ ok: true, message: "Compressed", path: "/" + zipName });
  } catch (err: any) {
    logger.error({ err }, "Compress files error");
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

export default router;
