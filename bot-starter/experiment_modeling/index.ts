import {
  DbConnection,
  type ErrorContext,
  type EventContext,
} from "../src/module_bindings/index.js";
import { Identity, setGlobalLogLevel, Timestamp } from "spacetimedb";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { CONFIG } from "../src/config.js";
import { chooseWord } from "../src/strategy.js";
import {
  canSubmitWordNow,
  cashInThresholdFor,
  isFinalWordWindow,
  shouldBidOnAuction,
  shouldSubmitWordNow,
} from "../src/word_policy.js";
import { rackKey, scoreWord } from "../src/word_scoring.js";
import { loadPersistentState, savePersistentState } from "./persistentState.js";
import { shouldTrainResiduals } from "./learningPolicy.js";
import type { ResidualDecision } from "./residualLearner.js";
import { explainModelingBid } from "./strategy.js";

const HOST = CONFIG.spacetime.host;
const DB_NAME = CONFIG.spacetime.databaseName;
const BOT_NAME = process.env.BOT_NAME ?? "the-thinker";
const BOT_NONCE = process.env.BOT_NONCE;
const BOT_TOKEN = process.env.BOT_TOKEN;
const TOKEN_PATH = path.join(process.cwd(), `${CONFIG.bot.tokenFilePrefix}${BOT_NAME}`);
const STATE_PATH = path.join(
  process.cwd(),
  ".codex-tmp",
  BOT_NAME,
  "modeling-state.json",
);
const WORD_CAPTURE_STARTED_AT = Timestamp.now();
const LIVE_SUBSCRIPTION_QUERIES: string[] = [
  "SELECT * FROM bot",
  "SELECT * FROM bot_credential",
  "SELECT * FROM lobby",
  "SELECT * FROM lobby_member",
  "SELECT * FROM match_state",
  "SELECT * FROM match_participant",
  "SELECT * FROM auction",
  "SELECT * FROM auction_result",
  "SELECT * FROM my_rack",
  "SELECT * FROM word_play",
];

setGlobalLogLevel(CONFIG.sdk.logLevel);

let myIdentity: Identity | null = null;
let myBotId: bigint | null = null;
let bootstrapStarted = false;

const persistentState = loadPersistentState(STATE_PATH);
const models = persistentState.models;
const learner = persistentState.learner;
const bidsByAuction = new Set<string>();
const scheduledCashInByMatch = new Set<string>();
const submittedWordCounts = new Map<string, number>();
const pendingWordByMatch = new Map<string, { rack: string; word: string }>();
const learnerDecisionsByMatch = new Map<string, ResidualDecision[]>();

function loadToken(): string | undefined {
  if (BOT_TOKEN !== undefined && BOT_TOKEN.trim() !== "") return BOT_TOKEN.trim();
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function saveToken(token: string): void {
  fs.writeFileSync(TOKEN_PATH, token);
}

function persistModelingState(): void {
  try {
    savePersistentState(STATE_PATH, persistentState);
  } catch (error) {
    console.warn(
      `[${BOT_NAME}:experiment_modeling] status=model-save-failed reason=${errorMessage(error)}`,
    );
  }
}

const dictionaryPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  ...CONFIG.dictionary.wordlistPathSegments,
);
const DICTIONARY: string[] = fs.existsSync(dictionaryPath)
  ? fs
      .readFileSync(dictionaryPath, "utf8")
      .split("\n")
      .map((line) => line.trim().toUpperCase())
      .filter((line) => line.length >= CONFIG.dictionary.minWordLength)
  : [];
DICTIONARY.sort((a, b) => scoreWord(b) - scoreWord(a) || b.length - a.length);

function compact(value: unknown): string {
  return String(value).replace(/\s+/g, "_");
}

function info(name: string, value: unknown): string {
  return `${name}=${compact(value)}`;
}

function describeTag(value: { tag: string } | null | undefined): string {
  return value?.tag ?? "none";
}

function describeTimestamp(timestamp: Timestamp | null | undefined): string {
  return timestamp === null || timestamp === undefined
    ? "none"
    : String(timestamp.microsSinceUnixEpoch);
}

