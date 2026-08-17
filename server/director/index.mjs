/**
 * Direct a song: alignment + preferences in, video plan out.
 *
 * Two passes. The deterministic pass always runs and always produces a
 * shippable plan. The model pass runs only if a key is configured, and can
 * only ever replace individual validated fields of the first pass.
 */

import { directDeterministic } from './deterministic.mjs';
import { refinePlan, directorConfig } from './llm.mjs';

export { directorConfig };

export async function direct({ alignment, lyricsText, prefs = {}, useLlm = true }) {
  const started = Date.now();
  const { plan: basePlan, mood } = directDeterministic({ alignment, lyricsText, prefs });

  const config = directorConfig();
  if (!useLlm || !config.enabled) {
    return {
      plan: basePlan,
      director: {
        source: 'deterministic',
        llm: { used: false, reason: !config.enabled ? 'no API key configured' : 'skipped by request' },
        elapsedMs: Date.now() - started,
      },
    };
  }

  const result = await refinePlan({ alignment, lyricsText, plan: basePlan, prefs, mood, config });

  return {
    plan: result.plan,
    director: {
      source: result.used ? `llm:${config.provider}` : 'deterministic',
      llm: {
        used: result.used,
        provider: result.provider || config.providerName,
        model: result.model || config.model,
        reason: result.reason || null,
        warnings: result.warnings || [],
        usage: result.usage || null,
      },
      elapsedMs: Date.now() - started,
    },
  };
}
