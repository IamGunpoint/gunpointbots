import { db } from "@workspace/db";
import { settingsTable } from "@workspace/db";

export interface PanelSettings {
  panelName: string;
  developerCredit: string;
  showDeveloperCredit: boolean;
  registrationEnabled: boolean;
  freeHostingEnabled: boolean;
  freeBotsPerUser: number;
  freeRamMb: number;
  freeCpu: number;
  freeDiskGb: number;
  maintenanceMode: boolean;
  maintenanceMessage: string;
  primaryColor: string;
  accentColor: string;
  backgroundType: string;
  backgroundValue: string;
  faviconUrl: string;
  logoUrl: string;
  announcementBanner: string | null;
  autoSuspendEnabled: boolean;
  autoSuspendIdleMinutes: number;
}

const DEFAULTS: PanelSettings = {
  panelName: "GunpointBots",
  developerCredit: "IamGunpoint",
  showDeveloperCredit: true,
  registrationEnabled: true,
  freeHostingEnabled: true,
  freeBotsPerUser: 1,
  freeRamMb: 512,
  freeCpu: 0.25,
  freeDiskGb: 1,
  maintenanceMode: false,
  maintenanceMessage: "The panel is currently under maintenance. Please check back soon.",
  primaryColor: "#6366f1",
  accentColor: "#22d3ee",
  backgroundType: "video",
  backgroundValue: "https://nobitahost.in/videos.mp4",
  faviconUrl: "",
  logoUrl: "",
  announcementBanner: null,
  autoSuspendEnabled: false,
  autoSuspendIdleMinutes: 60,
};

export async function getSettings(): Promise<PanelSettings> {
  const rows = await db.select().from(settingsTable);
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;
  return {
    panelName: map["panelName"] ?? DEFAULTS.panelName,
    developerCredit: map["developerCredit"] ?? DEFAULTS.developerCredit,
    showDeveloperCredit: (map["showDeveloperCredit"] ?? "true") === "true",
    registrationEnabled: (map["registrationEnabled"] ?? "true") === "true",
    freeHostingEnabled: (map["freeHostingEnabled"] ?? "true") === "true",
    freeBotsPerUser: parseInt(map["freeBotsPerUser"] ?? "1"),
    freeRamMb: parseInt(map["freeRamMb"] ?? "512"),
    freeCpu: parseFloat(map["freeCpu"] ?? "0.25"),
    freeDiskGb: parseFloat(map["freeDiskGb"] ?? "1"),
    maintenanceMode: (map["maintenanceMode"] ?? "false") === "true",
    maintenanceMessage: map["maintenanceMessage"] ?? DEFAULTS.maintenanceMessage,
    primaryColor: map["primaryColor"] ?? DEFAULTS.primaryColor,
    accentColor: map["accentColor"] ?? DEFAULTS.accentColor,
    backgroundType: map["backgroundType"] ?? DEFAULTS.backgroundType,
    backgroundValue: map["backgroundValue"] ?? DEFAULTS.backgroundValue,
    faviconUrl: map["faviconUrl"] ?? DEFAULTS.faviconUrl,
    logoUrl: map["logoUrl"] ?? DEFAULTS.logoUrl,
    announcementBanner: map["announcementBanner"] ?? null,
    autoSuspendEnabled: (map["autoSuspendEnabled"] ?? "false") === "true",
    autoSuspendIdleMinutes: parseInt(map["autoSuspendIdleMinutes"] ?? "60"),
  };
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db
    .insert(settingsTable)
    .values({ key, value })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value } });
}

export async function updateSettings(patch: Partial<PanelSettings>): Promise<PanelSettings> {
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) {
      await setSetting(k, String(v));
    }
  }
  return getSettings();
}
