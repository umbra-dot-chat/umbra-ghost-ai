# Ghost Bot Plugin System — Implementation Plan

## Overview

This plan adds a **per-user plugin system** to Ghost, the Umbra AI agent. Plugins modify Ghost's behavior on a per-conversation basis — injecting custom system prompts, preprocessing user messages, and post-processing LLM responses. The existing Umbra plugin marketplace (`umbra-plugin-runtime` + `umbra-plugin-sdk`) is extended to serve bot plugins alongside UI plugins.

**Key insight**: Ghost's message handler already has clean hook points. Adding plugins requires ~400 lines of new code with zero architectural rewrites.

---

## Current Architecture (Context)

### Ghost AI Bot (`packages/umbra-ghost-ai`)

```
User Message → Relay WebSocket → Decrypt (X25519+AES-256-GCM)
  → Context Store (save) → Reminder Check → Build LLM Context
  → [system_prompt + codebase_context + 20-msg history + user_msg]
  → Ollama LLM → Encrypt Response → Relay → User
```

**Key files:**
- `src/bot.ts` — Orchestrator, routes envelopes to handlers
- `src/handlers/message.ts` — Message pipeline: decrypt → intent check → LLM → encrypt → send
- `src/llm/provider.ts` — `LLMProvider` interface (`chat()`, `embed()`)
- `src/llm/ollama.ts` — Ollama HTTP implementation
- `src/llm/system-prompts.ts` — Unified multilingual system prompt
- `src/context/store.ts` — SQLite persistence (friends, messages, reminders)
- `src/handlers/reminder.ts` — Natural language reminder parsing (EN/KO/ES)
- `src/handlers/friend-request.ts` — Auto-accept + multilingual welcome message
- `src/knowledge/indexer.ts` — Codebase RAG (chunk → embed → vector search)
- `src/crypto.ts` — E2E encryption (X25519 ECDH + HKDF + AES-256-GCM)
- `src/relay.ts` — WebSocket relay client with auto-reconnect + message queue
- `src/identity.ts` — Persistent Ed25519+X25519 identity (did:key)

### Existing Umbra Plugin System (`packages/umbra-plugin-sdk` + `packages/umbra-plugin-runtime`)

The app already has a full plugin system with:
- **Manifest-based declarations** (permissions, slots, storage, platforms)
- **Sandboxed API** (permission-gated access to messages, friends, storage)
- **Marketplace** (`MarketplaceClient` fetching from `/plugins.json` CDN)
- **Plugin loader** (ESM bundles via Blob URLs / Function() evaluation)
- **Namespaced storage** (KV store + SQL per plugin, all in SQLite)
- **11 permission types**: `messages:read`, `messages:write`, `storage:kv`, `storage:sql`, etc.
- **11 UI slot types**: `settings-tab`, `chat-toolbar`, `message-actions`, etc.

Bot plugins reuse this infrastructure — same manifest format, same marketplace, same storage.

### Server Infrastructure

- **Ghost runs on**: `bot.umbra.chat` (NVIDIA A16 GPU, 16GB VRAM)
- **LLM**: Ollama with `llama3.1` (8B params, ~2-3s responses with GPU)
- **Embedding**: `nomic-embed-text` (384-dim vectors for RAG)
- **Relay**: Connects remotely to `wss://relay.umbra.chat/ws`
- **Identity**: `did:key:z6MknjNkfp3os1t5443s9mN8ht5Dwecmb3q2qL9V17SL3bh6`
- **Ghost is multilingual**: Single bot detects user's language and responds in kind

---

## Plugin Architecture

### How Bot Plugins Work

A bot plugin is a JSON configuration (no code execution on the server) that hooks into Ghost's message pipeline at three points:

```
User Message
  ↓
[1. PRE-PROCESS] ← Plugin can transform/annotate the user message
  ↓
[2. SYSTEM PROMPT INJECTION] ← Plugin appends instructions to the system prompt
  ↓
[LLM Call]
  ↓
[3. POST-PROCESS] ← Plugin can transform the LLM response
  ↓
Encrypted Response → User
```

### Plugin Definition

