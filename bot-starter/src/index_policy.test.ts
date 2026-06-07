import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const indexSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

test("entrypoint avoids unguarded rack-change word loops", () => {
  assert.doesNotMatch(indexSource, /my_rack\.onInsert\(\(\) => tryPlayWord/);
  assert.doesNotMatch(indexSource, /my_rack\.onUpdate\(\(\) => tryPlayWord/);
  assert.doesNotMatch(indexSource, /function tryPlayWord/);
});

test("entrypoint routes word submission through guarded cash-in and final dump paths", () => {
  assert.match(indexSource, /submitWordChecked/);
  assert.match(indexSource, /tryCashInBestWord/);
  assert.match(indexSource, /canSubmitWordNow/);
  assert.match(indexSource, /shouldSubmitWordNow/);
  assert.match(indexSource, /dumpRackIfFinal/);
});

test("entrypoint logs each guarded word submission for capture", () => {
  assert.match(indexSource, /submitting word/);
  assert.match(indexSource, /conn\.reducers\.submitWord/);
});

test("entrypoint logs accepted word plays from the server", () => {
  assert.match(indexSource, /word_play\.onInsert/);
  assert.match(indexSource, /accepted word/);
});

test("entrypoint detects word plays not submitted by this process", () => {
  assert.match(indexSource, /submittedWordCounts/);
  assert.match(indexSource, /external-word-detected/);
  assert.match(indexSource, /not-submitted-by-this-process/);
});

test("entrypoint filters accepted word capture to this process run", () => {
  assert.match(indexSource, /WORD_CAPTURE_STARTED_AT/);
  assert.match(indexSource, /playedAt\.microsSinceUnixEpoch/);
});

test("entrypoint does not auto-provision new bots", () => {
  assert.doesNotMatch(indexSource, /BOT_TEAM_NAME/);
  assert.doesNotMatch(indexSource, /autoProvisionCredential/);
  assert.doesNotMatch(indexSource, /conn\.reducers\.createTeam/);
  assert.doesNotMatch(indexSource, /conn\.reducers\.mintCredentialNonce/);
  assert.doesNotMatch(indexSource, /my_team\.onInsert/);
  assert.doesNotMatch(indexSource, /my_nonces\.onInsert/);
  assert.match(indexSource, /conn\.reducers\.claimCredential/);
  assert.match(indexSource, /existing-token-or-BOT_NONCE-required/);
});

test("entrypoint uses precise light-mode subscriptions for live latency", () => {
  assert.match(indexSource, /withLightMode\(true\)/);
  assert.match(indexSource, /withConfirmedReads\(false\)/);
  assert.match(indexSource, /LIVE_SUBSCRIPTION_QUERIES/);
  assert.match(indexSource, /\.subscribe\(LIVE_SUBSCRIPTION_QUERIES\)/);
  assert.doesNotMatch(indexSource, /subscribeToAllTables/);
});

test("entrypoint subscribes to word plays for ownership audit but not auction results", () => {
  const subscriptionStart = indexSource.indexOf("const LIVE_SUBSCRIPTION_QUERIES");
  const subscriptionEnd =
    subscriptionStart === -1 ? -1 : indexSource.indexOf("];", subscriptionStart);
  const subscriptions =
    subscriptionStart === -1 || subscriptionEnd === -1
      ? undefined
      : indexSource.slice(subscriptionStart, subscriptionEnd);

  assert.ok(subscriptions);
  assert.match(subscriptions, /word_play/);
  assert.doesNotMatch(subscriptions, /auction_result/);
});

test("entrypoint ignores unrelated match traffic before doing auction work", () => {
  const auctionHandler = indexSource.match(
    /conn\.db\.auction\.onInsert[\s\S]*?\n  \}\);/,
  )?.[0];
  const matchUpdateHandler = indexSource.match(
    /conn\.db\.match_state\.onUpdate[\s\S]*?\n  \}\);/,
  )?.[0];

  assert.ok(auctionHandler);
  assert.ok(matchUpdateHandler);
  assert.match(auctionHandler, /isMyRunningMatch/);
  assert.doesNotMatch(auctionHandler, /tryBid\(conn, a\.id, a\.matchId, a\.letter\);[\s\S]*?isMyRunningMatch/);
  assert.match(matchUpdateHandler, /isMyMatchParticipant/);
});

