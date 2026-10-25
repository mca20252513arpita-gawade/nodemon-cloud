export const cfg = {
  offHours: {
    enabled: (process.env.OFFHOURS_ENABLED ?? "true") === "true",
    tz: process.env.BUSINESS_TZ || "Asia/Kolkata",
    start: Number(process.env.BUSINESS_START_HOUR ?? 8),
    end: Number(process.env.BUSINESS_END_HOUR ?? 18),
    days: (process.env.BUSINESS_DAYS || "Mon,Tue,Wed,Thu,Fri,Sat").split(",").map((d) => d.trim()),
  },
  gatewayOfflineMin: Number(process.env.GATEWAY_OFFLINE_MINUTES ?? 2),   // demo: 2 min (was 6)
  assetSilentMin:    Number(process.env.ASSET_SILENT_MINUTES    ?? 2),   // demo: 2 min (was 5)
};
