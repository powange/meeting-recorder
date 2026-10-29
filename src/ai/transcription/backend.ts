import type { BackendConfig } from '../../config/index.js';
import type { RawSegment } from '../../domain/transcript.js';
import { assertUrlAllowed, errorSnippet, HostNotAllowedError } from '../../lib/hosts.js';
import { fetchWithTimeout, isTimeout, RedirectError, trimSlash } from '../http.js';

export interface TranscribeOptions {
  language: string;
  prompt?: string | undefined;
}

export interface TranscriptionResult {
  segments: RawSegment[];
  /** Modèle annoncé par le serveur (ou demandé). */
  model: string;
}

export type BackendErrorKind = 'busy' | 'unavailable' | 'timeout' | 'bad_response' | 'rejected';

export class BackendError extends Error {
  constructor(
    message: string,
    readonly kind: BackendErrorKind,
  ) {
    super(message);
    this.name = 'BackendError';
  }
}

export interface TranscriptionBackend {
  readonly name: string;
  readonly concurrency: number;
  /** Vérification rapide (le serveur répond et a un modèle chargé). */
  health(signal?: AbortSignal): Promise<boolean>;
  transcribe(audio: Blob, filename: string, options: TranscribeOptions, signal?: AbortSignal): Promise<TranscriptionResult>;
}

interface VerboseJson {
  text?: string;
  model?: string;
  segments?: Array<{ start: number; end: number; text: string; no_speech_prob?: number }>;
}

/**
 * Client `/v1/audio/transcriptions` (format OpenAI), commun aux deux types de serveur :
 * - `openai` : speaches / faster-whisper… (url incluant /v1, champ `model` utilisé) ;
 * - `vibe` : vibe-server (url sans /v1, modèle préchargé, une requête à la fois → 429 « busy »).
 */
export class HttpTranscriptionBackend implements TranscriptionBackend {
  readonly name: string;
  readonly concurrency: number;
  private readonly base: string;
  /** Modèle chargé annoncé par vibe-server (/ready), qui ne le renvoie pas dans ses transcriptions. */
  private loadedModel: string | undefined;

  constructor(
    private readonly config: BackendConfig,
    /** Hôtes autorisés (ai.allowedHosts), vérifiés avant chaque appel. */
    private readonly allowedHosts: readonly string[] = [],
  ) {
    this.name = config.name;
    this.concurrency = config.type === 'vibe' ? 1 : config.concurrency;
    this.base = config.type === 'vibe' ? `${trimSlash(config.url)}/v1` : trimSlash(config.url);
  }

  async health(signal?: AbortSignal): Promise<boolean> {
    // vibe : /ready répond 503 tant qu'aucun modèle n'est chargé ; openai : /models, ou /health à
    // la racine pour un serveur qui n'a pas /models (serveur HTTP de whisper.cpp).
    if (this.config.type === 'vibe') return (await this.check(`${trimSlash(this.config.url)}/ready`, signal, true)) === true;
    const models = await this.check(`${this.base}/models`, signal);
    if (models !== 404) return models === true;
    return (await this.check(`${this.base.replace(/\/v1$/, '')}/health`, signal)) === true;
  }

  /** Une adresse de santé : vrai si elle répond 2xx, 404 si elle n'existe pas, faux sinon. */
  private async check(url: string, signal: AbortSignal | undefined, readModel = false): Promise<boolean | 404> {
    try {
      await assertUrlAllowed(url, this.allowedHosts);
      const res = await fetchWithTimeout(url, { headers: this.headers() }, this.config.healthTimeoutSec * 1000, signal, this.allowedHosts);
      if (readModel && res.ok) {
        const body = (await res.json().catch(() => ({}))) as { model?: unknown };
        if (typeof body.model === 'string') this.loadedModel = body.model;
      } else {
        await res.body?.cancel();
      }
      if (res.status === 404) return 404;
      return res.ok;
    } catch {
      return false;
    }
  }

  async transcribe(audio: Blob, filename: string, options: TranscribeOptions, signal?: AbortSignal): Promise<TranscriptionResult> {
    const form = new FormData();
    form.append('file', audio, filename);
    form.append('model', this.config.model);
    // « auto » : aucune langue imposée, Whisper la détecte. (Pas de detect_language chez vibe-server :
    // ce champ ne renvoie que la langue détectée, sans transcription.)
    if (options.language !== 'auto') form.append('language', options.language);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
    if (options.prompt) form.append('prompt', options.prompt);

    let res: Response;
    try {
      await assertUrlAllowed(this.base, this.allowedHosts);
      res = await fetchWithTimeout(`${this.base}/audio/transcriptions`, { method: 'POST', body: form, headers: this.headers() }, this.config.timeoutSec * 1000, signal, this.allowedHosts);
    } catch (err) {
      if (err instanceof HostNotAllowedError || err instanceof RedirectError) throw new BackendError(`${this.name} : ${err.message}`, 'rejected');
      if (isTimeout(err) && !signal?.aborted) throw new BackendError(`${this.name} : délai dépassé (${this.config.timeoutSec} s)`, 'timeout');
      throw new BackendError(`${this.name} : injoignable (${err instanceof Error ? err.message : err})`, 'unavailable');
    }

    if (!res.ok) {
      const body = errorSnippet(await res.text().catch(() => ''));
      if (res.status === 429) throw new BackendError(`${this.name} : occupé`, 'busy');
      if (res.status >= 500) throw new BackendError(`${this.name} : erreur ${res.status} ${body}`, 'unavailable');
      throw new BackendError(`${this.name} : requête refusée (${res.status}) ${body}`, 'rejected');
    }

    let json: VerboseJson;
    try {
      json = (await res.json()) as VerboseJson;
    } catch {
      throw new BackendError(`${this.name} : réponse illisible`, 'bad_response');
    }
    const segments: RawSegment[] = Array.isArray(json.segments)
      ? json.segments.map((s) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text ?? ''), noSpeechProb: s.no_speech_prob }))
      : json.text
        ? [{ start: 0, end: 0, text: json.text }]
        : [];
    return { segments, model: json.model ?? this.loadedModel ?? this.config.model };
  }

  private headers(): Record<string, string> {
    return this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {};
  }
}
