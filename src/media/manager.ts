/**
 * MediaManager — loads media.config.json, downloads media files on first use,
 * and manages audio/video playlists and file assets.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { join, resolve, basename } from 'path';
import { get as httpsGet } from 'https';
import { get as httpGet } from 'http';
import type { Logger } from '../config.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface AudioEntry {
  id: string;
  name: string;
  url: string;
  format: string;
}

interface VideoEntry {
  id: string;
  name: string;
  url: string;
  format: string;
  resolution?: string;
}

interface FileEntry {
  id: string;
  name: string;
  url?: string;
  generate?: string;
  format: string;
  category: string;
}

interface MediaConfig {
  audio: AudioEntry[];
  video: VideoEntry[];
  files: FileEntry[];
}

export interface MediaFile {
  id: string;
  name: string;
  path: string;
  format: string;
  category?: string;
  resolution?: string;
}

// ── MediaManager ──────────────────────────────────────────────────────────────

export class MediaManager {
  private config: MediaConfig | null = null;
  private cacheDir: string;
  private configPath: string;
  private log: Logger;

  private audioFiles: MediaFile[] = [];
  private videoFiles: MediaFile[] = [];
  private otherFiles: MediaFile[] = [];

  private audioIndex = 0;
  private videoIndex = 0;

  constructor(configPath: string, cacheDir: string, log: Logger) {
    this.configPath = resolve(configPath);
    this.cacheDir = resolve(cacheDir);
    this.log = log;
  }

  /** Load config and ensure cache directories exist. */
  async initialize(): Promise<void> {
    // Load config
    if (!existsSync(this.configPath)) {
      this.log.warn(`[MEDIA] Config not found at ${this.configPath} — using empty config`);
      this.config = { audio: [], video: [], files: [] };
      return;
    }

    const raw = readFileSync(this.configPath, 'utf-8');
    this.config = JSON.parse(raw) as MediaConfig;

    // Ensure cache dirs
    for (const sub of ['audio', 'video', 'files']) {
      const dir = join(this.cacheDir, sub);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }

    this.log.info(`[MEDIA] Loaded config: ${this.config.audio.length} audio, ${this.config.video.length} video, ${this.config.files.length} files`);
  }

  /** Download all media files in background. */
  async downloadAll(): Promise<void> {
    if (!this.config) return;

    // Download audio
    for (const entry of this.config.audio) {
      const path = await this.ensureDownloaded(entry.url, 'audio', `${entry.id}.${entry.format}`);
      if (path) {
        this.audioFiles.push({ id: entry.id, name: entry.name, path, format: entry.format });
      }
    }

    // Download video
    for (const entry of this.config.video) {
      const path = await this.ensureDownloaded(entry.url, 'video', `${entry.id}.${entry.format}`);
      if (path) {
        this.videoFiles.push({
          id: entry.id, name: entry.name, path, format: entry.format,
          resolution: entry.resolution,
        });
      }
    }

    // Download/generate files
    for (const entry of this.config.files) {
      let path: string | null = null;
      const filename = `${entry.id}.${entry.format}`;

      if (entry.generate) {
        path = this.generateSyntheticFile(entry.generate, 'files', filename);
      } else if (entry.url) {
        path = await this.ensureDownloaded(entry.url, 'files', filename);
      }

      if (path) {
        this.otherFiles.push({
          id: entry.id, name: entry.name, path, format: entry.format,
          category: entry.category,
        });
      }
    }

    this.log.info(`[MEDIA] Ready: ${this.audioFiles.length} audio, ${this.videoFiles.length} video, ${this.otherFiles.length} files`);
  }

  // ── Audio ─────────────────────────────────────────────────────────────────

  getAudioTrack(id?: string): MediaFile | null {
    if (id) return this.audioFiles.find((f) => f.id === id) ?? null;
    return this.audioFiles[0] ?? null;
  }

  getNextAudioTrack(): MediaFile | null {
    if (this.audioFiles.length === 0) return null;
    this.audioIndex = (this.audioIndex + 1) % this.audioFiles.length;
    return this.audioFiles[this.audioIndex];
  }

  getAudioTracks(): MediaFile[] {
    return this.audioFiles;
  }

  // ── Video ─────────────────────────────────────────────────────────────────

  getVideoFile(id?: string): MediaFile | null {
    if (id) return this.videoFiles.find((f) => f.id === id) ?? null;
    return this.videoFiles[0] ?? null;
  }

  /** Get a random video file (for call start). */
  getRandomVideoFile(): MediaFile | null {
    if (this.videoFiles.length === 0) return null;
    const idx = Math.floor(Math.random() * this.videoFiles.length);
    this.videoIndex = idx;
    return this.videoFiles[idx];
  }

  getNextVideoFile(): MediaFile | null {
    if (this.videoFiles.length === 0) return null;
    this.videoIndex = (this.videoIndex + 1) % this.videoFiles.length;
    return this.videoFiles[this.videoIndex];
  }

  getVideoFiles(): MediaFile[] {
    return this.videoFiles;
  }

  // ── Files ─────────────────────────────────────────────────────────────────

  getFile(query: string): MediaFile | null {
    // Search by id first, then by name, then by category
    const q = query.toLowerCase();
    return (
      this.otherFiles.find((f) => f.id === q) ??
      this.otherFiles.find((f) => f.name.toLowerCase().includes(q)) ??
      this.otherFiles.find((f) => f.category?.toLowerCase() === q) ??
      this.otherFiles.find((f) => f.format === q) ??
      null
    );
  }

  listFiles(category?: string): MediaFile[] {
    if (!category) return this.otherFiles;
    return this.otherFiles.filter((f) => f.category === category);
  }

  getAllMedia(): { audio: MediaFile[]; video: MediaFile[]; files: MediaFile[] } {
    return { audio: this.audioFiles, video: this.videoFiles, files: this.otherFiles };
  }

  // ── Download ──────────────────────────────────────────────────────────────

  private async ensureDownloaded(url: string, subdir: string, filename: string): Promise<string | null> {
    const filePath = join(this.cacheDir, subdir, filename);
    if (existsSync(filePath)) {
      // Check file isn't empty (could be a partial/failed download)
      const stat = statSync(filePath);
      if (stat.size > 0) {
        this.log.debug(`[MEDIA] Already cached: ${filename} (${(stat.size / 1024).toFixed(0)}KB)`);
        return filePath;
      }
      this.log.warn(`[MEDIA] Empty file found, re-downloading: ${filename}`);
    }

    this.log.info(`[MEDIA] Downloading: ${filename} from ${url}`);
    try {
      const data = await this.downloadFile(url);
      writeFileSync(filePath, data);
      this.log.info(`[MEDIA] Downloaded: ${filename} (${(data.length / 1024).toFixed(0)}KB)`);
      return filePath;
    } catch (err) {
      this.log.error(`[MEDIA] Failed to download ${filename}:`, err);
      return null;
    }
  }

  private downloadFile(url: string, maxRedirects = 5): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (maxRedirects <= 0) {
        reject(new Error('Too many redirects'));
        return;
      }

      const getter = url.startsWith('https') ? httpsGet : httpGet;

      getter(url, (res) => {
        // Handle redirects
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          this.downloadFile(res.headers.location, maxRedirects - 1).then(resolve, reject);
          return;
        }

        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk as Buffer));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  // ── Synthetic file generation ─────────────────────────────────────────────

  private generateSyntheticFile(type: string, subdir: string, filename: string): string | null {
    const filePath = join(this.cacheDir, subdir, filename);
    if (existsSync(filePath)) return filePath;

    try {
      let content: Buffer;

      switch (type) {
        case 'lorem-ipsum':
          content = Buffer.from(LOREM_IPSUM, 'utf-8');
          break;
        case 'sample-json':
          content = Buffer.from(JSON.stringify(SAMPLE_JSON, null, 2), 'utf-8');
          break;
        case 'sample-archive':
          content = createMinimalZip('hello.txt', 'Hello from Ghost AI! This is a sample file inside a ZIP archive.');
          break;
        default:
          this.log.warn(`[MEDIA] Unknown synthetic type: ${type}`);
          return null;
      }

      writeFileSync(filePath, content);
      this.log.info(`[MEDIA] Generated: ${filename}`);
      return filePath;
    } catch (err) {
      this.log.error(`[MEDIA] Failed to generate ${filename}:`, err);
      return null;
    }
  }
}

