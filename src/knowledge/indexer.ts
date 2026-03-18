/**
 * Codebase knowledge indexer — walks the repo, chunks files, generates embeddings.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join, extname, relative } from 'path';
import Database from 'better-sqlite3';
import type { LLMProvider } from '../llm/provider.js';
import type { Logger } from '../config.js';

// File extensions to index
const INDEXABLE_EXTENSIONS = new Set([
  '.rs', '.ts', '.tsx', '.js', '.jsx', '.json', '.toml', '.md',
  '.sql', '.css', '.html', '.yaml', '.yml', '.sh',
]);

// Directories to skip
const SKIP_DIRS = new Set([
  'node_modules', 'target', 'dist', 'build', '.git', '.next',
  '.expo', '.cache', 'coverage', '__pycache__', '.turbo',
]);

// Max file size to index (500KB)
const MAX_FILE_SIZE = 500 * 1024;

// Chunk settings
const CHUNK_SIZE = 400; // ~400 tokens worth of lines
const CHUNK_OVERLAP = 50; // overlap lines

export interface CodeChunk {
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  content: string;
}

/**
 * Initialize the knowledge database tables.
 */
export function initKnowledgeDb(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS code_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      start_line INTEGER,
      end_line INTEGER,
      language TEXT,
      content TEXT NOT NULL,
      last_modified INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_path ON code_chunks(file_path);

    CREATE TABLE IF NOT EXISTS code_embeddings (
      chunk_id INTEGER PRIMARY KEY,
      embedding BLOB NOT NULL,
      FOREIGN KEY (chunk_id) REFERENCES code_chunks(id)
    );

    CREATE TABLE IF NOT EXISTS index_meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

/**
 * Walk the codebase directory and collect all indexable files.
 */
function walkDir(dir: string, basePath: string): string[] {
  const files: string[] = [];

  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      if (entry.startsWith('.')) continue;

      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          files.push(...walkDir(fullPath, basePath));
        } else if (stat.isFile() && stat.size <= MAX_FILE_SIZE) {
          const ext = extname(entry).toLowerCase();
          if (INDEXABLE_EXTENSIONS.has(ext)) {
            files.push(fullPath);
          }
        }
      } catch { /* skip unreadable files */ }
    }
  } catch { /* skip unreadable dirs */ }

  return files;
}

/**
 * Split a file into overlapping chunks.
 */
function chunkFile(filePath: string, basePath: string): CodeChunk[] {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const lines = content.split('\n');
  const relPath = relative(basePath, filePath);
  const ext = extname(filePath).slice(1);
  const language = ext === 'rs' ? 'rust' : ext === 'tsx' ? 'typescript' : ext === 'ts' ? 'typescript' : ext;

  const chunks: CodeChunk[] = [];

  // Small files get one chunk
  if (lines.length <= CHUNK_SIZE) {
    chunks.push({
      filePath: relPath,
      startLine: 1,
      endLine: lines.length,
      language,
      content: `// File: ${relPath}\n${content}`,
    });
    return chunks;
  }

  // Split into overlapping chunks
  for (let start = 0; start < lines.length; start += CHUNK_SIZE - CHUNK_OVERLAP) {
    const end = Math.min(start + CHUNK_SIZE, lines.length);
    const chunkLines = lines.slice(start, end);
    chunks.push({
      filePath: relPath,
      startLine: start + 1,
      endLine: end,
      language,
      content: `// File: ${relPath} (lines ${start + 1}-${end})\n${chunkLines.join('\n')}`,
    });

    if (end >= lines.length) break;
  }

  return chunks;
}

/**
 * Cosine similarity between two vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dotProduct / denominator;
}

/**
 * Full codebase indexer class.
 */
export class CodebaseIndexer {
  private db: Database.Database;
  private llm: LLMProvider;
  private codebasePath: string;
  private log: Logger;

  constructor(db: Database.Database, llm: LLMProvider, codebasePath: string, log: Logger) {
    this.db = db;
    this.llm = llm;
    this.codebasePath = codebasePath;
    this.log = log;
    initKnowledgeDb(db);
  }

