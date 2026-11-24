import "fake-indexeddb/auto";
/**
 * Integration tests run route handlers directly against the real `finance_test` Postgres database,
 * connecting as the restricted ft_app role exactly like production.
 */
import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
config({ path: ".env", quiet: true });

if (!process.env.TEST_DATABASE_URL || !process.env.TEST_MIGRATION_DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL / TEST_MIGRATION_DATABASE_URL missing. Run `npm run db:local-setup`.");
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.APP_URL = "http://localhost:3000";
process.env.SETUP_TOKEN = "test-setup-token-123456";
process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
process.env.LOG_LEVEL = "error";