```typescript
interface BotPlugin {
  id: string;                          // Reverse-domain: "com.umbra.language-tutor"
  name: string;                        // "Language Tutor"
  description: string;                 // "Learn languages through conversation"
  version: string;                     // "1.0.0"
  author: string;                      // "Umbra Team"
  icon: string;                        // Emoji or URL
  tags: string[];                      // ["education", "languages"]

  // The three hook points (all optional)
  systemPromptExtension: string;       // Appended to Ghost's system prompt
  preProcessTemplate?: string;         // Template applied to user message before LLM
  postProcessTemplate?: string;        // Template applied to LLM response before sending

  // Plugin-specific settings the user can configure
  settings: PluginSetting[];

  // Commands the plugin responds to (e.g., "/level beginner")
  commands?: PluginCommand[];
}

interface PluginSetting {
  key: string;                         // "target_language"
  label: string;                       // "Language you're learning"
  type: "select" | "text" | "number" | "toggle";
  options?: { value: string; label: string }[];  // For select type
  default: string | number | boolean;
}

interface PluginCommand {
  name: string;                        // "level"
  description: string;                 // "Set your skill level"
  usage: string;                       // "/level [beginner|intermediate|advanced]"
}
```

### Why JSON-Only (No Code Execution)

Bot plugins are **declarative** — they define prompt extensions and settings, not executable code. This means:
- **Zero security risk**: No sandboxing needed on the server
- **Instant activation**: Just update the user's plugin config in the DB
- **Marketplace-safe**: Plugins can be reviewed as plain text
- **Lightweight**: No bundle loading, no Function() eval, no WASM

The LLM itself is the "execution engine" — plugins shape its behavior through prompt engineering.

---

## Implementation Steps

### Step 1: Plugin Manager (`src/plugins/manager.ts`)

The core plugin orchestrator. Manages per-user plugin state and applies plugins to the message pipeline.

```typescript
// New file: src/plugins/manager.ts

interface UserPluginState {
  pluginId: string;
  enabled: boolean;
  settings: Record<string, string | number | boolean>;
  activatedAt: number;
}

class PluginManager {
  private plugins: Map<string, BotPlugin>;           // All available plugins
  private userPlugins: Map<string, UserPluginState[]>; // Per-user active plugins (keyed by DID)

  constructor(store: ContextStore) { ... }

  // Registry
  registerPlugin(plugin: BotPlugin): void;
  getAvailablePlugins(): BotPlugin[];
  getPlugin(id: string): BotPlugin | null;

  // Per-user activation
  activateForUser(userDid: string, pluginId: string, settings?: Record<string, any>): void;
  deactivateForUser(userDid: string, pluginId: string): void;
  getUserPlugins(userDid: string): UserPluginState[];
  updateUserSettings(userDid: string, pluginId: string, settings: Record<string, any>): void;

  // Pipeline hooks (called from message handler)
  getSystemPromptExtensions(userDid: string): string;  // Concatenates all active plugin prompts
  preProcess(userDid: string, message: string): string; // Applies pre-process templates
  postProcess(userDid: string, response: string): string; // Applies post-process templates

  // Command handling
  handleCommand(userDid: string, message: string): { handled: boolean; response?: string };
}
```

**~150 lines of code.**

### Step 2: Plugin Store (SQLite Tables)

Add to existing `ContextStore` (`src/context/store.ts`):

```sql
-- Available bot plugins (loaded from marketplace or bundled)
CREATE TABLE IF NOT EXISTS bot_plugins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  version TEXT,
  author TEXT,
  icon TEXT,
  tags TEXT,                          -- JSON array
  system_prompt_extension TEXT,       -- The prompt text to inject
  pre_process_template TEXT,
  post_process_template TEXT,
  settings_schema TEXT,               -- JSON array of PluginSetting
  commands TEXT,                      -- JSON array of PluginCommand
  updated_at INTEGER
);

-- Per-user plugin activations
CREATE TABLE IF NOT EXISTS user_plugins (
  user_did TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  settings TEXT,                      -- JSON object of user's configured values
  activated_at INTEGER,
  PRIMARY KEY (user_did, plugin_id)
);
```

**~40 lines added to store.ts.**

### Step 3: Integrate into Message Handler

Modify `src/handlers/message.ts` to call plugin hooks:

```typescript
// In handleMessage(), after decryption and before LLM call:

// 1. Check for plugin commands (e.g., "/plugins", "/level beginner")
const cmdResult = pluginManager.handleCommand(msg.senderDid, plaintext);
if (cmdResult.handled) {
  await sendResponse(cmdResult.response!, identity, relay, store, friend, log);
  return;
}

// 2. Pre-process user message
const processedMessage = pluginManager.preProcess(msg.senderDid, plaintext);

// 3. Inject plugin system prompt extensions
let systemContent = getSystemPrompt(language);
const pluginExtensions = pluginManager.getSystemPromptExtensions(msg.senderDid);
if (pluginExtensions) {
  systemContent += '\n\n' + pluginExtensions;
}
if (codebaseContext) {
  systemContent += '\n\n## Relevant Codebase Context\n' + codebaseContext;
}

// 4. Use processedMessage instead of plaintext for LLM
// ... existing LLM call ...

// 5. Post-process LLM response
const finalResponse = pluginManager.postProcess(msg.senderDid, responseText);
await sendResponse(finalResponse, identity, relay, store, friend, log);
```