  /**
   * Index the entire codebase (or re-index changed files).
   */
  async indexCodebase(): Promise<void> {
    if (!existsSync(this.codebasePath)) {
      this.log.warn(`Codebase path not found: ${this.codebasePath}`);
      return;
    }

    this.log.info(`Indexing codebase: ${this.codebasePath}`);
    const files = walkDir(this.codebasePath, this.codebasePath);
    this.log.info(`Found ${files.length} indexable files`);

    // Collect all chunks
    const allChunks: CodeChunk[] = [];
    for (const file of files) {
      const chunks = chunkFile(file, this.codebasePath);
      allChunks.push(...chunks);
    }
    this.log.info(`Generated ${allChunks.length} code chunks`);

    // Clear existing data and re-index
    this.db.exec('DELETE FROM code_embeddings');
    this.db.exec('DELETE FROM code_chunks');

    // Insert chunks
    const insertChunk = this.db.prepare(`
      INSERT INTO code_chunks (file_path, start_line, end_line, language, content, last_modified)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const insertEmbedding = this.db.prepare(`
      INSERT INTO code_embeddings (chunk_id, embedding)
      VALUES (?, ?)
    `);

    let embedded = 0;
    const batchSize = 10;

    for (let i = 0; i < allChunks.length; i += batchSize) {
      const batch = allChunks.slice(i, i + batchSize);

      for (const chunk of batch) {
        const result = insertChunk.run(
          chunk.filePath, chunk.startLine, chunk.endLine,
          chunk.language, chunk.content, Date.now()
        );

        // Generate embedding
        try {
          const embedding = await this.llm.embed(chunk.content.slice(0, 2000)); // Limit embed input
          if (embedding.length > 0) {
            const buffer = Buffer.from(new Float32Array(embedding).buffer);
            insertEmbedding.run(result.lastInsertRowid, buffer);
            embedded++;
          }
        } catch {
          // Skip embedding failures
        }
      }

      if (i % 100 === 0 && i > 0) {
        this.log.info(`Indexed ${i}/${allChunks.length} chunks (${embedded} embedded)`);
      }
    }

    // Save index metadata
    this.db.prepare('INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)')
      .run('last_indexed', new Date().toISOString());
    this.db.prepare('INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)')
      .run('total_chunks', String(allChunks.length));

    this.log.info(`Indexing complete: ${allChunks.length} chunks, ${embedded} embedded`);
  }

  /**
   * Search the codebase for relevant context given a query.
   * Returns formatted code snippets for injection into the LLM context.
   */
  async search(query: string, topK: number = 5): Promise<string | null> {
    const queryEmbedding = await this.llm.embed(query);
    if (queryEmbedding.length === 0) return null;

    // Get all embeddings and compute similarity
    const rows = this.db.prepare(`
      SELECT c.id, c.file_path, c.start_line, c.end_line, c.language, c.content, e.embedding
      FROM code_chunks c
      JOIN code_embeddings e ON e.chunk_id = c.id
    `).all() as any[];

    if (rows.length === 0) return null;

    // Compute similarities
    const scored = rows.map((row) => {
      const embeddingBuffer = row.embedding as Buffer;
      const embedding = Array.from(new Float32Array(embeddingBuffer.buffer, embeddingBuffer.byteOffset, embeddingBuffer.byteLength / 4));
      return {
        ...row,
        similarity: cosineSimilarity(queryEmbedding, embedding),
      };
    });

    // Sort by similarity (descending) and take top K
    scored.sort((a, b) => b.similarity - a.similarity);
    const topResults = scored.slice(0, topK).filter((r) => r.similarity > 0.3);

    if (topResults.length === 0) return null;

    // Format as context for the LLM
    const snippets = topResults.map((r) => {
      const header = `### ${r.file_path} (lines ${r.start_line}-${r.end_line}) [similarity: ${r.similarity.toFixed(2)}]`;
      return `${header}\n\`\`\`${r.language}\n${r.content.slice(0, 1500)}\n\`\`\``;
    });

    return snippets.join('\n\n');
  }

  /**
   * Check if the index exists and has data.
   */
  isIndexed(): boolean {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM code_chunks').get() as any;
    return row?.count > 0;
  }
}
