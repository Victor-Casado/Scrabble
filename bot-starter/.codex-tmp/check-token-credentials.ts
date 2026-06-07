import fs from "node:fs";
import path from "node:path";
import { setGlobalLogLevel, type ErrorContext, type Identity } from "spacetimedb";
import { DbConnection } from "../src/module_bindings/index.js";

const host = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const databaseName = process.env.STDB_DB ?? "scrabblebot";
const tokenPaths = process.argv.slice(2);

if (tokenPaths.length === 0) {
  console.error("usage: tsx .codex-tmp/check-token-credentials.ts <token-path>...");
  process.exit(2);
}

setGlobalLogLevel("warn");

type TokenResult = {
  file: string;
  identity: string;
  botId: string;
  botName: string;
  connected: string;
  teamCount: string;
  nonceCount: string;
  error: string;
};

function checkToken(tokenPath: string): Promise<TokenResult> {
  return new Promise((resolve, reject) => {
    const absolutePath = path.resolve(tokenPath);
    const token = fs.readFileSync(absolutePath, "utf8").trim();
    const timeout = setTimeout(() => {
      resolve({
        file: path.basename(tokenPath),
        identity: "unknown",
        botId: "none",
        botName: "none",
        connected: "unknown",
        teamCount: "unknown",
        nonceCount: "unknown",
        error: "timeout",
      });
    }, 12_000);

    DbConnection.builder()
      .withUri(host)
      .withDatabaseName(databaseName)
      .withToken(token)
      .withLightMode(true)
      .withConfirmedReads(false)
      .onConnect((conn: DbConnection, identity: Identity) => {
        conn
          .subscriptionBuilder()
          .onApplied(() => {
            clearTimeout(timeout);
            const credential = conn.db.bot_credential.identity.find(identity);
            const teamCount = Array.from(conn.db.my_team.iter()).length;
            const nonceCount = Array.from(conn.db.my_nonces.iter()).length;
            const bot =
              credential === undefined || credential === null
                ? undefined
                : conn.db.bot.id.find(credential.botId);
            resolve({
              file: path.basename(tokenPath),
              identity: identity.toHexString(),
              botId:
                credential === undefined || credential === null
                  ? "none"
                  : String(credential.botId),
              botName: bot?.name ?? "none",
              connected:
                credential === undefined || credential === null
                  ? "unknown"
                  : String(credential.connected),
              teamCount: String(teamCount),
              nonceCount: String(nonceCount),
              error: "none",
            });
          })
          .subscribe([
            "SELECT * FROM bot",
            "SELECT * FROM bot_credential",
            "SELECT * FROM my_team",
            "SELECT * FROM my_nonces",
          ]);
      })
      .onConnectError((_ctx: ErrorContext, error: Error) => {
        clearTimeout(timeout);
        resolve({
          file: path.basename(tokenPath),
          identity: "unknown",
          botId: "none",
          botName: "none",
          connected: "unknown",
          teamCount: "unknown",
          nonceCount: "unknown",
          error: error.message,
        });
      })
      .build();
  });
}

const results: TokenResult[] = [];
for (const tokenPath of tokenPaths) {
  results.push(await checkToken(tokenPath));
}

for (const result of results) {
  console.log(
    [
      `file=${result.file}`,
      `identity=${result.identity}`,
      `botId=${result.botId}`,
      `botName=${result.botName}`,
      `connected=${result.connected}`,
      `teamCount=${result.teamCount}`,
      `nonceCount=${result.nonceCount}`,
      `error=${result.error}`,
    ].join(" "),
  );
}

process.exit(0);
