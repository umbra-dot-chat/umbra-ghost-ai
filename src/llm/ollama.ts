/**
 * Ollama LLM provider — calls the local Ollama HTTP API.
 *
 * Chat: POST /api/chat
 * Embed: POST /api/embed
 */

import type { ChatMessage, LLMProvider } from './provider.js';
import type { Logger } from '../config.js';

export class OllamaProvider implements LLMProvider {
  private baseUrl: string;
  private model: string;
  private embedModel: string;
  private log: Logger;

  constructor(baseUrl: string, model: string, embedModel: string, log: Logger) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.embedModel = embedModel;
    this.log = log;
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const startTime = Date.now();
    this.log.debug(`Calling Ollama chat (model: ${this.model}, messages: ${messages.length})`);

    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: false,
          options: {
            temperature: 0.7,
            top_p: 0.9,
            num_predict: 512,
            num_ctx: 4096,
            num_batch: 512,
          },
          keep_alive: -1,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Ollama chat error ${res.status}: ${text}`);
      }

      const data = (await res.json()) as { message: { content: string } };
      const elapsed = Date.now() - startTime;
      this.log.debug(`Ollama response in ${elapsed}ms (${data.message.content.length} chars)`);

      return data.message.content;
    } catch (err) {
      this.log.error('Ollama chat failed:', err);
      return "Sorry, I'm having trouble thinking right now. Try again in a moment! 🤔";
    }
  }

  /**
   * Stream a chat completion from Ollama. Calls `onChunk` with the accumulated
   * response text at throttled intervals (~300ms) so the caller can send
   * progressive updates without flooding the relay.
   */
  async chatStream(
    messages: ChatMessage[],
    onChunk: (accumulated: string) => void,
  ): Promise<string> {
    const startTime = Date.now();
    this.log.debug(`Calling Ollama chat stream (model: ${this.model}, messages: ${messages.length})`);

    try {
      const res = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          messages,
          stream: true,
          options: {
            temperature: 0.7,
            top_p: 0.9,
            num_predict: 512,
            num_ctx: 4096,
            num_batch: 512,
          },
          keep_alive: -1,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Ollama chat stream error ${res.status}: ${text}`);
      }

      let accumulated = '';
      let lastEmitTime = 0;
      const THROTTLE_MS = 300;

      // Ollama streams NDJSON: each line is a JSON object with { message: { content: "token" }, done: bool }
      const body = res.body;
      if (!body) throw new Error('No response body for stream');

      const reader = (body as any).getReader
        ? (body as any).getReader()
        : null;

      if (reader) {
        // Web-style ReadableStream (Node 18+ fetch)
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          // Keep the last potentially incomplete line in the buffer
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const parsed = JSON.parse(line);
              if (parsed.message?.content) {
                accumulated += parsed.message.content;
                const now = Date.now();
                if (now - lastEmitTime >= THROTTLE_MS) {
                  onChunk(accumulated);
                  lastEmitTime = now;
                }
              }
            } catch {
              // Skip malformed lines
            }
          }
        }

        // Process any remaining buffer
        if (buffer.trim()) {
          try {
            const parsed = JSON.parse(buffer);
            if (parsed.message?.content) {
              accumulated += parsed.message.content;
            }
          } catch {
            // ignore
          }
        }
      } else {
        // Fallback: read as text (shouldn't happen but be safe)
        const text = await res.text();
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.message?.content) {
              accumulated += parsed.message.content;
            }
          } catch {
            // skip
          }
        }
      }

      // Final emit
      onChunk(accumulated);

      const elapsed = Date.now() - startTime;
      this.log.debug(`Ollama stream complete in ${elapsed}ms (${accumulated.length} chars)`);

      return accumulated;
    } catch (err) {
      this.log.error('Ollama chat stream failed:', err);
      return "Sorry, I'm having trouble thinking right now. Try again in a moment! 🤔";
    }
  }

  async embed(text: string): Promise<number[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.embedModel,
          input: text,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Ollama embed error ${res.status}: ${errText}`);
      }

      const data = (await res.json()) as { embeddings: number[][] };
      return data.embeddings[0] ?? [];
    } catch (err) {
      this.log.error('Ollama embed failed:', err);
      return [];
    }
  }

  /** Check if Ollama is reachable and the model is available. */
  async healthCheck(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      if (!res.ok) return false;
      const data = (await res.json()) as { models: { name: string }[] };
      const available = data.models.map((m) => m.name.split(':')[0]);
      this.log.info(`Ollama models available: ${available.join(', ')}`);
      return available.includes(this.model) || available.some((m) => m.startsWith(this.model));
    } catch {
      return false;
    }
  }
}
