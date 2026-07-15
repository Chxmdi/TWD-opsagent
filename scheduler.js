import { getKV, setKV } from "./db.js";
import { runBackup } from "./backup.js";
import { withActor } from "./request-context.js";
import { refreshConnectedContext } from "./context-sync.js";
import { createDigestEntry, generateWeeklyReport, getAttention } from "./store.js";

function today() {
  return new Date().toISOString().slice(0, 10);
}

function isoWeek(date = new Date()) {
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  utc.setUTCDate(utc.getUTCDate() + 4 - (utc.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  return `${utc.getUTCFullYear()}-W${Math.ceil(((utc - yearStart) / 86400000 + 1) / 7)}`;
}

export async function runScheduledOperations() {
  return withActor("system:scheduler", async () => {
    const result = { weeklyReport: false, dailyDigest: false, contextRefresh: false, backup: false };
    try {
    // One report per ISO week. On sleeping free services, generate it on the
    // first scheduled wake or operator request instead of requiring Monday uptime.
    if (getKV("scheduler:weeklyReport") !== isoWeek()) {
      generateWeeklyReport();
      setKV("scheduler:weeklyReport", isoWeek());
      result.weeklyReport = true;
    }
    // Daily attention digest in the activity log.
    if (getKV("scheduler:dailyDigest") !== today()) {
      const attention = getAttention();
      if (attention.items.length) createDigestEntry(attention);
      setKV("scheduler:dailyDigest", today());
      result.dailyDigest = true;
    }
    await refreshConnectedContext();
    result.contextRefresh = true;
    if (process.env.BACKUP_DIR && getKV("scheduler:backup") !== today()) {
      await runBackup();
      setKV("scheduler:backup", today());
      result.backup = true;
    }
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "scheduler_error", message: error.message }));
      throw error;
    }
    return result;
  });
}

export function startScheduler() {
  if (process.env.SCHEDULER === "off") return null;
  const invoke = () => { void runScheduledOperations().catch(() => {}); };
  invoke();
  const timer = setInterval(invoke, 5 * 60 * 1000);
  timer.unref();
  return timer;
}
