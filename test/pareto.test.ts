import { describe, it, expect } from 'vitest';
import { dominates, paretoFrontier, objectivesFrom, type FrontierItem } from '../src/optimize/pareto.js';

const OBJS = objectivesFrom(['pass_rate', 'context_tokens', 'wall_clock_s', 'usd']);

describe('Pareto math', () => {
  it('maps known objective keys to the correct directions', () => {
    expect(OBJS).toEqual([
      { key: 'pass_rate', direction: 'max' },
      { key: 'context_tokens', direction: 'min' },
      { key: 'wall_clock_s', direction: 'min' },
      { key: 'usd', direction: 'min' },
    ]);
  });

  it('dominates: equal pass-rate at fewer tokens strictly dominates', () => {
    const a = { pass_rate: 1, context_tokens: 100, wall_clock_s: 0, usd: 0 };
    const b = { pass_rate: 1, context_tokens: 200, wall_clock_s: 0, usd: 0 };
    expect(dominates(a, b, OBJS)).toBe(true);
    expect(dominates(b, a, OBJS)).toBe(false);
  });

  it('dominates: a point never dominates itself (must be strictly better on one axis)', () => {
    const a = { pass_rate: 1, context_tokens: 100, wall_clock_s: 0, usd: 0 };
    expect(dominates(a, a, OBJS)).toBe(false);
  });

  it('dominates: a trade-off (higher pass-rate but more tokens) is incomparable', () => {
    const a = { pass_rate: 1, context_tokens: 200, wall_clock_s: 0, usd: 0 };
    const b = { pass_rate: 0.5, context_tokens: 100, wall_clock_s: 0, usd: 0 };
    expect(dominates(a, b, OBJS)).toBe(false);
    expect(dominates(b, a, OBJS)).toBe(false);
  });

  it('paretoFrontier keeps exactly the non-dominated subset', () => {
    const mk = (id: string, pass: number, tok: number): FrontierItem<null> => ({
      id,
      metrics: { pass_rate: pass, context_tokens: tok, wall_clock_s: 0, usd: 0 },
      item: null,
    });
    const pop = [
      mk('a', 1, 100), // non-dominated (best tokens at full pass)
      mk('b', 1, 200), // dominated by a
      mk('c', 0.5, 50), // non-dominated (cheapest, lower pass — a trade-off)
    ];
    const frontier = paretoFrontier(pop, OBJS).map((f) => f.id).sort();
    expect(frontier).toEqual(['a', 'c']);
  });
});
