import fs from "node:fs";
import path from "node:path";

import { BinaryWriter, setGlobalLogLevel, type ErrorContext } from "spacetimedb";

import { DbConnection, type ReducerEventContext } from "../src/module_bindings/index.js";

const host = process.env.STDB_HOST ?? "https://maincloud.spacetimedb.com";
const databaseName = process.env.STDB_DB ?? "scrabblebot";
const tokenPath = path.join(process.cwd(), ".token-lisan al gaib");
const tournamentId = BigInt(process.argv[2] ?? "1");

setGlobalLogLevel("warn");

function finish(code: number, message: string): never {
  console.log(message);
  process.exit(code);
}

function loadToken(): string {
  try {
    return fs.readFileSync(tokenPath, "utf8").trim();
  } catch {
    finish(1, `missing-token path=${tokenPath}`);
  }
}

function encodeTournamentId(id: bigint): Uint8Array {
  const writer = new BinaryWriter(8);
  writer.writeU64(id);
  return writer.getBuffer();
}

function register(conn: DbConnection): void {
  const callReducer = (conn as unknown as {
    callReducer: (
      reducerName: string,
      argsBuffer: Uint8Array,
      reducerArgs?: unknown,
    ) => Promise<void>;
  }).callReducer.bind(conn);

  callReducer("register_for_tournament", encodeTournamentId(tournamentId), {
    tournamentId,
  })
    .then(() => finish(0, `registered tournamentId=${tournamentId}`))
    .catch((err: Error) => finish(1, `register-failed ${err.message}`));
}

const timeout = setTimeout(
  () => finish(1, "timeout waiting for registration"),
  15000,
);

DbConnection.builder()
  .withUri(host)
  .withDatabaseName(databaseName)
  .withToken(loadToken())
  .withLightMode(true)
  .withConfirmedReads(false)
  .onConnect((conn: DbConnection, identity) => {
    clearTimeout(timeout);
    console.log(`connected identity=${identity.toHexString()}`);
    conn.reducers.onRegisterForTournament?.(
      (_ctx: ReducerEventContext) => undefined,
    );
    register(conn);
  })
  .onConnectError((_ctx: ErrorContext, err: Error) =>
    finish(1, `connect-failed ${err.message}`),
  )
  .build();
