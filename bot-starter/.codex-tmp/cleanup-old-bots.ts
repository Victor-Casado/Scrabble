import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DbConnection, type ErrorContext } from "../src/module_bindings/index.js";
import { setGlobalLogLevel, type Identity } from "spacetimedb";

const HOST = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const DB_NAME = process.env.STDB_DB ?? "scrabblebot";
const BOT_NAMES = process.argv.slice(2);
const TIMEOUT_MS = 15_000;

setGlobalLogLevel("warn");

function tokenFor(botName: string): string {
  return readFileSync(join(process.cwd(), `.token-${botName}`), "utf8").trim();
}

function cleanupBot(botName: string): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let conn: DbConnection | null = null;
    const finish = (ok: boolean, message: string) => {
      if (done) return;
      done = true;
      console.log(`${ok ? "OK" : "FAIL"} ${botName} ${message}`);
      try {
        conn?.disconnect();
      } catch {
        // Ignore disconnect cleanup failures; reducer result is what matters.
      }
      resolve(ok);
    };

    const timer = setTimeout(() => {
      finish(false, "timeout");
    }, TIMEOUT_MS);

    conn = DbConnection.builder()
      .withUri(HOST)
      .withDatabaseName(DB_NAME)
      .withToken(tokenFor(botName))
      .withLightMode(true)
      .withConfirmedReads(false)
      .onConnect((connected: DbConnection, identity: Identity) => {
        conn = connected;
        connected.reducers
          .leaveTeam({})
          .then(() => {
            clearTimeout(timer);
            finish(true, `identity=${identity.toHexString()}`);
          })
          .catch((error: unknown) => {
            clearTimeout(timer);
            const message = error instanceof Error ? error.message : String(error);
            finish(false, message);
          });
      })
      .onConnectError((_ctx: ErrorContext, error: Error) => {
        clearTimeout(timer);
        finish(false, `connect-error=${error.message}`);
      })
      .build();
  });
}

for (const botName of BOT_NAMES) {
  const ok = await cleanupBot(botName);
  if (ok) {
    unlinkSync(join(process.cwd(), `.token-${botName}`));
  }
}