test("entrypoint bids from current-auction match state events", () => {
  const matchInsertHandler = indexSource.match(
    /conn\.db\.match_state\.onInsert[\s\S]*?\n  \}\);/,
  )?.[0];
  const matchUpdateHandler = indexSource.match(
    /conn\.db\.match_state\.onUpdate[\s\S]*?\n  \}\);/,
  )?.[0];

  assert.match(indexSource, /function tryBidCurrentAuction/);
  assert.ok(matchInsertHandler);
  assert.ok(matchUpdateHandler);
  assert.match(matchInsertHandler, /tryBidCurrentAuction/);
  assert.match(matchUpdateHandler, /tryBidCurrentAuction/);
});

test("entrypoint passes server auction type into live bid strategy", () => {
  const tryBidStart = indexSource.indexOf("function tryBid(");
  const onConnectStart = indexSource.indexOf("function onConnect");
  const tryBidFunction =
    tryBidStart === -1 || onConnectStart === -1
      ? undefined
      : indexSource.slice(tryBidStart, onConnectStart);

  assert.ok(tryBidFunction);
  assert.match(tryBidFunction, /auctionType:\s*describeTag\(match\?\.auctionType\)/);
});

test("entrypoint keeps auction-open on the bid-only critical path", () => {
  const auctionHandler = indexSource.match(
    /conn\.db\.auction\.onInsert[\s\S]*?\n  \}\);/,
  )?.[0];

  assert.ok(auctionHandler);
  assert.match(auctionHandler, /tryBid/);
  assert.doesNotMatch(auctionHandler, /tryCashInBestWord/);
});

test("entrypoint avoids expensive cash-in scans on every match update", () => {
  const matchUpdateHandler = indexSource.match(
    /conn\.db\.match_state\.onUpdate[\s\S]*?\n  \}\);/,
  )?.[0];

  assert.ok(matchUpdateHandler);
  assert.match(matchUpdateHandler, /dumpRackIfFinal/);
  assert.doesNotMatch(matchUpdateHandler, /tryCashInBestWord/);
});

test("entrypoint defers auction-won cash-in outside auction result handling", () => {
  const auctionResultHandler = indexSource.match(
    /conn\.db\.auction_result\.onInsert[\s\S]*?\n  \}\);/,
  )?.[0];

  assert.ok(auctionResultHandler);
  assert.match(auctionResultHandler, /scheduleCashInBestWord/);
  assert.doesNotMatch(auctionResultHandler, /tryCashInBestWord/);
});

test("entrypoint logs bid window timing for live latency diagnosis", () => {
  assert.match(indexSource, /remainingMicros/);
  assert.match(indexSource, /nowMicros/);
});

test("entrypoint logs decision context for bids and word choices", () => {
  assert.match(indexSource, /explainPhaseBid/);
  assert.match(indexSource, /bidReason/);
  assert.match(indexSource, /evDiff/);
  assert.match(indexSource, /expectedBalance/);
  assert.match(indexSource, /balanceDelta/);
  assert.match(indexSource, /pressureMultiplier/);
  assert.match(indexSource, /baselineBid/);
  assert.match(indexSource, /usualValue/);
  assert.match(indexSource, /rackFit/);
  assert.match(indexSource, /scoreGap/);
  assert.match(indexSource, /wordReason/);
  assert.match(indexSource, /match_summary/);
});

test("entrypoint logs reducer acknowledgement timing for live latency diagnosis", () => {
  assert.match(indexSource, /sentAtMicros/);
  assert.match(indexSource, /elapsedMs/);
  assert.match(indexSource, /reducer-accepted/);
});

test("entrypoint logs word submission window timing", () => {
  const submitWordFunction = indexSource.match(
    /function submitWordChecked[\s\S]*?\n}\n\nfunction tryCashInBestWord/,
  )?.[0];

  assert.ok(submitWordFunction);
  assert.match(submitWordFunction, /nowMicros/);
  assert.match(submitWordFunction, /remainingMicros/);
});

test("entrypoint uses hot-path logs for bid and auction result events", () => {
  const tryBidStart = indexSource.indexOf("function tryBid");
  const onConnectStart = indexSource.indexOf("function onConnect");
  const tryBidFunction =
    tryBidStart === -1 || onConnectStart === -1
      ? undefined
      : indexSource.slice(tryBidStart, onConnectStart);
  const auctionResultHandler = indexSource.match(
    /conn\.db\.auction_result\.onInsert[\s\S]*?\n  \}\);/,
  )?.[0];

  assert.ok(tryBidFunction);
  assert.ok(auctionResultHandler);
  assert.match(indexSource, /function logHotStatus/);
  assert.match(tryBidFunction, /logHotStatus/);
  assert.match(auctionResultHandler, /logHotStatus/);
});

