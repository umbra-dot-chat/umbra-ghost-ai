/**
 * Persistent identity manager for Ghost.
 *
 * On first run, generates a new Ed25519 + X25519 identity and saves it.
 * On subsequent runs, loads the existing identity from disk.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createIdentity, type GhostIdentity } from './crypto.js';
import type { Logger } from './config.js';

/**
 * Load or create a persistent Ghost identity.
 */
export function loadOrCreateIdentity(
  dataDir: string,
  displayName: string,
  log: Logger,
): GhostIdentity {
  const identityPath = join(dataDir, 'identity.json');

  // Ensure data directory exists
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
    log.info(`Created data directory: ${dataDir}`);
  }

  // Try to load existing identity
  if (existsSync(identityPath)) {
    try {
      const data = JSON.parse(readFileSync(identityPath, 'utf-8')) as GhostIdentity;
      // Update display name if it changed
      data.displayName = displayName;
      log.info(`Loaded existing identity: ${data.did}`);
      return data;
    } catch (err) {
      log.error(`Failed to load identity, generating new one:`, err);
    }
  }

  // Generate new identity
  const identity = createIdentity(displayName);
  writeFileSync(identityPath, JSON.stringify(identity, null, 2), 'utf-8');
  log.info(`Generated new identity: ${identity.did}`);
  log.info(`Identity saved to: ${identityPath}`);

  return identity;
}
