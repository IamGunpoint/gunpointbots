import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import authRouter from "./auth.js";
import dashboardRouter from "./dashboard.js";
import serversRouter from "./servers.js";
import filesRouter from "./files.js";
import adminRouter from "./admin.js";
import announcementsRouter from "./announcements.js";
import apiKeysRouter from "./apikeys.js";
import profileRouter from "./profile.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/auth", authRouter);
router.use("/dashboard", dashboardRouter);
router.use("/servers", serversRouter);
router.use("/servers/:id/files", filesRouter);
router.use("/admin", adminRouter);
router.use("/announcements", announcementsRouter);
router.use("/api-keys", apiKeysRouter);
router.use("/profile", profileRouter);

export default router;