test("entrypoint hot-path logs avoid global table count scans", () => {
  const hotLoggerStart = indexSource.indexOf("function logHotStatus");
  const errorMessageStart = indexSource.indexOf("function errorMessage");
  const hotLogger =
    hotLoggerStart === -1 || errorMessageStart === -1
      ? undefined
      : indexSource.slice(hotLoggerStart, errorMessageStart);

  assert.ok(hotLogger);
  assert.doesNotMatch(hotLogger, /describeTableCounts/);
});

test("entrypoint logs when the final dump has no playable words", () => {
  assert.match(indexSource, /final dump none/);
});

test("entrypoint resolves dictionary path from a filesystem path", () => {
  assert.match(indexSource, /fileURLToPath/);
  assert.doesNotMatch(indexSource, /new URL\(import\.meta\.url\)\.pathname/);
});

test("entrypoint final dump is gated by the final word window", () => {
  const dumpFunction = indexSource.match(
    /function dumpRackIfFinal[\s\S]*?\n}\n\nfunction tryBid/,
  )?.[0];

  assert.ok(dumpFunction);
  assert.match(dumpFunction, /isFinalWordWindow/);
  assert.doesNotMatch(dumpFunction, /canSubmitWordNow/);
});

test("entrypoint defers final dump while the same rack has a pending word", () => {
  const dumpFunction = indexSource.match(
    /function dumpRackIfFinal[\s\S]*?\n}\n\nfunction tryBid/,
  )?.[0];

  assert.ok(dumpFunction);
  assert.match(dumpFunction, /pendingWordByMatch\.get\(matchKey\)/);
  assert.match(dumpFunction, /pending\.rack === currentRack/);
  assert.match(dumpFunction, /final dump defer/);
  assert.ok(
    dumpFunction.indexOf("final dump defer") <
      dumpFunction.indexOf("finalDumpStartedByMatch.add"),
  );
});

test("entrypoint does not retry the same pending word before an ack", () => {
  assert.match(indexSource, /pending-submission/);
  assert.doesNotMatch(indexSource, /now - pending\.attemptedAtMs/);
});

test("entrypoint waits for rack state after accepted words before another cash-in", () => {
  const wordPlayHandler = indexSource.match(
    /conn\.db\.word_play\.onInsert[\s\S]*?\n  \}\);/,
  )?.[0];

  assert.ok(wordPlayHandler);
  assert.doesNotMatch(wordPlayHandler, /pendingWordByMatch\.delete/);
  assert.doesNotMatch(wordPlayHandler, /tryCashInBestWord/);
});

test("entrypoint schedules guarded cash-in when rack state changes", () => {
  const rackInsertHandler = indexSource.match(
    /conn\.db\.my_rack\.onInsert[\s\S]*?\n  \}\);/,
  )?.[0];
  const rackUpdateHandler = indexSource.match(
    /conn\.db\.my_rack\.onUpdate[\s\S]*?\n  \}\);/,
  )?.[0];

  assert.ok(rackInsertHandler);
  assert.ok(rackUpdateHandler);
  assert.match(rackInsertHandler, /scheduleCashInBestWord/);
  assert.match(rackUpdateHandler, /scheduleCashInBestWord/);
  assert.doesNotMatch(rackInsertHandler, /tryCashInBestWord/);
  assert.doesNotMatch(rackUpdateHandler, /tryCashInBestWord/);
});

test("entrypoint explains available state in status logs", () => {
  assert.match(indexSource, /logStatus/);
  assert.match(indexSource, /describeBotState/);
  assert.match(indexSource, /describeMatchState/);
  assert.match(indexSource, /describeAuctionState/);
  assert.match(indexSource, /describeLobbyState/);
  assert.match(indexSource, /info\("phase"/);
  assert.match(indexSource, /info\("balance"/);
  assert.match(indexSource, /info\("rack"/);
  assert.match(indexSource, /info\("reason"/);
});

test("entrypoint logs stay ASCII-safe for Windows console capture", () => {
  assert.doesNotMatch(indexSource, /â|→|…/);
});
