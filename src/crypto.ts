/**
 * Crypto utilities for Ghost — mirrors the Umbra WASM core's cryptography.
 *
 *   - Ed25519 signing keypair (identity / DID)
 *   - X25519 encryption keypair (ECDH key agreement)
 *   - AES-256-GCM message encryption/decryption
 *   - Deterministic conversation ID generation
 */

import { ed25519 } from '@noble/curves/ed25519';
import { x25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';
import { gcm } from '@noble/ciphers/aes';
import { randomBytes } from '@noble/ciphers/webcrypto';
import { bytesToHex, hexToBytes } from '@noble/curves/abstract/utils';

// ─── Identity ──────────────────────────────────────────────────────────────

export interface GhostIdentity {
  /** DID (did:key:z6Mk...) */
  did: string;
  /** Display name */
  displayName: string;
  /** Ed25519 signing private key (hex) */
  signingPrivateKey: string;
  /** Ed25519 signing public key (hex) */
  signingPublicKey: string;
  /** X25519 encryption private key (hex) */
  encryptionPrivateKey: string;
  /** X25519 encryption public key (hex) */
  encryptionPublicKey: string;
}

/**
 * Generate a new Ghost identity with Ed25519 + X25519 keypairs.
 */
export function createIdentity(displayName: string): GhostIdentity {
  const signingPrivate = ed25519.utils.randomPrivateKey();
  const signingPublic = ed25519.getPublicKey(signingPrivate);

  const encryptionPrivate = x25519.utils.randomPrivateKey();
  const encryptionPublic = x25519.getPublicKey(encryptionPrivate);

  // Build DID from Ed25519 public key (did:key method with multicodec 0xed01)
  const multicodecPrefix = new Uint8Array([0xed, 0x01]);
  const didBytes = new Uint8Array(multicodecPrefix.length + signingPublic.length);
  didBytes.set(multicodecPrefix);
  didBytes.set(signingPublic, multicodecPrefix.length);
  const did = `did:key:z${base58btcEncode(didBytes)}`;

  return {
    did,
    displayName,
    signingPrivateKey: bytesToHex(signingPrivate),
    signingPublicKey: bytesToHex(signingPublic),
    encryptionPrivateKey: bytesToHex(encryptionPrivate),
    encryptionPublicKey: bytesToHex(encryptionPublic),
  };
}

// ─── Message Encryption ────────────────────────────────────────────────────

/**
 * Encrypt a message using X25519 ECDH + HKDF-SHA256 + AES-256-GCM.
 * Matches the Umbra core's encryption exactly.
 */
export function encryptMessage(
  plaintext: string,
  myEncryptionPrivateKey: string,
  friendEncryptionPublicKey: string,
  senderDid: string,
  recipientDid: string,
  timestamp: number,
  conversationId: string,
): { ciphertext: string; nonce: string } {
  const sharedSecret = x25519.getSharedSecret(
    hexToBytes(myEncryptionPrivateKey),
    hexToBytes(friendEncryptionPublicKey),
  );

  const salt = new TextEncoder().encode(conversationId);
  const aesKey = hkdf(sha256, sharedSecret, salt, 'umbra-message-encryption-v1', 32);

  const nonce = randomBytes(12);
  const encoder = new TextEncoder();
  const aad = encoder.encode(`${senderDid}${recipientDid}${timestamp}`);

  const cipher = gcm(aesKey, nonce, aad);
  const ciphertextBytes = cipher.encrypt(encoder.encode(plaintext));

  return {
    ciphertext: Buffer.from(ciphertextBytes).toString('base64'),
    nonce: bytesToHex(nonce),
  };
}

/**
 * Decrypt a message using X25519 ECDH + HKDF-SHA256 + AES-256-GCM.
 */
export function decryptMessage(
  ciphertextBase64: string,
  nonceHex: string,
  myEncryptionPrivateKey: string,
  senderEncryptionPublicKey: string,
  senderDid: string,
  recipientDid: string,
  timestamp: number,
  conversationId: string,
): string {
  const sharedSecret = x25519.getSharedSecret(
    hexToBytes(myEncryptionPrivateKey),
    hexToBytes(senderEncryptionPublicKey),
  );

  const salt = new TextEncoder().encode(conversationId);
  const aesKey = hkdf(sha256, sharedSecret, salt, 'umbra-message-encryption-v1', 32);

  const nonce = hexToBytes(nonceHex);
  const ciphertext = Buffer.from(ciphertextBase64, 'base64');

  const encoder = new TextEncoder();
  const aad = encoder.encode(`${senderDid}${recipientDid}${timestamp}`);

  const cipher = gcm(aesKey, nonce, aad);
  const plaintext = cipher.decrypt(new Uint8Array(ciphertext));

  return new TextDecoder().decode(plaintext);
}

// ─── Conversation ID ───────────────────────────────────────────────────────

/**
 * Deterministic conversation ID: SHA-256(sorted_did_a | sorted_did_b) as hex.
 */
export function computeConversationId(didA: string, didB: string): string {
  const sorted = [didA, didB].sort();
  const input = `${sorted[0]}|${sorted[1]}`;
  const hash = sha256(new TextEncoder().encode(input));
  return bytesToHex(hash);
}

// ─── Signing ───────────────────────────────────────────────────────────────

export function sign(data: Uint8Array, privateKeyHex: string): string {
  const sig = ed25519.sign(data, hexToBytes(privateKeyHex));
  return bytesToHex(sig);
}

// ─── UUID ──────────────────────────────────────────────────────────────────

export function uuid(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-');
}

// ─── Group Key Exchange ─────────────────────────────────────────────────────

/**
 * Encrypt a raw key using ECDH shared secret (for group key exchange).
 * Matches Rust umbra-core's decrypt_from_sender with group key parameters.
 */
export function encryptGroupKey(
  groupKeyHex: string,
  myEncryptionPrivateKey: string,
  recipientEncryptionPublicKey: string,
  groupId: string,
): { ciphertext: string; nonce: string } {
  const sharedSecret = x25519.getSharedSecret(
    hexToBytes(myEncryptionPrivateKey),
    hexToBytes(recipientEncryptionPublicKey),
  );
  const salt = new TextEncoder().encode(groupId);
  const aesKey = hkdf(sha256, sharedSecret, salt, 'umbra-message-encryption-v1', 32);
  const nonce = randomBytes(12);
  const aad = new TextEncoder().encode(`group-key-transfer:${groupId}:1`);
  const cipher = gcm(aesKey, nonce, aad);
  const ciphertextBytes = cipher.encrypt(hexToBytes(groupKeyHex));
  return {
    ciphertext: bytesToHex(ciphertextBytes),
    nonce: bytesToHex(nonce),
  };
}

/**
 * Decrypt a raw key using ECDH shared secret (for group key exchange).
 * Matches Rust umbra-core's encrypt_for_recipient with group key parameters.
 */
export function decryptGroupKey(
  ciphertextHex: string,
  nonceHex: string,
  myEncryptionPrivateKey: string,
  senderEncryptionPublicKey: string,
  groupId: string,
): string {
  const sharedSecret = x25519.getSharedSecret(
    hexToBytes(myEncryptionPrivateKey),
    hexToBytes(senderEncryptionPublicKey),
  );
  const salt = new TextEncoder().encode(groupId);
  const aesKey = hkdf(sha256, sharedSecret, salt, 'umbra-message-encryption-v1', 32);
  const nonce = hexToBytes(nonceHex);
  const ciphertext = hexToBytes(ciphertextHex);
  const aad = new TextEncoder().encode(`group-key-transfer:${groupId}:1`);
  const cipher = gcm(aesKey, nonce, aad);
  const plaintext = cipher.decrypt(new Uint8Array(ciphertext));
  return bytesToHex(plaintext);
}

// ─── Group Message Encryption ───────────────────────────────────────────────

/**
 * Encrypt a message using a symmetric AES-256-GCM key (for group messages).
 * Matches Rust umbra-core's group message encryption format.
 */
export function encryptGroupMessage(
  plaintext: string,
  groupKeyHex: string,
  groupId: string,
  senderDid: string,
  timestamp: number,
): { ciphertext: string; nonce: string } {
  const key = hexToBytes(groupKeyHex);
  const nonce = randomBytes(12);
  const aad = new TextEncoder().encode(`group-msg:${groupId}:${senderDid}:${timestamp}`);
  const cipher = gcm(key, nonce, aad);
  const ciphertextBytes = cipher.encrypt(new TextEncoder().encode(plaintext));
  return {
    ciphertext: bytesToHex(ciphertextBytes),
    nonce: bytesToHex(nonce),
  };
}

/**
 * Decrypt a message using a symmetric AES-256-GCM key (for group messages).
 * Matches Rust umbra-core's group message decryption format.
 */
export function decryptGroupMessage(
  ciphertextHex: string,
  nonceHex: string,
  groupKeyHex: string,
  groupId: string,
  senderDid: string,
  timestamp: number,
): string {
  const key = hexToBytes(groupKeyHex);
  const nonce = hexToBytes(nonceHex);
  const ciphertext = hexToBytes(ciphertextHex);
  const aad = new TextEncoder().encode(`group-msg:${groupId}:${senderDid}:${timestamp}`);
  const cipher = gcm(key, nonce, aad);
  const plaintext = cipher.decrypt(new Uint8Array(ciphertext));
  return new TextDecoder().decode(plaintext);
}

// ─── Base58btc ─────────────────────────────────────────────────────────────

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58btcEncode(bytes: Uint8Array): string {
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let output = '';
  for (const byte of bytes) {
    if (byte === 0) output += BASE58_ALPHABET[0];
    else break;
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    output += BASE58_ALPHABET[digits[i]];
  }
  return output;
}