function remainingMicrosFor(
  auction: { closesAt?: { microsSinceUnixEpoch: bigint } } | null | undefined,
  nowMicros: bigint,
): bigint | string {
  if (auction?.closesAt === undefined) return "unknown";
  return auction.closesAt.microsSinceUnixEpoch - nowMicros;
}

function resolveMyBotId(conn: DbConnection): bigint | null {
  if (!myIdentity) return null;
  const credential = conn.db.bot_credential.identity.find(myIdentity);
  return credential ? credential.botId : null;
}

function participantForMatch(
  conn: DbConnection,
  matchId: bigint,
): { balance: number; score: number } | null {
  if (myBotId === null) return null;
  for (const participant of conn.db.match_participant.iter()) {
    if (participant.matchId === matchId && participant.botId === myBotId) {
      return {
        balance: Number(participant.balance),
        score: Number(participant.score),
      };
    }
  }
  return null;
}

function participantsForMatch(
  conn: DbConnection,
  matchId: bigint,
): { botId: bigint; balance: number; score: number }[] {
  return Array.from(conn.db.match_participant.iter())
    .filter((participant) => participant.matchId === matchId)
    .map((participant) => ({
      botId: participant.botId,
      balance: Number(participant.balance),
      score: Number(participant.score),
    }));
}

function participantIdsForMatch(conn: DbConnection, matchId: bigint): string[] {
  return Array.from(conn.db.match_participant.iter())
    .filter((participant) => participant.matchId === matchId)
    .map((participant) => String(participant.botId));
}

function playersRemainingForMatch(conn: DbConnection, matchId: bigint): number {
  return participantIdsForMatch(conn, matchId).length;
}

function rememberLearnerDecision(matchId: bigint, decision: ResidualDecision | null): void {
  if (decision === null) return;
  const key = String(matchId);
  const decisions = learnerDecisionsByMatch.get(key) ?? [];
  decisions.push(decision);
  learnerDecisionsByMatch.set(key, decisions);
}

function rewardForEndedMatch(conn: DbConnection, matchId: bigint): number | null {
  if (myBotId === null) return null;
  const participants = participantsForMatch(conn, matchId);
  const me = participants.find((participant) => participant.botId === myBotId);
  if (!me) return null;
  const bestOpponentScore = Math.max(
    0,
    ...participants
      .filter((participant) => participant.botId !== myBotId)
      .map((participant) => participant.score),
  );
  const scoreDelta = me.score - bestOpponentScore;
  const outcomeBonus =
    scoreDelta > 0 ? 0.5 : scoreDelta < 0 ? -0.5 : 0;
  return outcomeBonus + scoreDelta / 200;
}

function updateLearnerForEndedMatch(conn: DbConnection, matchId: bigint): void {
  const key = String(matchId);
  const decisions = learnerDecisionsByMatch.get(key);
  if (decisions === undefined || decisions.length === 0) return;
  if (!shouldTrainResiduals(decisions.length)) {
    learnerDecisionsByMatch.delete(key);
    logStatus(
      conn,
      "learner-skip",
      [
        info("decisions", decisions.length),
        info("reason", "partial-match"),
      ],
      matchId,
    );
    return;
  }
  const reward = rewardForEndedMatch(conn, matchId);
  if (reward === null) return;
  learner.update(decisions, reward);
  learnerDecisionsByMatch.delete(key);
  persistModelingState();
  logStatus(
    conn,
    "learner-update",
    [
      info("decisions", decisions.length),
      info("reward", reward.toFixed(3)),
      info("state", STATE_PATH),
    ],
    matchId,
  );
}

function rackForMatch(conn: DbConnection, matchId: bigint): Map<string, number> {
  const rack = new Map<string, number>();
  for (const holding of conn.db.my_rack.iter()) {
    if (holding.matchId !== matchId) continue;
    rack.set(
      holding.letter,
      (rack.get(holding.letter) ?? CONFIG.count.none) + holding.count,
    );
  }
  return rack;
}

function isMyMatchParticipant(conn: DbConnection, matchId: bigint): boolean {
  if (myBotId === null) return false;
  return Array.from(conn.db.match_participant.iter()).some(
    (participant) => participant.matchId === matchId && participant.botId === myBotId,
  );
}