**~30 lines modified in message.ts.**

### Step 4: Built-in Commands

Ghost responds to plugin management commands in chat:

| Command | Action |
|---------|--------|
| `/plugins` | List available plugins with descriptions |
| `/plugins active` | Show user's active plugins and settings |
| `/enable <plugin-name>` | Activate a plugin |
| `/disable <plugin-name>` | Deactivate a plugin |
| `/settings <plugin> <key> <value>` | Update a plugin setting |

These are handled in `pluginManager.handleCommand()` before reaching the LLM.

### Step 5: Marketplace Integration

Extend the existing marketplace (`umbra-plugin-runtime/src/marketplace.ts`) to include bot plugins:

```typescript
// In MarketplaceListing, add:
interface MarketplaceListing {
  // ... existing fields ...
  type: 'ui' | 'bot';                // NEW: distinguish bot plugins from UI plugins
  botPlugin?: BotPlugin;             // NEW: included when type === 'bot'
}
```

The existing marketplace CDN (`/plugins.json`) gets a `type` field. Bot plugins are listed alongside UI plugins but filtered by type in the app UI and bot code.

**Ghost fetches bot plugins on startup** from the same marketplace endpoint, registers them in its local DB, and makes them available to users.

### Step 6: Sync Plugin State via Relay

When a user activates a bot plugin from the **Umbra app UI** (not just via chat commands), the app sends a control envelope to Ghost:

```typescript
// New envelope type
{
  envelope: 'bot_plugin_control',
  version: 1,
  payload: {
    action: 'activate' | 'deactivate' | 'update_settings',
    pluginId: string,
    settings?: Record<string, any>,
    timestamp: number,
  }
}
```

Ghost handles this in `bot.ts` alongside other envelope types.

---

## Example Plugins

### Plugin 1: Language Tutor

**Purpose**: Learn any language through immersive conversation with adaptive difficulty.

```json
{
  "id": "com.umbra.language-tutor",
  "name": "Language Tutor",
  "description": "Learn languages through conversation. Ghost adapts to your level and teaches grammar, vocabulary, and cultural context.",
  "version": "1.0.0",
  "author": "Umbra Team",
  "icon": "🎓",
  "tags": ["education", "languages", "learning"],

  "systemPromptExtension": "## Language Tutor Mode\n\nThe user is learning {{target_language}}. Their current level is {{skill_level}}.\n\n### Rules:\n1. Write your responses in TWO parts:\n   - First, respond naturally in {{target_language}} at the {{skill_level}} level\n   - Then, provide a translation/explanation in the user's native language\n2. Gently correct grammar and vocabulary mistakes the user makes in {{target_language}}\n3. Introduce 1-2 new vocabulary words per response, with pronunciation hints\n4. Adjust complexity based on user's responses — if they struggle, simplify; if they're fluent, increase difficulty\n5. Use cultural context and real-world examples\n6. For beginners: short sentences, common words, romanization for non-Latin scripts\n7. For intermediate: longer sentences, idioms, less hand-holding\n8. For advanced: native-speed text, slang, nuanced grammar, minimal translation\n\n### Tracking:\n- Note words the user has learned and reuse them\n- Track common mistakes and address them periodically\n- Celebrate progress (\"Nice use of the subjunctive! 🎉\")",

  "settings": [
    {
      "key": "target_language",
      "label": "Language you're learning",
      "type": "select",
      "options": [
        { "value": "Korean", "label": "Korean 🇰🇷" },
        { "value": "Spanish", "label": "Spanish 🇪🇸" },
        { "value": "Japanese", "label": "Japanese 🇯🇵" },
        { "value": "French", "label": "French 🇫🇷" },
        { "value": "German", "label": "German 🇩🇪" },
        { "value": "Mandarin Chinese", "label": "Chinese 🇨🇳" },
        { "value": "Portuguese", "label": "Portuguese 🇧🇷" },
        { "value": "Italian", "label": "Italian 🇮🇹" }
      ],
      "default": "Korean"
    },
    {
      "key": "skill_level",
      "label": "Your current level",
      "type": "select",
      "options": [
        { "value": "beginner", "label": "Beginner (A1-A2)" },
        { "value": "intermediate", "label": "Intermediate (B1-B2)" },
        { "value": "advanced", "label": "Advanced (C1-C2)" }
      ],
      "default": "beginner"
    },
    {
      "key": "focus_area",
      "label": "Focus area",
      "type": "select",
      "options": [
        { "value": "conversation", "label": "Everyday conversation" },
        { "value": "grammar", "label": "Grammar drills" },
        { "value": "vocabulary", "label": "Vocabulary building" },
        { "value": "culture", "label": "Cultural context" }
      ],
      "default": "conversation"
    }
  ],

  "commands": [
    { "name": "level", "description": "Set your skill level", "usage": "/level [beginner|intermediate|advanced]" },
    { "name": "vocab", "description": "Review recent vocabulary", "usage": "/vocab" },
    { "name": "quiz", "description": "Start a quick vocabulary quiz", "usage": "/quiz" }
  ]
}
```

