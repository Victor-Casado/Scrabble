import * as fs from "node:fs";
import * as path from "node:path";

import {
  OpponentModelStore,
  type SerializedOpponentModelStore,
} from "./opponentModel.js";
import {
  createResidualLearner,
  deserializeResidualLearner,
  serializeResidualLearner,
  type ResidualLearner,
  type SerializedResidualLearner,
} from "./residualLearner.js";

export interface PersistentState {
  learner: ResidualLearner;
  models: OpponentModelStore;
}

interface SerializedPersistentState {
  version: 1;
  learner: SerializedResidualLearner;
  models: SerializedOpponentModelStore;
}

export function createEmptyPersistentState(): PersistentState {
  return {
    learner: createResidualLearner(),
    models: new OpponentModelStore(),
  };
}

export function loadPersistentState(file: string): PersistentState {
  if (!fs.existsSync(file)) return createEmptyPersistentState();
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as SerializedPersistentState;
  return {
    learner: deserializeResidualLearner(parsed.learner),
    models: OpponentModelStore.fromJSON(parsed.models),
  };
}

export function savePersistentState(file: string, state: PersistentState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const serialized: SerializedPersistentState = {
    version: 1,
    learner: serializeResidualLearner(state.learner),
    models: state.models.toJSON(),
  };
  fs.writeFileSync(file, `${JSON.stringify(serialized, null, 2)}\n`);
}
