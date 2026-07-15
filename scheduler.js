import { getKV, setKV } from "./db.js";
import { runBackup } from "./backup.js";
import { withActor } from "./request-context.js";
import * as eventbrite from "./integrations/eventbrite.js";
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

async function tick() {
  return withActor("system:scheduler", async () => {
    try {
    // Weekly report every Monday.
    if (new Date().getDay() === 1 && getKV("scheduler:weeklyReport") !== isoWeek()) {
      generateWeeklyReport();
      setKV("scheduler:weeklyReport", isoWeek());
    }
    // Daily attention digest in the activity log.
    if (getKV("scheduler:dailyDigest") !== today()) {
      const attention = getAttention();
      if (attention.items.length) createDigestEntry(attention);
      setKV("scheduler:dailyDigest", today());
    }
    // Hourly Eventbrite ticket sync when connected.
    const lastSync = getKV("scheduler:eventbrite");
    if (eventbrite.isConfigured() && (!lastSync || Date.now() - new Date(lastSync).getTime() > 3600000)) {
      await eventbrite.syncTickets();
      setKV("scheduler:eventbrite", new Date().toISOString());
    }
    if (process.env.BACKUP_DIR && getKV("scheduler:backup") !== today()) {
      await runBackup();
      setKV("scheduler:backup", today());
    }
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "scheduler_error", message: error.message }));
    }
  });
}

export function startScheduler() {
  if (process.env.SCHEDULER === "off") return null;
  tick();
  const timer = setInterval(tick, 5 * 60 * 1000);
  timer.unref();
  return timer;
}
