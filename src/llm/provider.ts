/**
 * LLM provider interface — abstracts chat completion and embedding APIs.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMProvider {
  /** Generate a chat completion. */
  chat(messages: ChatMessage[]): Promise<string>;
  /**
   * Stream a chat completion, calling `onChunk` with the accumulated text
   * at throttled intervals. Returns the final complete text.
   * Optional — falls back to `chat()` when not implemented.
   */
  chatStream?(messages: ChatMessage[], onChunk: (accumulated: string) => void): Promise<string>;
  /** Generate an embedding vector for text. */
  embed(text: string): Promise<number[]>;
}
