// @ts-check

export const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

export const API_BASE = 'https://generativelanguage.googleapis.com';

/** @type {Readonly<Record<string, ModelInfo>>} */
export const MODELS = Object.freeze({
  'gemini-3.5-flash-lite': {
    id: 'gemini-3.5-flash-lite',
    label: 'Gemini 3.5 Flash-Lite (recommended)',
    inUsd: 0.30,
    outUsd: 2.50,
    gen: 3,
  },
  'gemini-3.1-flash-lite': {
    id: 'gemini-3.1-flash-lite',
    label: 'Gemini 3.1 Flash-Lite (about 30% cheaper; shuts down 7 May 2027)',
    inUsd: 0.25,
    outUsd: 1.50,
    gen: 3,
  },
  'gemini-2.5-flash-lite': {
    id: 'gemini-2.5-flash-lite',
    label: 'Gemini 2.5 Flash-Lite (cheapest; only for keys that used it before Sep 2026)',
    inUsd: 0.10,
    outUsd: 0.40,
    gen: 2,
  },
});

export const MODEL_ID_RE = /^[a-z0-9][a-z0-9.-]{1,62}$/;

/**
 * @param {Pick<Settings, 'model' | 'customModel'>} s
 * @returns {ModelInfo}
 */
export function resolveModel(s) {
  if (s.model !== 'custom') return MODELS[s.model] ?? MODELS[DEFAULT_MODEL];
  const id = MODEL_ID_RE.test(s.customModel) ? s.customModel : DEFAULT_MODEL;
  if (MODELS[id]) return MODELS[id];
  return { id, label: id, inUsd: 1.50, outUsd: 7.50, gen: /^gemini-[12]\./.test(id) ? 2 : 3 };
}
