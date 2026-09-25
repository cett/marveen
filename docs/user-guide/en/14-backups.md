# 14 - Backups

The Backups view manages database backups of the system's SQLite data. From here you can trigger manual backups, verify backup integrity, and delete old files.

---

## The backup list

When the page loads, the backup table is displayed. Each row shows:

- **Filename** -- the backup file name (with timestamp)
- **Size** -- file size (B / KB / MB)
- **Time** -- local time the backup was created
- **Checksum** -- SHA-256 hash (if recorded); the first 12 characters are shown; hover for the full value

Summary statistics at the top of the page show the total count and the time of the last backup.

---

## Running a manual backup

The **Run backup** button triggers an immediate backup. The list refreshes automatically after about 3 seconds.

---

## Checksum verification

The **Verify** button checks the integrity of a backup file: the system recalculates the SHA-256 hash and compares it with the stored value. The result appears in a panel at the bottom of the page. If no checksum was recorded (older backups), the cell shows a dash.

---

## Retention setting

The **Retention** dropdown sets how many backups are kept automatically. Older backups beyond this count are removed on the next backup run. Save the setting with the **Save** button.

---

## Deleting a backup

Clicking **Delete** shows a confirmation dialog. Deleted files cannot be recovered.

---

## Related sections

- [11 - Settings](11-settings.md) -- automatic backup schedule
- [13 - Audit Log](13-audit.md) -- system event tracking
