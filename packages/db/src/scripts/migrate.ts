import { createPool } from "../pool";
import { downMigrationRefusal, migrateDown, migrateUp, migrationStatus } from "../migrate";

const command = process.argv[2] ?? "up";
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = createPool({ connectionString: url, max: 1, ssl: process.env.DATABASE_SSL === "true", applicationName: "metafarm-migrate" });
const log = (m: string) => console.log(`[migrate] ${m}`);

try {
  if (command === "up") {
    const applied = await migrateUp(pool, log);
    log(applied.length ? `applied ${applied.join(", ")}` : "already up to date");
  } else if (command === "down") {
    const refusal = downMigrationRefusal(process.env);
    if (refusal) throw new Error(refusal);
    const v = await migrateDown(pool, log);
    log(v ? `reverted ${v}` : "nothing to revert");
  } else if (command === "status") {
    console.table(await migrationStatus(pool));
  } else {
    throw new Error(`unknown command ${command}`);
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
