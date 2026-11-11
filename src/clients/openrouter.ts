import type { RuntimeConfig } from '../config/schema';
import type { HttpClient } from '../http/client';

const LLM_JITTER_MIN_MS = 120;
const LLM_JITTER_MAX_MS = 420;

function randomDelay(min: number, max: number): number {
  if (max <= min) return min;
  return Math.random() * (max - min) + min;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface PluginSpec {
  id: string;
  engine?: string;
  max_results?: number;
  max_output_tokens?: number;
  search_prompt?: string;
}

export interface OpenRouterClientOptions {
  httpClient: HttpClient;
  apiKey: string;
  defaultModel: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  researchProfiles: RuntimeConfig['researchProfiles'];
}

export interface CompletionParams {
  messages: ChatMessage[];
  profile: keyof RuntimeConfig['researchProfiles'];
  model?: string;
  maxTokensOverride?: number;
  temperatureOverride?: number;
  plugins?: PluginSpec[];
}

export interface CompletionResult {
  content: string;
  model: string;
  usage?: UsageStats;
  raw?: unknown;
  citations?: string[];
}

// Legacy /responses path removed; use chat/completions with messages+plugins instead.

export interface UsageStats {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
}

export interface StreamChunk {
  delta: string;
  done: boolean;
  usage?: UsageStats;
}

interface OpenRouterChoice {
  message: {
    role: ChatRole;
    content: string;
  };
}

interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  total_cost?: number;
}

interface OpenRouterResponse {
  id: string;
  model: string;
  choices: OpenRouterChoice[];
  usage?: OpenRouterUsage;
}

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

export class OpenRouterClient {
  private readonly httpClient: HttpClient;
  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly researchProfiles: RuntimeConfig['researchProfiles'];

  constructor({ httpClient, apiKey, defaultModel, baseUrl, headers, researchProfiles }: OpenRouterClientOptions) {
    this.httpClient = httpClient;
    this.apiKey = apiKey;
    this.defaultModel = defaultModel;
    this.baseUrl = baseUrl ?? DEFAULT_BASE_URL;
    this.headers = {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
      ...(headers ?? {})
    };
    this.researchProfiles = researchProfiles;
  }

  async complete({ messages, profile, model, maxTokensOverride, temperatureOverride, plugins }: CompletionParams): Promise<CompletionResult> {
    const profileConfig = this.getProfile(profile);
    const payload = {
      model: model ?? this.defaultModel,
      messages,
      stream: false,
      max_tokens: maxTokensOverride ?? profileConfig.openrouter.maxTokens,
      temperature: temperatureOverride ?? profileConfig.openrouter.temperature,
      plugins: plugins && plugins.length ? plugins : undefined
    };

    await sleep(randomDelay(LLM_JITTER_MIN_MS, LLM_JITTER_MAX_MS));
    const response = await this.httpClient<OpenRouterResponse>(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: this.headers,
      timeoutMs: profileConfig.openrouter.timeoutMs
    });

    const choice = response.choices[0];
    const usage = this.mapUsage(response.usage);

    // Extract citations from common OpenRouter plugin locations (e.g., web/exa)
    const citations = (() => {
      const urls: string[] = [];
      const pushUrl = (u: unknown) => {
        if (typeof u === 'string' && /^https?:\/\//i.test(u)) urls.push(u);
      };
      try {
        const msg: any = choice?.message ?? (response as any)?.choices?.[0]?.message;
        const ann: any[] | undefined = Array.isArray(msg?.annotations) ? msg.annotations as any[] : undefined;
        if (ann) {
          for (const entry of ann) {
            if (entry && entry.type === 'url_citation' && entry.url_citation && typeof entry.url_citation.url === 'string') {
              pushUrl(entry.url_citation.url);
            }
          }
        }
        // Fallback: walk message object for `url` fields
        const walk = (o: any) => {
          if (!o) return;
          if (Array.isArray(o)) { for (const v of o) walk(v); return; }
          if (typeof o === 'object') {
            for (const k of Object.keys(o)) {
              const v = (o as any)[k];
              if (k === 'url') pushUrl(v);
              walk(v);
            }
          }
        };
        walk(msg);
      } catch {
        // ignore extraction errors
      }
      // de-dupe and cap
      return Array.from(new Set(urls)).slice(0, 12);
    })();

    return {
      content: choice?.message.content ?? '',
      model: response.model,
      usage,
      raw: response,
      citations: citations.length ? citations : undefined
    };
  }

  async *streamCompletion({
    messages,
    profile,
    model,
    maxTokensOverride,
    temperatureOverride
  }: CompletionParams): AsyncGenerator<StreamChunk> {
    const profileConfig = this.getProfile(profile);
    const payload = {
      model: model ?? this.defaultModel,
      messages,
      stream: true,
      max_tokens: maxTokensOverride ?? profileConfig.openrouter.maxTokens,
      temperature: temperatureOverride ?? profileConfig.openrouter.temperature
    };

    await sleep(randomDelay(LLM_JITTER_MIN_MS, LLM_JITTER_MAX_MS));
    const response = await this.httpClient<Response>(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: this.headers,
      timeoutMs: profileConfig.openrouter.timeoutMs,
      rawResponse: true,
      parseJson: false
    });

    if (!response.body) {
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let usage: UsageStats | undefined;

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      const chunk = decoder.decode(value, { stream: true });
      const events = chunk.split('\n\n');
      for (const event of events) {
        const dataLine = event.trim().replace(/^data:\s*/iu, '');
        if (!dataLine) continue;
        if (dataLine === '[DONE]') {
          yield {
            delta: '',
            done: true,
            usage
          };
          return;
        }

        try {
          const parsed = JSON.parse(dataLine) as any;
          const choice = parsed.choices?.[0];
          const deltaContent =
            choice?.delta?.content ??
            choice?.message?.content ??
            '';
          if (parsed.usage) {
            usage = this.mapUsage(parsed.usage);
          }
          if (deltaContent) {
            yield {
              delta: deltaContent,
              done: false,
              usage
            };
          }
        } catch {
          continue;
        }
      }
    }

    if (usage) {
      yield {
        delta: '',
        done: true,
        usage
      };
    }
  }

  private mapUsage(usage?: OpenRouterUsage): UsageStats | undefined {
    if (!usage) return undefined;
    return {
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
      estimatedCostUsd: usage.total_cost
    };
  }

  private getProfile(profile: keyof RuntimeConfig['researchProfiles']) {
    const profileConfig = this.researchProfiles[profile];
    if (!profileConfig) {
      throw new Error(`Unknown OpenRouter profile: ${String(profile)}`);
    }
    return profileConfig;
  }

}

export function createOpenRouterClient(options: OpenRouterClientOptions) {
  return new OpenRouterClient(options);
}
