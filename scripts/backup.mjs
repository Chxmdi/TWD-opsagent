import { runBackup } from "../backup.js";
import { closeDatabase } from "../db.js";

try {
  const destination = await runBackup();
  if (!destination) throw new Error("BACKUP_DIR is not configured");
  console.log(`Backup completed: ${destination}`);
} finally {
  await closeDatabase();
}
