import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { CONFIG } from "./config.js";
import { rackKey } from "./word_scoring.js";

type TileGainSizeTable = Record<string, string>;

const tileGainCache = new Map<number, TileGainSizeTable | null>();

function precomputedRoot(): string {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    CONFIG.precompute.outputDirSegments[CONFIG.count.increment],
  );
}

function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

const letterPriorTable =
  readJsonFile<Record<string, number>>(
    path.join(precomputedRoot(), CONFIG.precompute.letterPriorFileName),
  ) ?? {};

function tileGainTableForSize(size: number): TileGainSizeTable | null {
  const cached = tileGainCache.get(size);
  if (cached !== undefined) return cached;

  const table = readJsonFile<TileGainSizeTable>(
    path.join(
      precomputedRoot(),
      CONFIG.precompute.tileGainDirName,
      `${CONFIG.precompute.sizeFilePrefix}${size}${CONFIG.precompute.jsonFileExtension}`,
    ),
  );
  tileGainCache.set(size, table);
  return table;
}

function rackSize(rack: Map<string, number>): number {
  return [...rack.values()].reduce(
    (total, count) => total + count,
    CONFIG.count.none,
  );
}

function decodeTileGainVector(vector: string, letter: string): number {
  const index = (CONFIG.precompute.letters as readonly string[]).indexOf(letter);
  if (index < CONFIG.count.none) return CONFIG.count.none;

  const width = CONFIG.precompute.gainEncodingWidth;
  const start = index * width;
  const encoded = vector.slice(start, start + width);
  if (encoded.length !== width) return CONFIG.count.none;

  const decoded = Number.parseInt(encoded, CONFIG.precompute.gainEncodingBase);
  return Number.isFinite(decoded) ? decoded : CONFIG.count.none;
}

export function letterPriorForTile(letter: string): number {
  return letterPriorTable[letter] ?? CONFIG.count.none;
}

export function tileGainForRackTile(
  rack: Map<string, number>,
  letter: string,
): number {
  const table = tileGainTableForSize(rackSize(rack));
  if (!table) return CONFIG.count.none;
  const vector = table[rackKey(rack)];
  if (!vector) return CONFIG.count.none;
  return decodeTileGainVector(vector, letter);
}
