export interface InferredRack {
  letters: Map<string, number>;
}

const VOWELS = new Set(["A", "E", "I", "O", "U"]);
const COMMON_EXTENDERS = new Set(["S", "E", "R", "T", "N", "L", "D"]);
const AWKWARD_TILES = new Set(["Q", "J", "X", "Z"]);

export function createInferredRack(): InferredRack {
  return { letters: new Map<string, number>() };
}

export function addWonLetter(rack: InferredRack, letter: string): void {
  const normalized = letter.toUpperCase();
  rack.letters.set(normalized, (rack.letters.get(normalized) ?? 0) + 1);
}

export function removePlayedWord(rack: InferredRack, word: string): void {
  for (const raw of word.toUpperCase()) {
    const count = rack.letters.get(raw) ?? 0;
    if (count <= 1) rack.letters.delete(raw);
    else rack.letters.set(raw, count - 1);
  }
}

export function inferredRackSize(rack: InferredRack): number {
  let total = 0;
  for (const count of rack.letters.values()) total += count;
  return total;
}

export function probabilityOpponentNeeds(rack: InferredRack, letter: string): number {
  const normalized = letter.toUpperCase();
  const size = inferredRackSize(rack);
  if (size === 0) return COMMON_EXTENDERS.has(normalized) ? 0.35 : 0.2;

  let vowels = 0;
  for (const [held, count] of rack.letters.entries()) {
    if (VOWELS.has(held)) vowels += count;
  }
  const consonants = size - vowels;
  const vowelRatio = vowels / size;

  let probability = 0.2;
  if (VOWELS.has(normalized) && vowelRatio < 0.35) probability += 0.35;
  if (!VOWELS.has(normalized) && consonants < vowels) probability += 0.25;
  if (normalized === "S") probability += 0.3;
  if (COMMON_EXTENDERS.has(normalized)) probability += 0.15;
  if (AWKWARD_TILES.has(normalized) && !rack.letters.has("U")) probability -= 0.15;
  if (size >= 6) probability += 0.1;

  return Math.max(0, Math.min(1, probability));
}
