import { harness, saveAt as baseSaveAt, stepAt, DAY } from '../career/helpers';
import type { CareerSave } from '../../src/career';
import { newTrainee } from '../../src/career';
import { createRng } from '../../src/core/rng';

export { harness, stepAt };
export const NIGHT = DAY + 22 * 3600;

/** A patrol officer assigned as an FTO with a trainee already created. */
export function saveAt(): CareerSave {
  const save = baseSaveAt('patrol');
  save.assignment = 'fto';
  save.trainee = newTrainee(createRng(3), ['Avery', 'Blake']);
  return save;
}
