import type { AIProvider, AIProviderConfig, AIProviderName } from './types';
import { DEFAULT_EFFORT, resolveCatalogModel } from './types';
import { AnthropicProvider } from './anthropicProvider';
import { OpenAIProvider } from './openaiProvider';
import { createLogger } from '../../logger';
import {
  NOTES_FAST_MODELS,
  resolveMemoryModel,
  resolveMemoryProvider,
  resolveNotesProvider,
  resolveSettingsPickerEffort,
  resolveSettingsPickerModel,
} from '../../../shared/aiSlots';

const log = createLogger('AI');

let cachedProvider: AIProvider | null = null;
let cachedConfigKey = '';

function configKey(config: AIProviderConfig): string {
  return `${config.provider}:${config.model}:${config.effort ?? ''}:${config.apiKey}`;
}

export function getProvider(config: AIProviderConfig): AIProvider {
  const key = configKey(config);
  if (cachedProvider && cachedConfigKey === key) {
    return cachedProvider;
  }

  switch (config.provider) {
    case 'anthropic':
      cachedProvider = new AnthropicProvider(config.apiKey, config.model, config.effort);
      break;
    case 'openai':
      cachedProvider = new OpenAIProvider(config.apiKey, config.model, config.effort);
      break;
    default:
      throw new Error(`Unknown AI provider: ${config.provider}`);
  }

  cachedConfigKey = key;
  log.info(`Created ${config.provider} provider with model ${config.model} effort ${config.effort ?? 'default'}`);
  return cachedProvider;
}

export function clearProviderCache(): void {
  cachedProvider = null;
  cachedConfigKey = '';
}

/** Cheap notes fallback (Haiku / Luna). Memory uses MEMORY_MODELS, not this. */
export const FAST_MODELS: Record<AIProviderName, string> = NOTES_FAST_MODELS;

function requireApiKey(
  provider: AIProviderName,
  getApiKey: (key: 'openaiApiKey' | 'anthropicApiKey') => string,
): string {
  const apiKey = provider === 'openai'
    ? getApiKey('openaiApiKey')
    : getApiKey('anthropicApiKey');
  if (!apiKey) {
    throw new Error(`No API key configured for ${provider}. Add it in Settings.`);
  }
  return apiKey;
}

/** Live assist: overlay Assist / What should I say / Recap. */
export async function getProviderFromStore(): Promise<AIProvider> {
  const { getSetting, getApiKey } = await import('../../store');

  const provider = (getSetting('aiProvider') || 'anthropic') as AIProviderName;
  const model = resolveCatalogModel(provider, getSetting('aiModel') as string);
  const effort = (getSetting('aiEffort') as string) || DEFAULT_EFFORT;
  const apiKey = requireApiKey(provider, getApiKey);

  return getProvider({ provider, model, apiKey, effort });
}

/** Notes slot: title, summary, insights. Not used for overlay Assist or session memory. */
export async function getNotesProvider(): Promise<AIProvider> {
  const { getSetting, getApiKey } = await import('../../store');

  const provider = resolveNotesProvider(getSetting('notesProvider'), getSetting('aiProvider'));
  const model = resolveSettingsPickerModel(provider, getSetting('notesModel'));
  const effort = resolveSettingsPickerEffort(getSetting('notesEffort'));
  const apiKey = requireApiKey(provider, getApiKey);

  return getProvider({ provider, model, apiKey, effort });
}

/**
 * Session memory compact. Not a Settings slot.
 * Same vendor as Live assist: Sonnet 5 (Anthropic) or GPT-5.6 Terra (OpenAI).
 */
export async function getMemoryProvider(): Promise<AIProvider> {
  const { getSetting, getApiKey } = await import('../../store');

  const provider = resolveMemoryProvider(getSetting('aiProvider'));
  const model = resolveMemoryModel(getSetting('aiProvider'));
  const apiKey = requireApiKey(provider, getApiKey);

  return getProvider({ provider, model, apiKey, effort: DEFAULT_EFFORT });
}

/** @deprecated Use getMemoryProvider. Kept so older callers keep the cheap system model. */
export async function getFastProvider(): Promise<AIProvider> {
  return getMemoryProvider();
}

/** Fast defaults for live cards: latency matters more than depth. */
export const COACH_DEFAULT_MODELS: Record<AIProviderName, string> = {
  anthropic: 'claude-haiku-4-5',
  openai: 'gpt-5.6-luna',
};

/** Deeper defaults for briefs, "think deeper", and post-meeting reports. */
export const DEEP_DEFAULT_MODELS: Record<AIProviderName, string> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5.5',
};

async function getSecondProvider(slot: 'coach' | 'deep'): Promise<{ provider: AIProvider; model: string }> {
  const { getSetting, getApiKey } = await import('../../store');
  const providerName = (getSetting('aiProvider') || 'anthropic') as AIProviderName;
  const requested = (slot === 'coach' ? getSetting('secondCoachModel') : getSetting('secondDeepModel')) as string;
  const fallback = slot === 'coach' ? COACH_DEFAULT_MODELS[providerName] : DEEP_DEFAULT_MODELS[providerName];
  const model = requested ? resolveCatalogModel(providerName, requested) : fallback;
  // Live cards: lowest reasoning effort the model accepts. Deep slot: low.
  const effort = slot === 'coach' ? (providerName === 'openai' ? 'none' : 'low') : 'low';
  const apiKey = requireApiKey(providerName, getApiKey);
  return { provider: getProvider({ provider: providerName, model, apiKey, effort }), model };
}

/** Second live coach: one short structured card per qualifying turn. */
export function getCoachProvider(): Promise<{ provider: AIProvider; model: string }> {
  return getSecondProvider('coach');
}

/** Second deep slot: briefs, explicit "think deeper", post-meeting report. */
export function getDeepProvider(): Promise<{ provider: AIProvider; model: string }> {
  return getSecondProvider('deep');
}