// ── Static content ──────────────────────────────────────────────────────────

const LOREM_IPSUM = `Lorem ipsum dolor sit amet, consectetur adipiscing elit.
Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.
Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.
Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore.
Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt.

This is a sample text document generated by Ghost AI for testing file transfers.
`;

const SAMPLE_JSON = {
  name: 'Ghost AI Test Data',
  version: '1.0.0',
  timestamp: new Date().toISOString(),
  items: [
    { id: 1, type: 'message', content: 'Hello, World!' },
    { id: 2, type: 'status', content: 'Connected' },
    { id: 3, type: 'metadata', content: { format: 'JSON', encoding: 'UTF-8' } },
  ],
};

// ── Minimal ZIP generator ───────────────────────────────────────────────────

function createMinimalZip(filename: string, content: string): Buffer {
  const fileData = Buffer.from(content, 'utf-8');
  const filenameBytes = Buffer.from(filename, 'utf-8');
  const crc = crc32(fileData);

  // Local file header
  const localHeader = Buffer.alloc(30 + filenameBytes.length);
  localHeader.writeUInt32LE(0x04034b50, 0);     // Signature
  localHeader.writeUInt16LE(20, 4);              // Version needed
  localHeader.writeUInt16LE(0, 6);               // Flags
  localHeader.writeUInt16LE(0, 8);               // Compression (stored)
  localHeader.writeUInt16LE(0, 10);              // Mod time
  localHeader.writeUInt16LE(0, 12);              // Mod date
  localHeader.writeUInt32LE(crc, 14);            // CRC-32
  localHeader.writeUInt32LE(fileData.length, 18); // Compressed size
  localHeader.writeUInt32LE(fileData.length, 22); // Uncompressed size
  localHeader.writeUInt16LE(filenameBytes.length, 26); // Filename length
  localHeader.writeUInt16LE(0, 28);              // Extra field length
  filenameBytes.copy(localHeader, 30);

  // Central directory entry
  const centralDir = Buffer.alloc(46 + filenameBytes.length);
  centralDir.writeUInt32LE(0x02014b50, 0);       // Signature
  centralDir.writeUInt16LE(20, 4);               // Version made by
  centralDir.writeUInt16LE(20, 6);               // Version needed
  centralDir.writeUInt16LE(0, 8);                // Flags
  centralDir.writeUInt16LE(0, 10);               // Compression
  centralDir.writeUInt16LE(0, 12);               // Mod time
  centralDir.writeUInt16LE(0, 14);               // Mod date
  centralDir.writeUInt32LE(crc, 16);             // CRC-32
  centralDir.writeUInt32LE(fileData.length, 20);  // Compressed size
  centralDir.writeUInt32LE(fileData.length, 24);  // Uncompressed size
  centralDir.writeUInt16LE(filenameBytes.length, 28); // Filename length
  centralDir.writeUInt16LE(0, 30);               // Extra field length
  centralDir.writeUInt16LE(0, 32);               // Comment length
  centralDir.writeUInt16LE(0, 34);               // Disk number start
  centralDir.writeUInt16LE(0, 36);               // Internal attributes
  centralDir.writeUInt32LE(0, 38);               // External attributes
  centralDir.writeUInt32LE(0, 42);               // Relative offset
  filenameBytes.copy(centralDir, 46);

  const centralDirOffset = localHeader.length + fileData.length;

  // End of central directory
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);        // Signature
  endRecord.writeUInt16LE(0, 4);                 // Disk number
  endRecord.writeUInt16LE(0, 6);                 // Disk with central dir
  endRecord.writeUInt16LE(1, 8);                 // Entries on disk
  endRecord.writeUInt16LE(1, 10);                // Total entries
  endRecord.writeUInt32LE(centralDir.length, 12); // Central dir size
  endRecord.writeUInt32LE(centralDirOffset, 16);  // Central dir offset
  endRecord.writeUInt16LE(0, 20);                // Comment length

  return Buffer.concat([localHeader, fileData, centralDir, endRecord]);
}

function crc32(buf: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
