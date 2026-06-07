import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serverSource = readFileSync(
  new URL("../../spacetimedb/src/lib.rs", import.meta.url),
  "utf8",
);

function reducerSource(name: string): string {
  const start = serverSource.indexOf(`pub fn ${name}`);
  assert.notEqual(start, -1, `missing reducer ${name}`);
  const nextReducer = serverSource.indexOf("\n#[reducer]", start + 1);
  return serverSource.slice(start, nextReducer === -1 ? serverSource.length : nextReducer);
}

test("server deletes bot stats when dissolving a team", () => {
  const leaveTeam = reducerSource("leave_team");
  const statsDelete = leaveTeam.indexOf("ctx.db.bot_stats().bot_id().delete(bid)");
  const botDelete = leaveTeam.indexOf("ctx.db.bot().id().delete(bid)");

  assert.ok(statsDelete >= 0, "leave_team should delete bot_stats for removed bots");
  assert.ok(botDelete >= 0, "leave_team should still delete the bot row");
  assert.ok(statsDelete < botDelete, "bot_stats should be deleted before the bot row");
});

test("server exposes public orphan bot stats cleanup", () => {
  const cleanup = reducerSource("cleanup_orphan_bot_stats");

  assert.match(cleanup, /Result<\(\),\s*String>/);
  assert.match(cleanup, /bot_stats\(\)\s*\.iter\(\)/);
  assert.match(cleanup, /ctx\.db\.bot\(\)\.id\(\)\.find\(stats\.bot_id\)\.is_none\(\)/);
  assert.match(cleanup, /ctx\.db\.bot_stats\(\)\.bot_id\(\)\.delete\(bot_id\)/);
  assert.match(cleanup, /Cleaned up/);
  assert.doesNotMatch(cleanup, /require_admin/);
});