**Example conversation:**
```
User: /enable language-tutor
Ghost: 🎓 Language Tutor activated! You're learning Korean at the beginner level.
       Just chat with me normally — I'll respond in Korean with translations.
       Use /level to change difficulty. Let's go! 화이팅! ✨

User: how do I say "I want to eat lunch"?
Ghost: 점심 먹고 싶어요 (jeomsim meokgo sipeoyo)

       Let's break it down:
       • 점심 (jeomsim) = lunch 🍱
       • 먹고 (meokgo) = to eat (connective form)
       • 싶어요 (sipeoyo) = want to (polite)

       Try saying it back to me! You can also say what food you want:
       "피자 먹고 싶어요" = I want to eat pizza 🍕

User: 라면 먹고 십어요
Ghost: Almost perfect! 🎉 Small correction:
       ❌ 십어요 → ✅ 싶어요 (sipeoyo)
       The ㅎ is important here — 싶다 (sipda) means "to want"

       라면 먹고 싶어요! 좋은 선택이에요! (Great choice!)
       🆕 New word: 선택 (seontaek) = choice
```

---

### Plugin 2: Code Reviewer

**Purpose**: Ghost reviews code snippets pasted in chat with detailed feedback on bugs, style, performance, and security.

```json
{
  "id": "com.umbra.code-reviewer",
  "name": "Code Reviewer",
  "description": "Paste code and get detailed reviews — bugs, style, performance, and security feedback.",
  "version": "1.0.0",
  "author": "Umbra Team",
  "icon": "🔍",
  "tags": ["developer", "code-review", "productivity"],

  "systemPromptExtension": "## Code Reviewer Mode\n\nWhen the user sends code (detected by code blocks, file extensions, or programming syntax), automatically review it.\n\n### Review Format:\n1. **Summary**: One-line overview of what the code does\n2. **Issues** (if any):\n   - 🐛 **Bugs**: Logic errors, off-by-one, null handling\n   - ⚠️ **Security**: Injection, XSS, auth issues, secrets exposure\n   - 🐌 **Performance**: N+1 queries, unnecessary allocations, missing memoization\n   - 📐 **Style**: Naming, dead code, complexity, readability\n3. **Suggestions**: Concrete improved code snippets\n4. **Rating**: /5 stars with brief justification\n\n### Guidelines:\n- Focus on the {{review_focus}} the user selected\n- Be constructive, not harsh\n- For {{language_preference}} code, apply idiomatic patterns for that language\n- If code is good, say so! Don't invent problems\n- Keep suggestions practical and actionable",

  "settings": [
    {
      "key": "review_focus",
      "label": "Review focus",
      "type": "select",
      "options": [
        { "value": "all aspects equally", "label": "Everything" },
        { "value": "bugs and correctness", "label": "Bugs & correctness" },
        { "value": "security vulnerabilities", "label": "Security" },
        { "value": "performance and optimization", "label": "Performance" },
        { "value": "code style and readability", "label": "Style & readability" }
      ],
      "default": "all aspects equally"
    },
    {
      "key": "language_preference",
      "label": "Primary language",
      "type": "select",
      "options": [
        { "value": "TypeScript", "label": "TypeScript" },
        { "value": "Rust", "label": "Rust" },
        { "value": "Python", "label": "Python" },
        { "value": "Go", "label": "Go" },
        { "value": "any", "label": "Auto-detect" }
      ],
      "default": "any"
    },
    {
      "key": "strictness",
      "label": "Strictness level",
      "type": "select",
      "options": [
        { "value": "gentle — focus on major issues only", "label": "Gentle" },
        { "value": "balanced — flag important issues", "label": "Balanced" },
        { "value": "strict — nitpick everything like a senior engineer", "label": "Strict" }
      ],
      "default": "balanced — flag important issues"
    }
  ],

  "commands": [
    { "name": "review", "description": "Force review mode for next message", "usage": "/review" },
    { "name": "explain", "description": "Explain code instead of reviewing", "usage": "/explain" }
  ]
}
```

