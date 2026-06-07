// ScrabbleBot bot starter.
//
// First run (claim an existing bot credential):
//   1. From the website, your existing team mints a nonce. Or from CLI:
//      `spacetime call scrabblebot mint_credential_nonce`
//      `spacetime sql 'SELECT code FROM my_nonces ORDER BY expires_at DESC'`
//   2. Run the bot with the nonce:
//      `BOT_NONCE=<code> npm start`
//      The bot connects fresh, redeems the nonce, and persists its token
//      to .token (so future runs don't need the nonce).
//
// Subsequent runs:
//   `npm start`  -- uses the saved token.
//
// Edit ./src/strategy.ts to customise how your bot bids and plays words.

import {
  DbConnection,
  type EventContext,
  type ErrorContext,
} from "./module_bindings/index.js";
import { Identity, setGlobalLogLevel, Timestamp } from "spacetimedb";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG } from "./config.js";
import { chooseWord, decideBid } from "./strategy.js";
import {
  canSubmitWordNow,
  cashInThresholdFor,
  isFinalWordWindow,
  shouldBidOnAuction,
  shouldSubmitWordNow,
} from "./word_policy.js";
import { explainPhaseBid, selectLivePhase } from "./phase_strategy.js";
import { rackKey, scoreWord } from "./word_scoring.js";

const HOST = CONFIG.spacetime.host;
const DB_NAME = CONFIG.spacetime.databaseName;
const BOT_NAME = CONFIG.bot.name;
const BOT_NONCE = CONFIG.bot.nonce;
const TOKEN_PATH = path.join(process.cwd(), `${CONFIG.bot.tokenFilePrefix}${BOT_NAME}`);
const WORD_CAPTURE_STARTED_AT = Timestamp.now();
const LIVE_SUBSCRIPTION_QUERIES: string[] = [
  "SELECT * FROM bot",
  "SELECT * FROM bot_credential",
  "SELECT * FROM lobby",
  "SELECT * FROM lobby_member",
  "SELECT * FROM match_state",
  "SELECT * FROM match_participant",
  "SELECT * FROM auction",
  "SELECT * FROM my_rack",
  "SELECT * FROM word_play",
];

setGlobalLogLevel(CONFIG.sdk.logLevel);

