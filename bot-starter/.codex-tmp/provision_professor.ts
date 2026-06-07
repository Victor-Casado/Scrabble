import * as fs from "node:fs";
import * as path from "node:path";

import { DbConnection, type ErrorContext } from "../src/module_bindings/index.js";
import { setGlobalLogLevel } from "spacetimedb";

const host = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const databaseName = process.env.STDB_DB ?? "scrabblebot";
const teamName = process.env.PROFESSOR_TEAM_NAME ?? "the-professor-team";
const botName = process.env.PROFESSOR_BOT_NAME ?? "the-professor";
const noncePath = path.join(process.cwd(), ".codex-tmp", "the-professor-nonce.txt");

let createRequested = false;
let mintRequested = false;
let finished = false;

setGlobalLogLevel("warn");

function finish(code: string): void {
  if (finished) return;
  finished = true;
  fs.mkdirSync(path.dirname(noncePath), { recursive: true });
  fs.writeFileSync(noncePath, code, "utf8");
  console.log(code);
  setTimeout(() => process.exit(0), 50);
}

function tick(conn: DbConnection): void {
  const team = Array.from(conn.db.my_team.iter())[0];
  if (team === undefined) {
    if (!createRequested) {
      createRequested = true;
      console.log(`creating team=${teamName} bot=${botName}`);
      conn.reducers.createTeam({ teamName, botName });
    }
    return;
  }

  if (team.botName !== botName) {
    console.error(`connected identity owns bot=${team.botName}, expected ${botName}`);
    process.exit(1);
  }

  if (!mintRequested) {
    mintRequested = true;
    console.log("minting credential nonce");
    conn.reducers.mintCredentialNonce({});
  }

  const nonce = Array.from(conn.db.my_nonces.iter()).sort((left, right) =>
    left.expiresAt.microsSinceUnixEpoch > right.expiresAt.microsSinceUnixEpoch ? -1 : 1,
  )[0];
  if (nonce !== undefined) finish(nonce.code);
}

DbConnection.builder()
  .withUri(host)
  .withDatabaseName(databaseName)
  .withLightMode(true)
  .withConfirmedReads(false)
  .onConnect((conn) => {
    conn
      .subscriptionBuilder()
      .onApplied(() => tick(conn))
      .subscribe(["SELECT * FROM my_team", "SELECT * FROM my_nonces"]);
    conn.db.my_team.onInsert(() => tick(conn));
    conn.db.my_nonces.onInsert(() => tick(conn));
  })
  .onConnectError((_ctx: ErrorContext, err: Error) => {
    console.error(`connect error: ${err.message}`);
    process.exit(1);
  })
  .onDisconnect(() => {
    if (!finished) console.log("disconnected");
  })
  .build();

setTimeout(() => {
  console.error("timed out waiting for nonce");
  process.exit(1);
}, 30000);
