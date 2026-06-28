import { pgTable, serial, varchar, text, boolean, timestamp, integer, real, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  username: varchar("username", { length: 50 }).notNull().unique(),
  email: varchar("email", { length: 255 }),
  passwordHash: text("password_hash").notNull(),
  role: varchar("role", { length: 20 }).notNull().default("member"),
  isSuspended: boolean("is_suspended").notNull().default(false),
  forcePasswordChange: boolean("force_password_change").notNull().default(false),
  avatarUrl: text("avatar_url"),
  theme: varchar("theme", { length: 20 }).notNull().default("dark"),
  language: varchar("language", { length: 10 }).notNull().default("en"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastLoginAt: timestamp("last_login_at"),
});

export const serversTable = pgTable("servers", {
  id: serial("id").primaryKey(),
  serverId: varchar("server_id", { length: 25 }).notNull().unique(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 100 }).notNull(),
  runtime: varchar("runtime", { length: 20 }).notNull().default("nodejs"),
  startupFile: varchar("startup_file", { length: 255 }).notNull().default("index.js"),
  startupCommand: text("startup_command").notNull().default(""),
  envVars: jsonb("env_vars").$type<{ key: string; value: string }[]>().notNull().default([]),
  status: varchar("status", { length: 20 }).notNull().default("stopped"),
  ramLimitMb: integer("ram_limit_mb").notNull().default(512),
  cpuLimit: real("cpu_limit").notNull().default(0.25),
  diskLimitGb: real("disk_limit_gb").notNull().default(1),
  suspendedAt: timestamp("suspended_at"),
  suspendUntil: timestamp("suspend_until"),
  suspendReason: text("suspend_reason"),
  nodeId: integer("node_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const serverLogsTable = pgTable("server_logs", {
  id: serial("id").primaryKey(),
  serverId: integer("server_id").notNull().references(() => serversTable.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const settingsTable = pgTable("settings", {
  key: varchar("key", { length: 100 }).primaryKey(),
  value: text("value").notNull(),
});

export const announcementsTable = pgTable("announcements", {
  id: serial("id").primaryKey(),
  title: varchar("title", { length: 200 }).notNull(),
  message: text("message").notNull(),
  type: varchar("type", { length: 20 }).notNull().default("info"),
  isGlobal: boolean("is_global").notNull().default(true),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: integer("created_by").references(() => usersTable.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const auditLogsTable = pgTable("audit_logs", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  action: varchar("action", { length: 200 }).notNull(),
  details: text("details"),
  ipAddress: varchar("ip_address", { length: 50 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const apiKeysTable = pgTable("api_keys", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 100 }).notNull(),
  keyHash: text("key_hash").notNull(),
  keyPrefix: varchar("key_prefix", { length: 10 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  lastUsedAt: timestamp("last_used_at"),
});

export const nodesTable = pgTable("nodes", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 100 }).notNull(),
  host: varchar("host", { length: 255 }).notNull(),
  port: integer("port").notNull().default(22),
  sshUser: varchar("ssh_user", { length: 100 }).notNull().default("root"),
  sshKey: text("ssh_key"),
  isOnline: boolean("is_online").notNull().default(false),
  isDefault: boolean("is_default").notNull().default(false),
  ramTotalGb: real("ram_total_gb").notNull().default(0),
  cpuCores: integer("cpu_cores").notNull().default(0),
  diskTotalGb: real("disk_total_gb").notNull().default(0),
  location: varchar("location", { length: 100 }),
  notes: text("notes"),
  lastPingedAt: timestamp("last_pinged_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true });
export const insertServerSchema = createInsertSchema(serversTable).omit({ id: true, createdAt: true });
export const insertAuditLogSchema = createInsertSchema(auditLogsTable).omit({ id: true, createdAt: true });
export const insertNodeSchema = createInsertSchema(nodesTable).omit({ id: true, createdAt: true });

export type User = typeof usersTable.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type Server = typeof serversTable.$inferSelect;
export type InsertServer = z.infer<typeof insertServerSchema>;
export type ServerLog = typeof serverLogsTable.$inferSelect;
export type Setting = typeof settingsTable.$inferSelect;
export type Announcement = typeof announcementsTable.$inferSelect;
export type AuditLog = typeof auditLogsTable.$inferSelect;
export type ApiKey = typeof apiKeysTable.$inferSelect;
export type Node = typeof nodesTable.$inferSelect;
