import { classifyOpponent, type Classification } from "./classification.js";
import {
  addWonLetter,
  createInferredRack,
  inferredRackSize,
  removePlayedWord,
  type InferredRack,
} from "./rackInference.js";

const VOWELS = new Set(["A", "E", "I", "O", "U"]);

export interface OpponentModel {
  id: string;

  auctionsSeen: number;
  auctionsWon: number;

  averageBidEstimate: number;

  vowelAggression: number;
  consonantAggression: number;

  sPreference: number;

  averageWordLength: number;

  playFrequency: number;

  hoardingScore: number;

  classification: Classification;

  inferredRack: InferredRack;
}

export interface PublicAuctionObservation {
  letter: string;
  won: boolean;
  paid: number;
}

export interface PublicWordObservation {
  word: string;
  reward: number;
}

export interface SerializedOpponentModel {
  id: string;
  auctionsSeen: number;
  auctionsWon: number;
  averageBidEstimate: number;
  vowelAggression: number;
  consonantAggression: number;
  sPreference: number;
  averageWordLength: number;
  playFrequency: number;
  hoardingScore: number;
  classification: Classification;
  inferredRack: [string, number][];
}

export interface SerializedOpponentModelStore {
  version: 1;
  models: SerializedOpponentModel[];
}

export function createOpponentModel(id: string): OpponentModel {
  return {
    id,
    auctionsSeen: 0,
    auctionsWon: 0,
    averageBidEstimate: 0,
    vowelAggression: 0,
    consonantAggression: 0,
    sPreference: 0,
    averageWordLength: 0,
    playFrequency: 0,
    hoardingScore: 0,
    classification: "unknown",
    inferredRack: createInferredRack(),
  };
}

function runningAverage(current: number, countBefore: number, sample: number): number {
  return (current * countBefore + sample) / (countBefore + 1);
}

function recomputeDerived(model: OpponentModel): void {
  const rackSize = inferredRackSize(model.inferredRack);
  model.playFrequency =
    model.auctionsSeen === 0 ? 0 : Math.min(1, model.averageWordLength === 0 ? 0 : model.auctionsWon / model.auctionsSeen);
  model.hoardingScore = Math.max(0, rackSize - model.playFrequency * 4);
  model.classification = classifyOpponent(model);
}

export function updateModelForAuctionResult(
  model: OpponentModel,
  observation: PublicAuctionObservation,
): void {
  const letter = observation.letter.toUpperCase();
  const winsBefore = model.auctionsWon;
  model.auctionsSeen += 1;

  if (observation.won) {
    model.auctionsWon += 1;
    addWonLetter(model.inferredRack, letter);

    if (observation.paid > 0) {
      model.averageBidEstimate = runningAverage(
        model.averageBidEstimate,
        winsBefore,
        observation.paid,
      );
    }

    if (VOWELS.has(letter)) {
      model.vowelAggression = runningAverage(model.vowelAggression, winsBefore, 1);
    } else {
      model.consonantAggression = runningAverage(
        model.consonantAggression,
        winsBefore,
        1,
      );
    }
    if (letter === "S") {
      model.sPreference = runningAverage(model.sPreference, winsBefore, 1);
    }
  }

  recomputeDerived(model);
}

export function updateModelForWordPlay(
  model: OpponentModel,
  observation: PublicWordObservation,
): void {
  const playsBefore =
    model.averageWordLength === 0
      ? 0
      : Math.max(1, Math.round(model.playFrequency * Math.max(1, model.auctionsSeen)));
  model.averageWordLength = runningAverage(
    model.averageWordLength,
    playsBefore,
    observation.word.length,
  );
  removePlayedWord(model.inferredRack, observation.word);
  model.playFrequency = Math.min(1, (playsBefore + 1) / Math.max(1, model.auctionsSeen));
  model.hoardingScore = Math.max(
    0,
    inferredRackSize(model.inferredRack) - model.playFrequency * 4,
  );
  model.classification = classifyOpponent(model);
}

export class OpponentModelStore {
  private readonly models = new Map<string, OpponentModel>();

  get(id: string): OpponentModel {
    let model = this.models.get(id);
    if (!model) {
      model = createOpponentModel(id);
      this.models.set(id, model);
    }
    return model;
  }

  allExcept(id: string): OpponentModel[] {
    return [...this.models.values()].filter((model) => model.id !== id);
  }

  observeAuction(
    participantIds: string[],
    winnerId: string | null,
    letter: string,
    paid: number,
  ): void {
    for (const participantId of participantIds) {
      updateModelForAuctionResult(this.get(participantId), {
        letter,
        won: participantId === winnerId,
        paid: participantId === winnerId ? paid : 0,
      });
    }
  }

  observeWord(botId: string, word: string, reward: number): void {
    updateModelForWordPlay(this.get(botId), { word, reward });
  }

  toJSON(): SerializedOpponentModelStore {
    return {
      version: 1,
      models: [...this.models.values()].map((model) => ({
        id: model.id,
        auctionsSeen: model.auctionsSeen,
        auctionsWon: model.auctionsWon,
        averageBidEstimate: model.averageBidEstimate,
        vowelAggression: model.vowelAggression,
        consonantAggression: model.consonantAggression,
        sPreference: model.sPreference,
        averageWordLength: model.averageWordLength,
        playFrequency: model.playFrequency,
        hoardingScore: model.hoardingScore,
        classification: model.classification,
        inferredRack: [...model.inferredRack.letters.entries()],
      })),
    };
  }

  static fromJSON(serialized: SerializedOpponentModelStore): OpponentModelStore {
    const store = new OpponentModelStore();
    for (const serializedModel of serialized.models ?? []) {
      const model = createOpponentModel(serializedModel.id);
      model.auctionsSeen = Math.max(0, Number(serializedModel.auctionsSeen ?? 0));
      model.auctionsWon = Math.max(0, Number(serializedModel.auctionsWon ?? 0));
      model.averageBidEstimate = Number(serializedModel.averageBidEstimate ?? 0);
      model.vowelAggression = Number(serializedModel.vowelAggression ?? 0);
      model.consonantAggression = Number(serializedModel.consonantAggression ?? 0);
      model.sPreference = Number(serializedModel.sPreference ?? 0);
      model.averageWordLength = Number(serializedModel.averageWordLength ?? 0);
      model.playFrequency = Number(serializedModel.playFrequency ?? 0);
      model.hoardingScore = Number(serializedModel.hoardingScore ?? 0);
      model.classification = serializedModel.classification ?? "unknown";
      model.inferredRack.letters = new Map(
        (serializedModel.inferredRack ?? []).map(([letter, count]) => [
          letter.toUpperCase(),
          Math.max(0, Number(count)),
        ]),
      );
      store.models.set(model.id, model);
    }
    return store;
  }
}
