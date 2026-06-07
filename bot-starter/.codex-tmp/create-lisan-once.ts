import fs from "node:fs";
import path from "node:path";
import { setGlobalLogLevel, type ErrorContext, type Identity } from "spacetimedb";
import { DbConnection, type EventContext } from "../src/module_bindings/index.js";

const host = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const databaseName = process.env.STDB_DB ?? "scrabblebot";
const botName = "lisan al gaib";
const teamName = "lisan al gaib";
const tokenPath = path.resolve(`.token-${botName}`);

setGlobalLogLevel("warn");

let createCalled = false;
let mintCalled = false;
let claimCalled = false;
let finished = false;
let myIdentity: Identity | null = null;

function loadToken(): string | undefined {
  try {
    return fs.readFileSync(tokenPath, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function saveToken(token: string): void {
  fs.writeFileSync(tokenPath, token);
}

function finish(code: number, message: string): void {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  console.log(message);
  process.exit(code);
}

function reducerRejected(name: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  finish(1, `${name} rejected: ${message}`);
}

function callReducer(name: string, call: () => unknown): void {
  console.log(`action=${name}`);
  const result = call();
  if (result && typeof (result as Promise<unknown>).catch === "function") {
    void (result as Promise<unknown>).catch((error) => reducerRejected(name, error));
  }
}

function maybeCreate(conn: DbConnection, reason: string): void {
  if (myIdentity === null) return;
  const credential = conn.db.bot_credential.identity.find(myIdentity);
  if (credential !== undefined && credential !== null) {
    const bot = conn.db.bot.id.find(credential.botId);
    finish(
      0,
      [
        "credential-ready",
        `reason=${reason}`,
        `token=${path.basename(tokenPath)}`,
        `identity=${myIdentity.toHexString()}`,
        `botId=${credential.botId}`,
        `botName=${bot?.name ?? "unknown"}`,
      ].join(" "),
    );
    return;
  }

  const teams = Array.from(conn.db.my_team.iter());
  if (teams.length === 0) {
    if (createCalled) return;
    createCalled = true;
    callReducer("create_team", () => conn.reducers.createTeam({ teamName, botName }));
    return;
  }

  const team = teams[0];
  console.log(
    [
      `team-present`,
      `reason=${reason}`,
      `teamId=${team.teamId}`,
      `teamName=${team.teamName}`,
      `botId=${team.botId}`,
      `botName=${team.botName}`,
      `credentialCount=${team.credentialCount}`,
    ].join(" "),
  );

  const nonces = Array.from(conn.db.my_nonces.iter()).filter(
    (nonce) => nonce.botId === team.botId,
  );
  if (nonces.length === 0) {
    if (mintCalled) return;
    mintCalled = true;
    callReducer("mint_credential_nonce", () => conn.reducers.mintCredentialNonce({}));
    return;
  }

  if (claimCalled) return;
  claimCalled = true;
  callReducer("claim_credential", () =>
    conn.reducers.claimCredential({ code: nonces[0].code }),
  );
}

const timeout = setTimeout(() => {
  finish(1, "timeout waiting for lisan al gaib credential");
}, 30_000);

const existingToken = loadToken();

DbConnection.builder()
  .withUri(host)
  .withDatabaseName(databaseName)
  .withToken(existingToken)
  .withLightMode(true)
  .withConfirmedReads(false)
  .onConnect((conn: DbConnection, identity: Identity, token: string) => {
    myIdentity = identity;
    saveToken(token);
    console.log(
      [
        "connected",
        `token=${path.basename(tokenPath)}`,
        `identity=${identity.toHexString()}`,
        `mode=${existingToken === undefined ? "new-identity" : "resume-token"}`,
      ].join(" "),
    );

    conn.db.my_team.onInsert((_ctx: EventContext) => maybeCreate(conn, "team-insert"));
    conn.db.my_nonces.onInsert((_ctx: EventContext) =>
      maybeCreate(conn, "nonce-insert"),
    );
    conn.db.bot_credential.onInsert((_ctx: EventContext) =>
      maybeCreate(conn, "credential-insert"),
    );

    conn
      .subscriptionBuilder()
      .onApplied(() => maybeCreate(conn, "subscription-applied"))
      .subscribe([
        "SELECT * FROM bot",
        "SELECT * FROM bot_credential",
        "SELECT * FROM my_team",
        "SELECT * FROM my_nonces",
      ]);
  })
  .onConnectError((_ctx: ErrorContext, error: Error) => {
    finish(1, `connect error: ${error.message}`);
  })
  .build();
