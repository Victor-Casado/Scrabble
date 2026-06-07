import { CONFIG } from "./config.js";

type StatusTag = { tag: string };
type TimestampLike = { microsSinceUnixEpoch: bigint };

export interface MatchWindowState {
  status: StatusTag;
  currentAuctionId: bigint | null | undefined;
  bagTotal: number;
}

export interface AuctionWindowState {
  id: bigint;
  matchId: bigint;
  status: StatusTag;
  closesAt?: TimestampLike;
}

export function isFinalWordWindow(
  match: MatchWindowState | null | undefined,
  auction: AuctionWindowState | null | undefined,
): boolean {
  if (!match || !auction) return false;
  return (
    match.status.tag === "Running" &&
    auction.status.tag === "Open" &&
    match.currentAuctionId === auction.id &&
    match.bagTotal <= CONFIG.finalWindow.bagTotal
  );
}

export function canSubmitWordNow(
  match: MatchWindowState | null | undefined,
  _auction: AuctionWindowState | null | undefined,
): boolean {
  return match?.status.tag === "Running";
}

export function shouldSubmitWordNow(
  match: MatchWindowState | null | undefined,
  auction: AuctionWindowState | null | undefined,
  wordScore: number,
  balance?: number,
  currentScore?: number,
): boolean {
  if (match?.status.tag !== "Running") return false;
  if (wordScore <= CONFIG.bidding.noBidAmount) return false;
  if (isFinalWordWindow(match, auction)) return true;
  return wordScore >= cashInThresholdFor(match, balance, currentScore);
}

export function cashInThresholdFor(
  match: MatchWindowState,
  balance?: number,
  currentScore?: number,
): number {
  if (
    CONFIG.live.wordPolicy.emergencyCashInEnabled &&
    balance !== undefined &&
    balance <= CONFIG.live.wordPolicy.emergencyBalance
  ) {
    return CONFIG.live.wordPolicy.emergencyMinScore;
  }
  if (
    currentScore !== undefined &&
    currentScore < CONFIG.live.wordPolicy.targetScore
  ) {
    if (match.bagTotal <= CONFIG.live.wordPolicy.lateCatchUpBagTotal) {
      return CONFIG.live.wordPolicy.lateCatchUpMinScore;
    }
    if (match.bagTotal <= CONFIG.live.wordPolicy.catchUpBagTotal) {
      return CONFIG.live.wordPolicy.catchUpMinScore;
    }
  }
  return CONFIG.live.wordPolicy.cashInMinScore;
}

export function shouldBidOnAuction(
  match: MatchWindowState | null | undefined,
  auction: AuctionWindowState | null | undefined,
  nowMicros?: bigint,
): boolean {
  if (!match || !auction) return false;
  if (match.status.tag !== "Running") return false;
  if (auction.status.tag !== "Open") return false;
  if (match.currentAuctionId !== auction.id) return false;
  if (isFinalWordWindow(match, auction)) return false;
  if (nowMicros !== undefined && auction.closesAt !== undefined) {
    const remaining = auction.closesAt.microsSinceUnixEpoch - nowMicros;
    if (remaining <= CONFIG.auction.minBidLeadTimeMicros) return false;
  }
  return true;
}
