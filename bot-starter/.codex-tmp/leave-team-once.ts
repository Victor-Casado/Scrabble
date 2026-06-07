import fs from "node:fs";
import path from "node:path";
import { setGlobalLogLevel, type ErrorContext } from "spacetimedb";
import { DbConnection, type EventContext } from "../src/module_bindings/index.js";

const host = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const databaseName = process.env.STDB_DB ?? "scrabblebot";
const tokenPath = process.argv[2];

if (!tokenPath) {
  console.error("usage: tsx .codex-tmp/leave-team-once.ts <token-path>");
  process.exit(2);
}

const token = fs.readFileSync(path.resolve(tokenPath), "utf8").trim();
setGlobalLogLevel("warn");

let reducerCalled = false;
let finished = false;

function finish(code: number, message: string): void {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  console.log(message);
  process.exit(code);
}

const timeout = setTimeout(() => {
  finish(1, "timeout waiting for leave_team verification");
}, 12_000);

function maybeLeave(conn: DbConnection, reason: string): void {
  const teams = Array.from(conn.db.my_team.iter());
  console.log(`status=${reason} myTeamCount=${teams.length}`);
  if (teams.length === 0) {
    finish(0, "leave_team verified: no my_team row");
    return;
  }
  if (reducerCalled) return;
  reducerCalled = true;
  const team = teams[0];
  console.log(`calling leave_team team=${team.teamName} teamId=${team.teamId}`);
  const result = conn.reducers.leaveTeam({});
  if (result && typeof (result as Promise<unknown>).catch === "function") {
    void (result as Promise<unknown>).catch((error) => {
      finish(1, `leave_team rejected: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

DbConnection.builder()
  .withUri(host)
  .withDatabaseName(databaseName)
  .withToken(token)
  .withLightMode(true)
  .withConfirmedReads(false)
  .onConnect((conn: DbConnection) => {
    conn.db.my_team.onDelete((_ctx: EventContext) => {
      finish(0, "leave_team verified: my_team deleted");
    });
    conn
      .subscriptionBuilder()
      .onApplied(() => maybeLeave(conn, "subscription-applied"))
      .subscribe(["SELECT * FROM my_team"]);
  })
  .onConnectError((_ctx: ErrorContext, error: Error) => {
    finish(1, `connect error: ${error.message}`);
  })
  .build();