**Example conversation:**
```
User: Can you review this?
```typescript
async function getUser(id) {
  const res = await fetch(`/api/users/${id}`);
  const data = res.json();
  return data;
}
```

Ghost: **Summary**: Fetches a user by ID from an API endpoint.

**Issues:**
🐛 **Bug**: `res.json()` is missing `await` — it returns a Promise, not the parsed data
⚠️ **Security**: `id` is interpolated directly into the URL — if it contains special characters, it could cause issues. Use `encodeURIComponent()`
🐌 **Performance**: No error handling — if the API returns 404/500, this silently returns an error response body
📐 **Style**: Missing TypeScript types for the parameter and return value

**Suggested fix:**
```typescript
async function getUser(id: string): Promise<User> {
  const res = await fetch(`/api/users/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`Failed to fetch user: ${res.status}`);
  return await res.json();
}
```

**Rating**: ⭐⭐⭐ (3/5) — Works but has a sneaky async bug and no error handling.
```

---

### Plugin 3: Daily Briefing

**Purpose**: Ghost sends a daily summary at your preferred time — weather, news, calendar reminders, and motivational content.

```json
{
  "id": "com.umbra.daily-briefing",
  "name": "Daily Briefing",
  "description": "Get a personalized daily summary with weather, tasks, and motivation at your preferred time.",
  "version": "1.0.0",
  "author": "Umbra Team",
  "icon": "☀️",
  "tags": ["productivity", "daily", "routine"],

  "systemPromptExtension": "## Daily Briefing Mode\n\nYou provide daily briefings to help the user start their day.\n\n### Briefing Format:\nWhen triggered (by the user saying 'briefing', 'good morning', or any morning greeting), respond with:\n\n1. ☀️ **Greeting**: Warm, time-appropriate greeting\n2. 📋 **Pending Reminders**: List any active reminders the user has set\n3. 💪 **Motivation**: A short motivational thought or productivity tip\n4. 🎯 **Focus Prompt**: Ask what their top priority is today\n\n### Personality:\n- Be {{briefing_tone}}\n- Keep it concise — the whole briefing should be 4-6 lines\n- If the user has set a {{focus_area}}, weave that into the motivation\n- Remember past conversations to make briefings personal\n- On Mondays, add extra encouragement\n- On Fridays, be more relaxed and celebratory",

  "settings": [
    {
      "key": "briefing_tone",
      "label": "Briefing tone",
      "type": "select",
      "options": [
        { "value": "energetic and enthusiastic like a personal coach", "label": "Energetic coach 🏃" },
        { "value": "calm and mindful like a meditation guide", "label": "Calm & mindful 🧘" },
        { "value": "witty and humorous like a comedian friend", "label": "Witty & funny 😄" },
        { "value": "professional and concise like an executive assistant", "label": "Professional 💼" }
      ],
      "default": "energetic and enthusiastic like a personal coach"
    },
    {
      "key": "focus_area",
      "label": "Current life focus",
      "type": "select",
      "options": [
        { "value": "fitness and health", "label": "Fitness & health" },
        { "value": "career and productivity", "label": "Career & productivity" },
        { "value": "learning and growth", "label": "Learning & growth" },
        { "value": "creativity and art", "label": "Creativity" },
        { "value": "general wellbeing", "label": "General wellbeing" }
      ],
      "default": "general wellbeing"
    }
  ],

  "commands": [
    { "name": "briefing", "description": "Get your daily briefing now", "usage": "/briefing" },
    { "name": "focus", "description": "Set your current focus area", "usage": "/focus [area]" }
  ]
}
```

**Example conversation:**
```
User: good morning!
Ghost: ☀️ Good morning! Happy Thursday — you're almost at Friday!

📋 You have 1 reminder set:
   • "Submit PR review" (due in 3 hours)

💪 Quick thought: "Consistency beats intensity. One focused hour
   of deep work > 4 scattered hours of half-attention."

🎯 What's your #1 priority today?

User: finish the plugin system for ghost
Ghost: Great focus! 🎯 Let's make it happen. I'll check in later —
       if you need a rubber duck for debugging, I'm here! 🦆
```

---

## Implementation Order

### Phase 1: Core Plugin Infrastructure (~400 LOC)

| Step | File | Description | LOC |
|------|------|-------------|-----|
| 1 | `src/plugins/types.ts` | `BotPlugin`, `PluginSetting`, `PluginCommand`, `UserPluginState` interfaces | ~60 |
| 2 | `src/plugins/manager.ts` | `PluginManager` class — registry, per-user state, pipeline hooks | ~150 |
| 3 | `src/context/store.ts` | Add `bot_plugins` and `user_plugins` tables + CRUD methods | ~80 |
| 4 | `src/handlers/message.ts` | Wire plugin hooks into message pipeline (pre-process, prompt inject, post-process) | ~30 |
| 5 | `src/plugins/commands.ts` | Built-in `/plugins`, `/enable`, `/disable`, `/settings` command handler | ~80 |

### Phase 2: Bundled Plugins

| Step | File | Description |
|------|------|-------------|
| 6 | `src/plugins/bundled/language-tutor.ts` | Language Tutor plugin definition |
| 7 | `src/plugins/bundled/code-reviewer.ts` | Code Reviewer plugin definition |
| 8 | `src/plugins/bundled/daily-briefing.ts` | Daily Briefing plugin definition |
| 9 | `src/plugins/bundled/index.ts` | Export all bundled plugins, register on bot startup |

### Phase 3: Marketplace Integration

| Step | File | Description |
|------|------|-------------|
| 10 | `src/plugins/marketplace.ts` | Fetch bot plugins from marketplace CDN, sync to local DB |
| 11 | Marketplace CDN | Add `type: 'bot'` field to plugin listings |
| 12 | `src/bot.ts` | Add `bot_plugin_control` envelope handler for app-driven activation |

### Phase 4: App UI Integration

| Step | File | Description |
|------|------|-------------|
| 13 | Umbra app | Bot plugin browsing/activation UI in chat settings or friend profile |
| 14 | Umbra app | Plugin settings panel (rendered from `PluginSetting[]` schema) |
| 15 | Umbra app | Send `bot_plugin_control` envelopes when user toggles plugins |

---

## Template Variable System

Plugin prompts use `{{variable}}` placeholders that are resolved from user settings:

```typescript
function resolveTemplate(template: string, settings: Record<string, any>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    return String(settings[key] ?? `[${key} not set]`);
  });
}
```

Example: `"You're learning {{target_language}} at the {{skill_level}} level"`
→ `"You're learning Korean at the beginner level"`

---

## Memory & Performance Impact

- **Plugin definitions**: ~2KB each in SQLite, negligible
- **Per-user state**: ~200 bytes per activation, scales to thousands of users
- **System prompt growth**: Each plugin adds ~500-1000 tokens to the prompt. With 3 active plugins, total system prompt grows by ~2000 tokens. Ollama's 8K context window handles this easily
- **No additional LLM calls**: Plugins modify the existing single LLM call, they don't add new ones
- **Memory**: <50MB additional for the entire plugin system

---

## Security Considerations

1. **No code execution**: Bot plugins are JSON + prompt text only. No eval(), no Function(), no WASM
2. **Prompt injection defense**: Plugin prompts are injected into the SYSTEM role (not user role), making injection from user messages harder
3. **Per-user isolation**: Each user's plugin state is keyed by DID, no cross-user leakage
4. **Setting validation**: Plugin settings are validated against the schema before storage
5. **Rate limiting**: Plugin commands go through the same rate limiting as regular messages
6. **Marketplace review**: Bot plugins in the marketplace are plain text — easy to audit for harmful prompts

---

## Future Extensions

- **Scheduled actions**: Plugins that trigger at specific times (daily briefing at 8am)
- **Cross-plugin communication**: One plugin's output feeds another's input
- **Plugin analytics**: Track which plugins are popular, gather feedback
- **Community plugins**: Let users create and share plugins via the marketplace
- **Plugin versioning**: Auto-update plugins when new versions are published
- **Context-aware plugins**: Plugins that access conversation history for smarter behavior
- **Webhook plugins**: Plugins that can fetch external data (weather API, RSS feeds) — requires a fetch proxy on the server