function loadToken(): string | undefined {
  try {
    return fs.readFileSync(TOKEN_PATH, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}
function saveToken(tok: string) {
  fs.writeFileSync(TOKEN_PATH, tok);
}

// Load the shared wordlist so the bot can pick playable words locally.
const dictionaryPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  ...CONFIG.dictionary.wordlistPathSegments,
);
const DICTIONARY: string[] = fs.existsSync(dictionaryPath)
  ? fs
      .readFileSync(dictionaryPath, "utf8")
      .split("\n")
      .map((l) => l.trim().toUpperCase())
      .filter((l) => l.length >= CONFIG.dictionary.minWordLength)
  : [];
DICTIONARY.sort((a, b) => scoreWord(b) - scoreWord(a) || b.length - a.length);

let myIdentity: Identity | null = null;
let myBotId: bigint | null = null;
const bidsByAuction = new Set<string>();
const finalDumpStartedByMatch = new Set<string>();
const scheduledCashInByMatch = new Set<string>();
const submittedWordCounts = new Map<string, number>();
const pendingWordByMatch = new Map<
  string,
  { rack: string; word: string }
>();
let bootstrapStarted = false;

function resolveMyBotId(conn: DbConnection): bigint | null {
  if (!myIdentity) return null;
  const cred = conn.db.bot_credential.identity.find(myIdentity);
  return cred ? cred.botId : null;
}

function rackForMatch(conn: DbConnection, matchId: bigint): Map<string, number> {
  const rack = new Map<string, number>();
  for (const h of conn.db.my_rack.iter()) {
    if (h.matchId !== matchId) continue;
    rack.set(h.letter, (rack.get(h.letter) ?? CONFIG.count.none) + h.count);
  }
  return rack;
}

function participantForMatch(
  conn: DbConnection,
  matchId: bigint,
): { balance: number; score: number } | null {
  if (myBotId === null) return null;
  for (const p of conn.db.match_participant.iter()) {
    if (p.matchId !== matchId) continue;
    if (p.botId !== myBotId) continue;
    return { balance: Number(p.balance), score: Number(p.score) };
  }
  return null;
}

function participantCountForMatch(conn: DbConnection, matchId: bigint): number {
  return Array.from(conn.db.match_participant.iter()).filter(
    (participant) => participant.matchId === matchId,
  ).length;
}

function isMyMatchParticipant(conn: DbConnection, matchId: bigint): boolean {
  if (myBotId === null) return false;
  for (const p of conn.db.match_participant.iter()) {
    if (p.matchId === matchId && p.botId === myBotId) return true;
  }
  return false;
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

function consumeWord(rack: Map<string, number>, word: string): boolean {
  const needed = new Map<string, number>();
  for (const letter of word) {
    needed.set(letter, (needed.get(letter) ?? CONFIG.count.none) + CONFIG.count.increment);
  }
  for (const [letter, count] of needed) {
    if ((rack.get(letter) ?? CONFIG.count.none) < count) return false;
  }
  for (const [letter, count] of needed) {
    const left = (rack.get(letter) ?? CONFIG.count.none) - count;
    if (left <= CONFIG.count.none) rack.delete(letter);
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

function describeRack(rack: Map<string, number>): string {
  const contents = [...rack.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([letter, count]) => `${letter}${count}`)
    .join("");
  return contents || "empty";
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

function describeTag(value: { tag: string } | null | undefined): string {
  return value?.tag ?? "none";
}

function compact(value: unknown): string {
  return String(value).replace(/\s+/g, "_");
}

function info(name: string, value: unknown): string {
  return `${name}=${compact(value)}`;
}

function scoreGap(score: number): number {
  return Math.max(CONFIG.count.none, CONFIG.live.wordPolicy.targetScore - score);
}

function countRows<T>(rows: Iterable<T>): number {
  return Array.from(rows).length;
}

function describeBotState(conn: DbConnection): string {
  const bot = myBotId === null ? null : conn.db.bot.id.find(myBotId);
  const credential =
    myIdentity === null ? null : conn.db.bot_credential.identity.find(myIdentity);
  return [
    info("identity", myIdentity?.toHexString() ?? "none"),
    info("botId", myBotId ?? "none"),
    info("botName", bot?.name ?? "none"),
    info("botStrategy", describeTag(bot?.strategy)),
    info("credential", credential === null ? "missing" : "present"),
    info("connected", credential?.connected ?? "unknown"),
  ].join(" ");
}

function describeTableCounts(conn: DbConnection): string {
  return [
    info("bots", countRows(conn.db.bot.iter())),
    info("lobbies", countRows(conn.db.lobby.iter())),
    info("matches", countRows(conn.db.match_state.iter())),
    info("auctions", countRows(conn.db.auction.iter())),
    info("results", countRows(conn.db.auction_result.iter())),
    info("wordPlays", countRows(conn.db.word_play.iter())),
  ].join(" ");
}

function describeLobbyState(conn: DbConnection): string {
  const openLobby = Array.from(conn.db.lobby.iter()).find(
    (l) => l.status.tag === "Open",
  );
  if (openLobby === undefined) return "lobby=none";
  const members = Array.from(conn.db.lobby_member.iter()).filter(
    (member) => member.lobbyId === openLobby.id,
  );
  const amInLobby =
    myBotId !== null && members.some((member) => member.botId === myBotId);
  return [
    info("lobby", openLobby.id),
    info("lobbyStatus", describeTag(openLobby.status)),
    info("lobbyMembers", members.length),
    info("lobbyMax", openLobby.maxSize),
    info("lobbyAuction", describeTag(openLobby.auctionType)),
    info("lobbyClosesAt", describeTimestamp(openLobby.closesAt)),
    info("amInLobby", amInLobby),
  ].join(" ");
}

function selectedMatchId(conn: DbConnection, matchId?: bigint): bigint | null {
  if (matchId !== undefined) return matchId;
  if (myBotId === null) return null;
  for (const participant of conn.db.match_participant.iter()) {
    if (participant.botId !== myBotId) continue;
    const match = conn.db.match_state.id.find(participant.matchId);
    if (match?.status.tag === "Running") return participant.matchId;
  }
  return null;
}

function describeMatchState(conn: DbConnection, matchId?: bigint): string {
  const resolvedMatchId = selectedMatchId(conn, matchId);
  if (resolvedMatchId === null) return "match=none";
  const match = conn.db.match_state.id.find(resolvedMatchId) ?? null;
  const participant = participantForMatch(conn, resolvedMatchId);
  const rack = rackForMatch(conn, resolvedMatchId);
  const phase =
    match === null ? "none" : selectLivePhase(Number(match.currentRound));
  return [
    info("match", resolvedMatchId),
    info("matchStatus", describeTag(match?.status)),
    info("round", match?.currentRound ?? "none"),
    info("phase", phase),
    info("bag", match?.bagTotal ?? "none"),
    info("currentAuction", match?.currentAuctionId ?? "none"),
    info("auctionType", describeTag(match?.auctionType)),
    info("balance", participant?.balance ?? "none"),
    info("score", participant?.score ?? "none"),
    info("rack", describeRack(rack)),
  ].join(" ");
}

function selectedAuctionId(
  conn: DbConnection,
  auctionId?: bigint,
  matchId?: bigint,
): bigint | null {
  if (auctionId !== undefined) return auctionId;
  const resolvedMatchId = selectedMatchId(conn, matchId);
  if (resolvedMatchId === null) return null;
  const match = conn.db.match_state.id.find(resolvedMatchId);
  return match?.currentAuctionId ?? null;
}

function describeAuctionState(
  conn: DbConnection,
  auctionId?: bigint,
  matchId?: bigint,
): string {
  const resolvedAuctionId = selectedAuctionId(conn, auctionId, matchId);
  if (resolvedAuctionId === null) return "auction=none";
  const auction = conn.db.auction.id.find(resolvedAuctionId) ?? null;
  return [
    info("auction", resolvedAuctionId),
    info("auctionMatch", auction?.matchId ?? "none"),
    info("letter", auction?.letter ?? "none"),
    info("auctionStatus", describeTag(auction?.status)),
    info("opensAt", describeTimestamp(auction?.opensAt)),
    info("closesAt", describeTimestamp(auction?.closesAt)),
  ].join(" ");
}

function logStatus(
  conn: DbConnection,
  status: string,
  details: string[] = [],
  matchId?: bigint,
  auctionId?: bigint,
  level: "log" | "warn" | "error" = "log",
) {
  const line = [
    `[${BOT_NAME}]`,
    info("status", status),
    ...details,
    describeBotState(conn),
    describeLobbyState(conn),
    describeMatchState(conn, matchId),
    describeAuctionState(conn, auctionId, matchId),
    describeTableCounts(conn),
  ].join(" ");
  console[level](line);
}

function logHotStatus(
  conn: DbConnection,
  status: string,
  details: string[] = [],
  matchId?: bigint,
  auctionId?: bigint,
  level: "log" | "warn" | "error" = "log",
) {
  const line = [
    `[${BOT_NAME}]`,
    info("status", status),
    ...details,
    describeBotState(conn),
    describeMatchState(conn, matchId),
    describeAuctionState(conn, auctionId, matchId),
  ].join(" ");
  console[level](line);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isWordPlayFromThisRun(playedAt: Timestamp): boolean {
  return (
    playedAt.microsSinceUnixEpoch >= WORD_CAPTURE_STARTED_AT.microsSinceUnixEpoch
  );
}

function wordSubmissionKey(matchId: bigint, word: string): string {
  return `${matchId}:${word.toUpperCase()}`;
}

function rememberSubmittedWord(matchId: bigint, word: string): void {
  const key = wordSubmissionKey(matchId, word);
  submittedWordCounts.set(
    key,
    (submittedWordCounts.get(key) ?? CONFIG.count.none) + CONFIG.count.increment,
  );
}

function consumeSubmittedWord(matchId: bigint, word: string): boolean {
  const key = wordSubmissionKey(matchId, word);
  const count = submittedWordCounts.get(key) ?? CONFIG.count.none;
  if (count <= CONFIG.count.none) return false;
  const remaining = count - CONFIG.count.increment;
  if (remaining <= CONFIG.count.none) submittedWordCounts.delete(key);
  else submittedWordCounts.set(key, remaining);
  return true;
}

function callReducer(
  conn: DbConnection,
  description: string,
  call: () => unknown,
  matchId?: bigint,
  auctionId?: bigint,
  onRejected?: () => void,
  logMode: "full" | "hot" = "full",
): void {
  const logReducerStatus = logMode === "hot" ? logHotStatus : logStatus;
  const sentAtMs = Date.now();
  const sentAtMicros = Timestamp.now().microsSinceUnixEpoch;
  const reducerTiming = () => [
    info("action", description),
    info("sentAtMicros", sentAtMicros),
    info("elapsedMs", Date.now() - sentAtMs),
  ];
  try {
    const result = call();
    if (result && typeof (result as Promise<unknown>).catch === "function") {
      void (result as Promise<unknown>)
        .then(() => {
          logReducerStatus(
            conn,
            "reducer-accepted",
            reducerTiming(),
            matchId,
            auctionId,
          );
        })
        .catch((error) => {
          onRejected?.();
          logReducerStatus(
            conn,
            "reducer-rejected",
            [...reducerTiming(), info("reason", errorMessage(error))],
            matchId,
            auctionId,
            "warn",
          );
        });
    }
  } catch (error) {
    onRejected?.();
    logReducerStatus(
      conn,
      "reducer-failed",
      [...reducerTiming(), info("reason", errorMessage(error))],
      matchId,
      auctionId,
      "warn",
    );
  }
}

function finishCredentialReady(conn: DbConnection, status = "credential-ready"): boolean {
  myBotId = resolveMyBotId(conn);
  if (myBotId === null) return false;
  if (bootstrapStarted) return true;
  bootstrapStarted = true;
  const bot = conn.db.bot.id.find(myBotId);
  logStatus(conn, status, [info("botName", bot?.name ?? "none")]);
  bootstrapActivity(conn);
  return true;
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
  const cashInThreshold =
    match === null || participant === null
      ? "unknown"
      : cashInThresholdFor(match, participant.balance, participant.score);
  if (!canSubmitWordNow(match, auction)) {
    logStatus(
      conn,
      "word-blocked",
      [
        info("word", word),
        info("reward", reward),
        info("threshold", cashInThreshold),
        info("scoreGap", participant === null ? "unknown" : scoreGap(participant.score)),
        info("wordReason", "submit-blocked"),
        info("reason", "non-final-window"),
      ],
      matchId,
      auction?.id,
      "warn",
    );
    return false;
  }
  const nowMicros = Timestamp.now().microsSinceUnixEpoch;
  logStatus(
    conn,
    "submitting word",
    [
      info("word", word),
      info("reward", reward),
      info("threshold", cashInThreshold),
      info("scoreGap", participant === null ? "unknown" : scoreGap(participant.score)),
      info("wordReason", "submit"),
      info("nowMicros", nowMicros),
      info("remainingMicros", remainingMicrosFor(auction, nowMicros)),
    ],
    matchId,
    auction?.id,
  );
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
  return true;
}

function tryCashInBestWord(conn: DbConnection, matchId: bigint, reason: string) {
  const { match, auction } = currentWindowForMatch(conn, matchId);
  if (match?.status.tag !== "Running") return;
  const participant = participantForMatch(conn, matchId);
  if (!participant) return;
  const rack = rackForMatch(conn, matchId);
  const word = chooseWord({ myRack: rack, dictionary: DICTIONARY });
  const cashInThreshold = cashInThresholdFor(match, participant.balance, participant.score);
  if (!word) {
    logStatus(
      conn,
      "word-skip",
      [
        info("wordReason", "no-playable-word"),
        info("threshold", cashInThreshold),
        info("scoreGap", scoreGap(participant.score)),
        info("trigger", reason),
      ],
      matchId,
      auction?.id,
    );
    return;
  }

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
    logStatus(
      conn,
      "word-skip",
      [
        info("word", word),
        info("reward", reward),
        info("threshold", cashInThreshold),
        info("scoreGap", scoreGap(participant.score)),
        info("wordReason", "below-cash-in-threshold"),
        info("reason", "below-cash-in-threshold"),
        info("trigger", reason),
      ],
      matchId,
      auction?.id,
    );
    return;
  }

  const matchKey = String(matchId);
  const currentRack = rackKey(rack);
  const pending = pendingWordByMatch.get(matchKey);
  if (
    pending !== undefined &&
    pending.rack === currentRack &&
    pending.word === word
  ) {
    logStatus(
      conn,
      "word-skip",
      [
        info("word", word),
        info("reward", reward),
        info("threshold", cashInThreshold),
        info("scoreGap", scoreGap(participant.score)),
        info("wordReason", "pending-submission"),
        info("reason", "pending-submission"),
        info("trigger", reason),
      ],
      matchId,
      auction?.id,
    );
    return;
  }

  pendingWordByMatch.set(matchKey, {
    rack: currentRack,
    word,
  });
  submitWordChecked(conn, matchId, word, () => pendingWordByMatch.delete(matchKey));
}

function scheduleCashInBestWord(
  conn: DbConnection,
  matchId: bigint,
  reason: string,
) {
  const key = `${matchId}:${reason}`;
  if (scheduledCashInByMatch.has(key)) return;
  scheduledCashInByMatch.add(key);
  setTimeout(() => {
    scheduledCashInByMatch.delete(key);
    tryCashInBestWord(conn, matchId, reason);
  }, CONFIG.live.wordPolicy.cashInDelayMs);
}

function dumpRackIfFinal(conn: DbConnection, matchId: bigint) {
  const matchKey = String(matchId);
  if (finalDumpStartedByMatch.has(matchKey)) return;
  const { match, auction } = currentWindowForMatch(conn, matchId);
  if (!isFinalWordWindow(match, auction)) return;

  const rack = rackForMatch(conn, matchId);
  const currentRack = rackKey(rack);
  const pending = pendingWordByMatch.get(matchKey);
  if (pending !== undefined && pending.rack === currentRack) {
    logStatus(
      conn,
      "final dump defer",
      [info("reason", "pending-word"), info("word", pending.word)],
      matchId,
      auction?.id,
    );
    return;
  }

  const words = planFinalDumpWords(rack);

  finalDumpStartedByMatch.add(matchKey);
  if (words.length === CONFIG.collection.emptyLength) {
    logStatus(
      conn,
      "final dump none",
      [info("reason", "no-playable-words")],
      matchId,
      auction?.id,
    );
    return;
  }

  logStatus(
    conn,
    "final dump",
    [
      info("words", words.join(",")),
      info("wordCount", words.length),
      info(
        "plannedReward",
        words.reduce<number>(
          (total, word) => total + scoreWord(word),
          CONFIG.count.none,
        ),
      ),
      info("wordReason", "final-dump"),
    ],
    matchId,
    auction?.id,
  );
  for (const word of words) {
    submitWordChecked(conn, matchId, word);
  }
}

function tryBid(conn: DbConnection, auctionId: bigint, matchId: bigint, letter: string) {
  if (myBotId === null) {
    logHotStatus(
      conn,
      "bid-skip",
      [info("letter", letter), info("reason", "bot-id-unresolved")],
      matchId,
      auctionId,
    );
    return;
  }
  const key = `${matchId}:${auctionId}`;
  if (bidsByAuction.has(key)) {
    logHotStatus(
      conn,
      "bid-skip",
      [info("letter", letter), info("reason", "already-bid")],
      matchId,
      auctionId,
    );
    return;
  }
  const match = conn.db.match_state.id.find(matchId) ?? null;
  const auction = conn.db.auction.id.find(auctionId) ?? null;
  const nowMicros = Timestamp.now().microsSinceUnixEpoch;
  const remainingMicros = remainingMicrosFor(auction, nowMicros);
  if (!shouldBidOnAuction(match, auction, nowMicros)) {
    const reason = isFinalWordWindow(match, auction)
      ? "final-word-window"
      : "stale-or-closed-auction";
    logHotStatus(
      conn,
      "bid-skip",
      [
        info("letter", letter),
        info("reason", reason),
        info("nowMicros", nowMicros),
        info("remainingMicros", remainingMicros),
      ],
      matchId,
      auctionId,
    );
    if (reason === "final-word-window") dumpRackIfFinal(conn, matchId);
    return;
  }
  const participant = participantForMatch(conn, matchId);
  if (!participant) {
    logHotStatus(
      conn,
      "bid-skip",
      [info("letter", letter), info("reason", "not-participant")],
      matchId,
      auctionId,
    );
    return;
  }
  const rack = rackForMatch(conn, matchId);
  const bidContext = {
    letter,
    myBalance: participant.balance,
    myRack: rack,
    round: Number(match?.currentRound ?? CONFIG.count.none),
    bagTotal: match === null ? undefined : Number(match.bagTotal),
    dictionary: DICTIONARY,
    useNoBidFloor: true,
    auctionType: describeTag(match?.auctionType) as "FirstPrice" | "Vickrey",
    playerCount: participantCountForMatch(conn, matchId),
  };
  const bidExplanation = explainPhaseBid(bidContext);
  const amount = decideBid(bidContext);
  if (amount <= CONFIG.bidding.noBidAmount) {
    logHotStatus(
      conn,
      "bid-skip",
      [
        info("letter", letter),
        info("amount", amount),
        info("explainedBid", bidExplanation.bid),
        info("bidReason", bidExplanation.reason),
        info("evDiff", bidExplanation.evDiff),
        info("expectedBalance", bidExplanation.expectedBalance),
        info("balanceDelta", bidExplanation.balanceDelta),
        info("pressureMultiplier", bidExplanation.pressureMultiplier),
        info("baselineBid", bidExplanation.baselineBid),
        info("usualValue", bidExplanation.usualLetterValue),
        info("rackFit", bidExplanation.rackFitValue),
        info("value", bidExplanation.value),
        info("cap", bidExplanation.cap),
        info("reserve", bidExplanation.reserveBalance),
        info("scoreGap", scoreGap(participant.score)),
        info("decisionMismatch", amount !== bidExplanation.bid),
        info("reason", "strategy-no-bid"),
      ],
      matchId,
      auctionId,
    );
    return;
  }
  callReducer(
    conn,
    `bid ${amount} on '${letter}'`,
    () => conn.reducers.submitBid({ auctionId, amount: BigInt(amount) }),
    matchId,
    auctionId,
    undefined,
    "hot",
  );
  bidsByAuction.add(key);
  logHotStatus(
    conn,
    "bid-submit",
    [
      info("letter", letter),
      info("amount", amount),
      info("explainedBid", bidExplanation.bid),
      info("bidReason", bidExplanation.reason),
      info("evDiff", bidExplanation.evDiff),
      info("expectedBalance", bidExplanation.expectedBalance),
      info("balanceDelta", bidExplanation.balanceDelta),
      info("pressureMultiplier", bidExplanation.pressureMultiplier),
      info("baselineBid", bidExplanation.baselineBid),
      info("usualValue", bidExplanation.usualLetterValue),
      info("rackFit", bidExplanation.rackFitValue),
      info("value", bidExplanation.value),
      info("cap", bidExplanation.cap),
      info("reserve", bidExplanation.reserveBalance),
      info("scoreGap", scoreGap(participant.score)),
      info("decisionMismatch", amount !== bidExplanation.bid),
      info("phase", match === null ? "none" : selectLivePhase(Number(match.currentRound))),
      info("balance", participant.balance),
      info("rack", describeRack(rack)),
      info("nowMicros", nowMicros),
      info("remainingMicros", remainingMicros),
    ],
    matchId,
    auctionId,
  );
}

function tryBidCurrentAuction(
  conn: DbConnection,
  matchId: bigint,
  _trigger: string,
) {
  if (!isMyRunningMatch(conn, matchId)) return;
  const { match, auction } = currentWindowForMatch(conn, matchId);
  if (!match || !auction) return;
  tryBid(conn, auction.id, matchId, auction.letter);
}

function onConnect(conn: DbConnection, identity: Identity, token: string) {
  myIdentity = identity;
  saveToken(token);
  logStatus(conn, "connected", [info("identity", identity.toHexString())]);

  conn
    .subscriptionBuilder()
    .onApplied(() => {
      logStatus(conn, "subscription-applied");

      // Resolve our bot id, possibly after claiming a nonce.
      myBotId = resolveMyBotId(conn);
      if (myBotId === null) {
        if (BOT_NONCE) {
          logStatus(conn, "credential-claim", [info("reason", "nonce-present")]);
          callReducer(
            conn,
            "claim credential",
            () => conn.reducers.claimCredential({ code: BOT_NONCE }),
          );
          // Wait briefly for the credential to land; check again.
          setTimeout(() => {
            myBotId = resolveMyBotId(conn);
            if (myBotId === null) {
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
            const bot = conn.db.bot.id.find(myBotId);
            logStatus(
              conn,
              "credential-claimed",
              [info("botName", bot?.name ?? "none")],
            );
            bootstrapActivity(conn);
          }, CONFIG.credential.claimResolveDelayMs);
          return;
        } else {
          logStatus(
            conn,
            "credential-missing",
            [info("reason", "existing-token-or-BOT_NONCE-required")],
            undefined,
            undefined,
            "error",
          );
          process.exit(CONFIG.process.failureExitCode);
        }
      }

      finishCredentialReady(conn);
    })
    .subscribe(LIVE_SUBSCRIPTION_QUERIES);

  conn.db.auction.onInsert((_ctx: EventContext, a) => {
    if (a.status.tag !== "Open") return;
    if (!isMyRunningMatch(conn, a.matchId)) return;
    tryBidCurrentAuction(conn, a.matchId, "auction-insert");
  });
  conn.db.bot_credential.onInsert(() => {
    if (myBotId === null) finishCredentialReady(conn, "credential-ready");
  });
  conn.db.auction_result.onInsert((_ctx, r) => {
    if (myBotId === null) return;
    if (!isMyRunningMatch(conn, r.matchId)) return;
    const winner =
      r.winnerBotId !== undefined && r.winnerBotId !== null
        ? String(r.winnerBotId)
        : "no-bid";
    logHotStatus(
      conn,
      "auction-result",
      [
        info("winner", winner),
        info("paid", r.paid),
        info("letter", r.letter),
      ],
      r.matchId,
      r.auctionId,
    );
    if (r.winnerBotId === myBotId) {
      scheduleCashInBestWord(conn, r.matchId, "auction-won");
    }
  });
  conn.db.word_play.onInsert((_ctx, play) => {
    if (myBotId === null || play.botId !== myBotId) return;
    if (!isWordPlayFromThisRun(play.playedAt)) return;
    if (!consumeSubmittedWord(play.matchId, play.word)) {
      logStatus(
        conn,
        "external-word-detected",
        [
          info("word", play.word),
          info("reward", play.totalReward),
          info("playedAt", describeTimestamp(play.playedAt)),
          info("reason", "not-submitted-by-this-process"),
        ],
        play.matchId,
        undefined,
        "error",
      );
      process.exit(CONFIG.process.failureExitCode);
    }
    logStatus(
      conn,
      "accepted word",
      [
        info("word", play.word),
        info("reward", play.totalReward),
        info("playedAt", describeTimestamp(play.playedAt)),
      ],
      play.matchId,
    );
    // The word play event can arrive before rack deltas, so wait for the next
    // match or auction update before reconsidering another word.
  });
  conn.db.my_rack.onInsert((_ctx, holding) => {
    if (!isMyRunningMatch(conn, holding.matchId)) return;
    scheduleCashInBestWord(conn, holding.matchId, "rack-insert");
  });
  conn.db.my_rack.onUpdate((_ctx, _old, holding) => {
    if (!isMyRunningMatch(conn, holding.matchId)) return;
    scheduleCashInBestWord(conn, holding.matchId, "rack-update");
  });

  conn.db.match_state.onInsert((_ctx, match) => {
    if (myBotId === null) return;
    if (!isMyMatchParticipant(conn, match.id)) return;
    tryBidCurrentAuction(conn, match.id, "match-insert");
  });

  // When a match this bot was in ends, hop back into the lobby.
  conn.db.match_state.onUpdate((_ctx, old, neu) => {
    if (myBotId === null) return;
    if (!isMyMatchParticipant(conn, neu.id)) return;
    tryBidCurrentAuction(conn, neu.id, "match-update");
    dumpRackIfFinal(conn, neu.id);
    if (old.status.tag !== "Ended" && neu.status.tag === "Ended") {
      const wasIn = Array.from(conn.db.match_participant.iter()).some(
        (p) => p.matchId === neu.id && p.botId === myBotId,
      );
      if (wasIn) {
        const participant = participantForMatch(conn, neu.id);
        logStatus(
          conn,
          "match_summary",
          [
            info("reason", "match-ended"),
            info("finalScore", participant?.score ?? "none"),
            info("finalBalance", participant?.balance ?? "none"),
            info("targetScore", CONFIG.live.wordPolicy.targetScore),
            info(
              "scoreGap",
              participant === null ? "unknown" : scoreGap(participant.score),
            ),
          ],
          neu.id,
        );
        logStatus(
          conn,
          "match-ended-rejoin",
          [info("reason", "match-ended")],
          neu.id,
        );
        joinLobby(conn);
      }
    }
  });
}

function joinLobby(conn: DbConnection) {
  if (myBotId === null) {
    logStatus(conn, "lobby-skip", [info("reason", "bot-id-unresolved")]);
    return;
  }
  const inRunning = Array.from(conn.db.match_participant.iter()).some((p) => {
    if (p.botId !== myBotId) return false;
    const m = conn.db.match_state.id.find(p.matchId);
    return m?.status.tag === "Running";
  });
  if (inRunning) {
    logStatus(conn, "lobby-skip", [info("reason", "already-running")]);
    return;
  }
  const openLobby = Array.from(conn.db.lobby.iter()).find(
    (l) => l.status.tag === "Open",
  );
  const alreadyIn =
    openLobby !== undefined &&
    Array.from(conn.db.lobby_member.iter()).some(
      (lm) => lm.lobbyId === openLobby.id && lm.botId === myBotId,
    );
  if (alreadyIn) {
    logStatus(conn, "lobby-skip", [info("reason", "already-in-lobby")]);
    return;
  }
  logStatus(conn, "lobby-join", [info("reason", "no-running-match")]);
  callReducer(conn, "join lobby", () => conn.reducers.joinLobby({}));
}

function bootstrapActivity(conn: DbConnection) {
  logStatus(conn, "bootstrap-start");
  joinLobby(conn);
  for (const a of conn.db.auction.iter()) {
    if (a.status.tag === "Open" && isMyRunningMatch(conn, a.matchId)) {
      tryBidCurrentAuction(conn, a.matchId, "bootstrap-auction");
    }
  }
  for (const p of conn.db.match_participant.iter()) {
    if (p.botId === myBotId) tryCashInBestWord(conn, p.matchId, "bootstrap");
    if (p.botId === myBotId) dumpRackIfFinal(conn, p.matchId);
  }
  logStatus(conn, "bootstrap-finish");
}

function main() {
  console.log(`[${BOT_NAME}] connecting to ${DB_NAME} at ${HOST}`);
  DbConnection.builder()
    .withUri(HOST)
    .withDatabaseName(DB_NAME)
    .withToken(loadToken())
    .withLightMode(true)
    .withConfirmedReads(false)
    .onConnect(onConnect)
    .onConnectError((_ctx: ErrorContext, err: Error) =>
      console.error("connect error:", err.message),
    )
    .onDisconnect(() => console.log("disconnected"))
    .build();
}

main();
