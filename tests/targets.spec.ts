import { describe, it, expect } from 'vitest';

import { deriveEffectiveTargets } from '../src/agent/pipeline/targets';
import type { RuntimeConfig } from '../src/config/schema';
import { testRuntime } from './helpers/runtime';

function runtimeWithExits(overrides: Partial<RuntimeConfig['exits']>): RuntimeConfig {
  return testRuntime({
    exits: overrides,
  });
}

describe('deriveEffectiveTargets', () => {
  it('does not raise TP when implied TP% is below maxTakeProfitPct (down-only cap)', () => {
    // expectedPrice=0.5, stored TP=0.6 → implied TP% = +20%
    const runtime = runtimeWithExits({
      priceFloor: 0,
      priceCeiling: 1,
      maxTakeProfitPct: 0.5, // 50% cap, higher than implied 20%
    });

    const { tpOrig, tpEff } = deriveEffectiveTargets(
      {
        expectedPrice: 0.5,
        takeProfitPrice: 0.6,
      },
      runtime,
    );

    expect(tpOrig).toBeCloseTo(0.6, 6);
    // With down-only semantics, effective TP stays at 0.6, not raised to 0.75.
    expect(tpEff).toBeCloseTo(0.6, 6);
  });

  it('clamps TP down when implied TP% exceeds maxTakeProfitPct', () => {
    // expectedPrice=0.5, stored TP=0.9 → implied TP% = +80%
    const runtime = runtimeWithExits({
      priceFloor: 0,
      priceCeiling: 1,
      maxTakeProfitPct: 0.3, // 30% cap, lower than implied 80%
    });

    const { tpOrig, tpEff } = deriveEffectiveTargets(
      {
        expectedPrice: 0.5,
        takeProfitPrice: 0.9,
      },
      runtime,
    );

    expect(tpOrig).toBeCloseTo(0.9, 6);
    // Effective TP should be capped at 0.5 * (1 + 0.3) = 0.65.
    expect(tpEff).toBeCloseTo(0.65, 6);
  });

  it('respects priceCeiling for effective TP on existing positions', () => {
    // expectedPrice close to 1 with an aggressive stored TP; priceCeiling=0.98
    const runtime = runtimeWithExits({
      priceFloor: 0,
      priceCeiling: 0.98,
      maxTakeProfitPct: 0.5,
    });

    const { tpEff } = deriveEffectiveTargets(
      {
        expectedPrice: 0.97,
        takeProfitPrice: 0.999,
      },
      runtime,
    );

    // Effective TP should not exceed the ceiling and should be quantized.
    expect(tpEff).toBeLessThanOrEqual(0.98 + 1e-9);
    expect(tpEff).toBeCloseTo(0.98, 3);
  });

  it('uses exits.takeProfitPct as default TP and maxTakeProfitPct as a pure cap when no stored TP is present', () => {
    const runtime = runtimeWithExits({
      priceFloor: 0,
      priceCeiling: 1,
      takeProfitPct: 0.3,
      maxTakeProfitPct: 0.25,
    });

    const { tpOrig, tpEff } = deriveEffectiveTargets(
      {
        expectedPrice: 0.4,
      },
      runtime,
    );

    expect(tpOrig).toBeUndefined();
    // Default TP% (=0.3) is capped down to maxTakeProfitPct (=0.25):
    // 0.4 * (1 + 0.25) = 0.5.
    expect(tpEff).toBeCloseTo(0.5, 6);
  });
});