function isMyRunningMatch(conn: DbConnection, matchId: bigint): boolean {
  if (!isMyMatchParticipant(conn, matchId)) return false;
  const match = conn.db.match_state.id.find(matchId);
  return match?.status.tag === "Running";
}

function currentWindowForMatch(conn: DbConnection, matchId: bigint) {
  const match = conn.db.match_state.id.find(matchId) ?? null;
  const auctionId = match?.currentAuctionId;
  const auction =
    auctionId === undefined || auctionId === null
      ? null
      : conn.db.auction.id.find(auctionId) ?? null;
  return { match, auction };
}

function logStatus(
  conn: DbConnection,
  status: string,
  details: string[] = [],
  matchId?: bigint,
  auctionId?: bigint,
  level: "log" | "warn" | "error" = "log",
): void {
  const line = [
    `[${BOT_NAME}:experiment_modeling]`,
    info("status", status),
    ...details,
    info("botId", myBotId ?? "none"),
    info("match", matchId ?? "none"),
    info("auction", auctionId ?? "none"),
    info("models", models.allExcept(String(myBotId ?? "")).length),
  ].join(" ");
  console[level](line);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function callReducer(
  conn: DbConnection,
  description: string,
  call: () => unknown,
  matchId?: bigint,
  auctionId?: bigint,
  onRejected?: () => void,
): void {
  try {
    const result = call();
    if (result && typeof (result as Promise<unknown>).catch === "function") {
      void (result as Promise<unknown>).catch((error) => {
        onRejected?.();
        logStatus(
          conn,
          "reducer-rejected",
          [info("action", description), info("reason", errorMessage(error))],
          matchId,
          auctionId,
          "warn",
        );
      });
    }
  } catch (error) {
    onRejected?.();
    logStatus(
      conn,
      "reducer-failed",
      [info("action", description), info("reason", errorMessage(error))],
      matchId,
      auctionId,
      "warn",
    );
  }
}

function consumeWord(rack: Map<string, number>, word: string): boolean {
  const needed = new Map<string, number>();
  for (const letter of word) {
    needed.set(letter, (needed.get(letter) ?? 0) + 1);
  }
  for (const [letter, count] of needed) {
    if ((rack.get(letter) ?? 0) < count) return false;
  }
  for (const [letter, count] of needed) {
    const left = (rack.get(letter) ?? 0) - count;
    if (left <= 0) rack.delete(letter);
    else rack.set(letter, left);
  }
  return true;
}

function planFinalDumpWords(rack: Map<string, number>): string[] {
  const remaining = new Map(rack);
  const words: string[] = [];
  while (true) {
    const word = chooseWord({ myRack: remaining, dictionary: DICTIONARY });
    if (!word) return words;
    if (!consumeWord(remaining, word)) return words;
    words.push(word);
  }
}

function wordSubmissionKey(matchId: bigint, word: string): string {
  return `${matchId}:${word.toUpperCase()}`;
}

function rememberSubmittedWord(matchId: bigint, word: string): void {
  const key = wordSubmissionKey(matchId, word);
  submittedWordCounts.set(key, (submittedWordCounts.get(key) ?? 0) + 1);
}

function consumeSubmittedWord(matchId: bigint, word: string): boolean {
  const key = wordSubmissionKey(matchId, word);
  const count = submittedWordCounts.get(key) ?? 0;
  if (count <= 0) return false;
  if (count === 1) submittedWordCounts.delete(key);
  else submittedWordCounts.set(key, count - 1);
  return true;
}

function isWordPlayFromThisRun(playedAt: Timestamp): boolean {
  return (
    playedAt.microsSinceUnixEpoch >= WORD_CAPTURE_STARTED_AT.microsSinceUnixEpoch
  );
}

function submitWordChecked(
  conn: DbConnection,
  matchId: bigint,
  word: string,
  onRejected?: () => void,
): boolean {
  const { match, auction } = currentWindowForMatch(conn, matchId);
  const participant = participantForMatch(conn, matchId);
  const reward = scoreWord(word);
  const threshold =
    match === null || participant === null
      ? "unknown"
      : cashInThresholdFor(match, participant.balance, participant.score);
  if (!canSubmitWordNow(match, auction)) {
    logStatus(
      conn,
      "word-blocked",
      [info("word", word), info("reward", reward), info("threshold", threshold)],
      matchId,
      auction?.id,
      "warn",
    );
    return false;
  }
  callReducer(
    conn,
    `submit word '${word}'`,
    () => {
      rememberSubmittedWord(matchId, word);
      return conn.reducers.submitWord({ matchId, word });
    },
    matchId,
    auction?.id,
    onRejected,
  );
  logStatus(
    conn,
    "word-submit",
    [info("word", word), info("reward", reward), info("threshold", threshold)],
    matchId,
    auction?.id,
  );
  return true;
}

function tryCashInBestWord(conn: DbConnection, matchId: bigint, reason: string): void {
  const { match, auction } = currentWindowForMatch(conn, matchId);
  if (match?.status.tag !== "Running") return;
  const participant = participantForMatch(conn, matchId);
  if (!participant) return;
  const rack = rackForMatch(conn, matchId);
  const word = chooseWord({ myRack: rack, dictionary: DICTIONARY });
  if (!word) return;

  const reward = scoreWord(word);
  if (
    !shouldSubmitWordNow(
      match,
      auction,
      reward,
      participant.balance,
      participant.score,
    )
  ) {
    return;
  }

  const matchKey = String(matchId);
  const currentRack = rackKey(rack);
  const pending = pendingWordByMatch.get(matchKey);
  if (pending?.rack === currentRack && pending.word === word) return;
  pendingWordByMatch.set(matchKey, { rack: currentRack, word });
  logStatus(conn, "word-plan", [info("word", word), info("trigger", reason)], matchId);
  submitWordChecked(conn, matchId, word, () => pendingWordByMatch.delete(matchKey));
}

function scheduleCashInBestWord(
  conn: DbConnection,
  matchId: bigint,
  reason: string,
): void {
  const key = `${matchId}:${reason}`;
  if (scheduledCashInByMatch.has(key)) return;
  scheduledCashInByMatch.add(key);
  setTimeout(() => {
    scheduledCashInByMatch.delete(key);
    tryCashInBestWord(conn, matchId, reason);
  }, CONFIG.live.wordPolicy.cashInDelayMs);
}

function dumpRackIfFinal(conn: DbConnection, matchId: bigint): void {
  const { match, auction } = currentWindowForMatch(conn, matchId);
  if (!isFinalWordWindow(match, auction)) return;
  for (const word of planFinalDumpWords(rackForMatch(conn, matchId))) {
    submitWordChecked(conn, matchId, word);
  }
}

function tryBid(conn: DbConnection, auctionId: bigint, matchId: bigint, letter: string): void {
  if (myBotId === null) return;
  const key = `${matchId}:${auctionId}`;
  if (bidsByAuction.has(key)) return;

  const match = conn.db.match_state.id.find(matchId) ?? null;
  const auction = conn.db.auction.id.find(auctionId) ?? null;
  const nowMicros = Timestamp.now().microsSinceUnixEpoch;
  const remainingMicros = remainingMicrosFor(auction, nowMicros);
  if (!shouldBidOnAuction(match, auction, nowMicros)) {
    if (isFinalWordWindow(match, auction)) dumpRackIfFinal(conn, matchId);
    return;
  }

  const participant = participantForMatch(conn, matchId);
  if (!participant) return;

  const rack = rackForMatch(conn, matchId);
  const playersRemaining = playersRemainingForMatch(conn, matchId);
  const opponents = models.allExcept(String(myBotId));
  const bidContext = {
    letter,
    myBalance: participant.balance,
    myRack: rack,
    round: Number(match?.currentRound ?? 0),
    bagTotal: match === null ? undefined : Number(match.bagTotal),
    dictionary: DICTIONARY,
    useNoBidFloor: true,
    auctionType: describeTag(match?.auctionType) as "FirstPrice" | "Vickrey",
    playersRemaining,
    opponents,
    learner,
    telemetry: true,
  };
  const explanation = explainModelingBid(bidContext);
  const amount = explanation.bid;
  rememberLearnerDecision(matchId, explanation.decision);
  if (amount <= CONFIG.bidding.noBidAmount) {
    logStatus(
      conn,
      "bid-skip",
      [
        info("letter", letter),
        info("amount", amount),
        info("phase", explanation.phase),
        info("self", explanation.selfValue),
        info("denial", Math.round(explanation.phaseAdjustedDenialValue)),
        info("price", explanation.expectedPrice),
        info("base", explanation.lisanBid),
        info("residual", explanation.residual),
        info("remainingMicros", remainingMicros),
      ],
      matchId,
      auctionId,
    );
    bidsByAuction.add(key);
    return;
  }

  callReducer(
    conn,
    `bid ${amount} on '${letter}'`,
    () => conn.reducers.submitBid({ auctionId, amount: BigInt(amount) }),
    matchId,
    auctionId,
  );
  bidsByAuction.add(key);
  logStatus(
    conn,
    "bid-submit",
    [
      info("letter", letter),
      info("amount", amount),
      info("phase", explanation.phase),
      info("self", explanation.selfValue),
      info("denial", Math.round(explanation.phaseAdjustedDenialValue)),
      info("price", explanation.expectedPrice),
      info("base", explanation.lisanBid),
      info("residual", explanation.residual),
      info("balance", participant.balance),
      info("players", playersRemaining),
      info("remainingMicros", remainingMicros),
    ],
    matchId,
    auctionId,
  );
}

function tryBidCurrentAuction(conn: DbConnection, matchId: bigint): void {
  if (!isMyRunningMatch(conn, matchId)) return;
  const { match, auction } = currentWindowForMatch(conn, matchId);
  if (!match || !auction) return;
  tryBid(conn, auction.id, matchId, auction.letter);
}

function joinLobby(conn: DbConnection): void {
  if (myBotId === null) return;
  const inRunning = Array.from(conn.db.match_participant.iter()).some((participant) => {
    if (participant.botId !== myBotId) return false;
    const match = conn.db.match_state.id.find(participant.matchId);
    return match?.status.tag === "Running";
  });
  if (inRunning) return;
  const openLobby = Array.from(conn.db.lobby.iter()).find(
    (lobby) => lobby.status.tag === "Open",
  );
  const alreadyIn =
    openLobby !== undefined &&
    Array.from(conn.db.lobby_member.iter()).some(
      (member) => member.lobbyId === openLobby.id && member.botId === myBotId,
    );
  if (alreadyIn) return;
  logStatus(conn, "lobby-join", [info("reason", "no-running-match")]);
  callReducer(conn, "join lobby", () => conn.reducers.joinLobby({}));
}

function bootstrapActivity(conn: DbConnection): void {
  logStatus(conn, "bootstrap-start");
  joinLobby(conn);
  for (const auction of conn.db.auction.iter()) {
    if (auction.status.tag === "Open" && isMyRunningMatch(conn, auction.matchId)) {
      tryBidCurrentAuction(conn, auction.matchId);
    }
  }
  for (const participant of conn.db.match_participant.iter()) {
    if (participant.botId === myBotId) {
      tryCashInBestWord(conn, participant.matchId, "bootstrap");
      dumpRackIfFinal(conn, participant.matchId);
    }
  }
  logStatus(conn, "bootstrap-finish");
}

function finishCredentialReady(conn: DbConnection): boolean {
  myBotId = resolveMyBotId(conn);
  if (myBotId === null) return false;
  if (bootstrapStarted) return true;
  bootstrapStarted = true;
  logStatus(conn, "credential-ready", [info("botName", BOT_NAME)]);
  bootstrapActivity(conn);
  return true;
}

function onConnect(conn: DbConnection, identity: Identity, token: string): void {
  myIdentity = identity;
  saveToken(token);
  logStatus(conn, "connected", [info("identity", identity.toHexString())]);

  conn
    .subscriptionBuilder()
    .onApplied(() => {
      myBotId = resolveMyBotId(conn);
      if (myBotId === null) {
        if (!BOT_NONCE) {
          logStatus(
            conn,
            "credential-missing",
            [info("reason", "BOT_TOKEN-or-existing-token-or-BOT_NONCE-required")],
            undefined,
            undefined,
            "error",
          );
          process.exit(CONFIG.process.failureExitCode);
        }
        callReducer(conn, "claim credential", () =>
          conn.reducers.claimCredential({ code: BOT_NONCE }),
        );
        setTimeout(() => {
          if (!finishCredentialReady(conn)) {
            logStatus(
              conn,
              "credential-claim-failed",
              [info("reason", "bad-or-expired-nonce")],
              undefined,
              undefined,
              "error",
            );
            process.exit(CONFIG.process.failureExitCode);
          }
        }, CONFIG.credential.claimResolveDelayMs);
        return;
      }
      finishCredentialReady(conn);
    })
    .subscribe(LIVE_SUBSCRIPTION_QUERIES);

  conn.db.bot_credential.onInsert(() => {
    if (myBotId === null) finishCredentialReady(conn);
  });

  conn.db.auction.onInsert((_ctx: EventContext, auction) => {
    if (auction.status.tag === "Open" && isMyRunningMatch(conn, auction.matchId)) {
      tryBidCurrentAuction(conn, auction.matchId);
    }
  });

  conn.db.auction_result.onInsert((_ctx, result) => {
    if (!isMyRunningMatch(conn, result.matchId)) return;
    models.observeAuction(
      participantIdsForMatch(conn, result.matchId),
      result.winnerBotId === undefined || result.winnerBotId === null
        ? null
        : String(result.winnerBotId),
      result.letter,
      Number(result.paid),
    );
    logStatus(
      conn,
      "auction-result",
      [
        info("winner", result.winnerBotId ?? "no-bid"),
        info("letter", result.letter),
        info("paid", result.paid),
      ],
      result.matchId,
      result.auctionId,
    );
    if (result.winnerBotId === myBotId) {
      scheduleCashInBestWord(conn, result.matchId, "auction-won");
    }
    persistModelingState();
  });

  conn.db.word_play.onInsert((_ctx, play) => {
    models.observeWord(String(play.botId), play.word, Number(play.totalReward));
    persistModelingState();
    if (myBotId !== null && play.botId === myBotId && isWordPlayFromThisRun(play.playedAt)) {
      if (!consumeSubmittedWord(play.matchId, play.word)) {
        logStatus(
          conn,
          "external-word-detected",
          [info("word", play.word), info("playedAt", describeTimestamp(play.playedAt))],
          play.matchId,
          undefined,
          "error",
        );
        process.exit(CONFIG.process.failureExitCode);
      }
      logStatus(
        conn,
        "accepted-word",
        [info("word", play.word), info("reward", play.totalReward)],
        play.matchId,
      );
    }
  });

  conn.db.my_rack.onInsert((_ctx, holding) => {
    if (isMyRunningMatch(conn, holding.matchId)) {
      scheduleCashInBestWord(conn, holding.matchId, "rack-insert");
    }
  });
  conn.db.my_rack.onUpdate((_ctx, _old, holding) => {
    if (isMyRunningMatch(conn, holding.matchId)) {
      scheduleCashInBestWord(conn, holding.matchId, "rack-update");
    }
  });

  conn.db.match_state.onInsert((_ctx, match) => {
    if (myBotId !== null && isMyMatchParticipant(conn, match.id)) {
      tryBidCurrentAuction(conn, match.id);
    }
  });
  conn.db.match_state.onUpdate((_ctx, old, next) => {
    if (myBotId === null || !isMyMatchParticipant(conn, next.id)) return;
    tryBidCurrentAuction(conn, next.id);
    dumpRackIfFinal(conn, next.id);
    if (old.status.tag !== "Ended" && next.status.tag === "Ended") {
      updateLearnerForEndedMatch(conn, next.id);
      logStatus(conn, "match-ended-rejoin", [], next.id);
      joinLobby(conn);
    }
  });
}

function main(): void {
  console.log(`[${BOT_NAME}:experiment_modeling] connecting to ${DB_NAME} at ${HOST}`);
  DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(loadToken())
    .withLightMode(true)
    .withConfirmedReads(false)
    .onConnect(onConnect)
    .onConnectError((_ctx: ErrorContext, error: Error) =>
      console.error("connect error:", error.message),
    )
    .onDisconnect(() => console.log(`[${BOT_NAME}:experiment_modeling] disconnected`))
    .build();
}

main();
