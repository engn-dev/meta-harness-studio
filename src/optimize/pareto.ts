/**
 * Multi-objective Pareto frontier.
 *
 * The paper optimizes a population against multiple objectives (e.g. accuracy vs
 * context cost) and reports the non-dominated frontier rather than a single
 * winner — the headline result was *equal accuracy at 4x fewer tokens*. We keep
 * that: the user picks the operating point off the frontier.
 */
export type Direction = 'max' | 'min';

export interface Objective {
  key: string;
  direction: Direction;
}

/** Does `a` dominate `b`? (at least as good on all objectives, strictly better on one) */
export function dominates(
  a: Record<string, number>,
  b: Record<string, number>,
  objectives: Objective[],
): boolean {
  let strictlyBetter = false;
  for (const obj of objectives) {
    const av = a[obj.key] ?? 0;
    const bv = b[obj.key] ?? 0;
    const aBetter = obj.direction === 'max' ? av > bv : av < bv;
    const aWorse = obj.direction === 'max' ? av < bv : av > bv;
    if (aWorse) return false;
    if (aBetter) strictlyBetter = true;
  }
  return strictlyBetter;
}

export interface FrontierItem<T> {
  id: string;
  metrics: Record<string, number>;
  item: T;
}

/** The non-dominated subset. */
export function paretoFrontier<T>(items: FrontierItem<T>[], objectives: Objective[]): FrontierItem<T>[] {
  return items.filter(
    (candidate) =>
      !items.some(
        (other) => other.id !== candidate.id && dominates(other.metrics, candidate.metrics, objectives),
      ),
  );
}

const KNOWN_DIRECTIONS: Record<string, Direction> = {
  pass_rate: 'max',
  context_tokens: 'min',
  wall_clock_s: 'min',
  usd: 'min',
};

export function objectivesFrom(keys: string[]): Objective[] {
  return keys.map((key) => ({ key, direction: KNOWN_DIRECTIONS[key] ?? 'max' }));
}
