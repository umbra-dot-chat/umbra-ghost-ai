/**
 * Wisp command detection — detects wisp-related intents in user messages
 * and calls the wisp orchestrator HTTP API to execute them.
 */

import type { Logger } from '../config.js';

const WISP_API_URL = process.env.WISP_API_URL || 'http://localhost:3334';

/** Pattern-to-action mappings for wisp intent detection */
const WISP_PATTERNS: { pattern: RegExp; action: string }[] = [
  { pattern: /bring\s+in\s+(the\s+)?wisps/i, action: 'summon' },
  { pattern: /summon\s+(the\s+)?wisps/i, action: 'summon' },
  { pattern: /invite\s+(the\s+)?wisps/i, action: 'summon' },
  { pattern: /release\s+the\s+(gremlins|goblins)/i, action: 'summon' },
  { pattern: /let\s+loose\s+the\s+wisps/i, action: 'summon' },
  { pattern: /add\s+(some\s+)?friends/i, action: 'befriend' },
  { pattern: /start\s+a?\s*group\s+chat/i, action: 'create-group' },
  { pattern: /run\s+(the\s+)?(\w+)\s+scenario/i, action: 'scenario' },
  { pattern: /wisp\s+status/i, action: 'status' },
  // Community commands
  { pattern: /have\s+(the\s+)?wisps\s+join\s+(the\s+)?community/i, action: 'community-join' },
  { pattern: /wisps?\s+join\s+(the\s+)?community/i, action: 'community-join' },
  { pattern: /wisps?\s+leave\s+(the\s+)?community/i, action: 'community-leave' },
  { pattern: /community\s+(activity\s+)?status/i, action: 'community-status' },
  { pattern: /start\s+community\s+activity/i, action: 'community-activity-start' },
  { pattern: /stop\s+community\s+activity/i, action: 'community-activity-stop' },
  { pattern: /community\s+message\s+rate/i, action: 'community-activity-rate' },
  // Voice commands
  { pattern: /put\s+(some\s+)?wisps?\s+in\s+voice/i, action: 'voice-join' },
  { pattern: /wisps?\s+join\s+voice/i, action: 'voice-join' },
  { pattern: /wisps?\s+leave\s+voice/i, action: 'voice-leave' },
  { pattern: /voice\s+(channel\s+)?status/i, action: 'voice-status' },
  // Schedule commands
  { pattern: /enable\s+wisp\s+schedul/i, action: 'schedule-on' },
  { pattern: /turn\s+on\s+(wisp\s+)?schedul/i, action: 'schedule-on' },
  { pattern: /disable\s+wisp\s+schedul/i, action: 'schedule-off' },
  { pattern: /turn\s+off\s+(wisp\s+)?schedul/i, action: 'schedule-off' },
  { pattern: /schedul(e|ing)\s+status/i, action: 'schedule-status' },
];

export interface WispCommandResult {
  detected: boolean;
  action?: string;
  response?: string;
}

/**
 * Scan a user message for wisp-related intents. If one is found,
 * call the wisp orchestrator HTTP API and return a fun response.
 */
export async function detectAndExecuteWispCommand(
  message: string,
  userDid: string,
  log: Logger,
): Promise<WispCommandResult> {
  for (const { pattern, action } of WISP_PATTERNS) {
    const match = message.match(pattern);
    if (!match) continue;

    log.info(`Wisp command detected: action="${action}" from message`);

    try {
      switch (action) {
        case 'summon': {
          await fetch(`${WISP_API_URL}/wisps/summon`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userDid }),
          });
          return {
            detected: true,
            action,
            response:
              'The wisps are on their way! You should receive friend requests ' +
              'from all 12 wisps shortly — Nyx, Flicker, Bramble, Pixel, Rook, Mote, ' +
              'Cinder, Whisper, Drift, Jinx, Echo, and Volt. They\'re a quirky ' +
              'bunch — give them a moment to settle in.',
          };
        }

        case 'befriend': {
          await fetch(`${WISP_API_URL}/wisps/befriend-user`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ did: userDid }),
          });
          return {
            detected: true,
            action,
            response:
              'I\'ve sent the wisps your way! They\'ll each send you a friend ' +
              'request. Accept them and they\'ll chat with you in character. ' +
              'Fair warning — Flicker is... energetic.',
          };
        }

        case 'create-group': {
          await fetch(`${WISP_API_URL}/wisps/create-group`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'Wisp Hollow', userDid }),
          });
          return {
            detected: true,
            action,
            response:
              'Done! I\'ve created a group called "Wisp Hollow" with all the ' +
              'wisps. You should see the invite pop up. It\'s... going to get ' +
              'chaotic in there.',
          };
        }

        case 'scenario': {
          const scenarioName = match[2] || 'day-in-the-life';
          await fetch(`${WISP_API_URL}/wisps/scenario`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: scenarioName }),
          });
          return {
            detected: true,
            action,
            response:
              `Running the "${scenarioName}" scenario! The wisps are doing ` +
              'their thing. Check your messages in a moment.',
          };
        }

        case 'status': {
          const resp = await fetch(`${WISP_API_URL}/wisps/status`);
          const data = (await resp.json()) as {
            wispCount?: number;
            running?: boolean;
            wisps?: { name: string }[];
          };
          const names = data.wisps?.map((w) => w.name).join(', ') || 'none';
          const state = data.running ? 'running' : 'idle';
          return {
            detected: true,
            action,
            response:
              `Wisp swarm status: ${data.wispCount ?? 0} active wisps ` +
              `(${names}). All connected and ${state}.`,
          };
        }

        case 'community-join':
          return { detected: true, action, response: 'Community join requires syncing community data from the app. Use the community sync feature in Umbra settings to push community info to Ghost.' };
        case 'community-leave':
          return { detected: true, action, response: 'To leave a community, use: /swarm community leave <community-id>' };
        case 'community-status':
          return handleCommunityStatus(log);
        case 'community-activity-start':
          return handleCommunityActivityStart(log);
        case 'community-activity-stop':
          return handleCommunityActivityStop(log);
        case 'community-activity-rate':
          return { detected: true, action, response: 'To set the rate, use: /swarm community activity rate <msgs-per-hour>' };
        case 'voice-join':
          return { detected: true, action, response: 'To join a voice channel, use: /swarm voice join <channel-id>' };
        case 'voice-leave':
          return handleVoiceLeave(log);
        case 'voice-status':
          return handleVoiceStatus(log);
        case 'schedule-on':
          return handleScheduleOn(log);
        case 'schedule-off':
          return handleScheduleOff(log);
        case 'schedule-status':
          return handleScheduleStatus(log);
      }
    } catch (err) {
      log.warn(`Wisp API call failed for action="${action}":`, err);
      return {
        detected: true,
        action,
        response:
          'Hmm, the wisps seem to be sleeping right now. Make sure the wisp ' +
          'swarm is running (`wisps start`) and try again!',
      };
    }
  }

  return { detected: false };
}

/**
 * Handle explicit /swarm <subcommand> slash commands.
 * Unlike detectAndExecuteWispCommand (natural language), this only
 * matches the exact /swarm prefix.
 *
 * Supports multi-level subcommands:
 *   /swarm community join <invite-code>
 *   /swarm voice join <channel-id>
 *   /swarm schedule on
 */
export async function handleSwarmCommand(
  message: string,
  userDid: string,
  log: Logger,
): Promise<WispCommandResult> {
  const match = message.match(/^\/swarm\s+(.+)$/i);
  if (!match) return { detected: false };

  const tokens = match[1].trim().split(/\s+/);
  const subcommand = tokens[0].toLowerCase();

  log.info(`Swarm command: /swarm ${tokens.join(' ')}`);

  try {
    switch (subcommand) {
      // ── Existing commands ──────────────────────────────────────
      case 'summon': {
        await fetch(`${WISP_API_URL}/wisps/summon`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userDid }),
        });
        return {
          detected: true, action: 'summon',
          response: 'Summoning the wisp swarm! You\'ll receive friend requests from Nyx, Flicker, Bramble, and Pixel shortly, followed by a group chat invite.',
        };
      }
      case 'status': {
        const resp = await fetch(`${WISP_API_URL}/wisps/status`);
        const data = await resp.json() as { wispCount?: number; running?: boolean; wisps?: { name: string }[] };
        const names = data.wisps?.map((w) => w.name).join(', ') || 'none';
        return {
          detected: true, action: 'status',
          response: `Swarm status: ${data.wispCount ?? 0} wisps active (${names}). ${data.running ? 'Running' : 'Idle'}.`,
        };
      }
      case 'group': {
        const groupName = tokens.slice(1).join(' ') || 'Wisp Hollow';
        await fetch(`${WISP_API_URL}/wisps/create-group`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: groupName, userDid }),
        });
        return {
          detected: true, action: 'create-group',
          response: `Created group "${groupName}" with all wisps! Check your group invites.`,
        };
      }
      case 'list': {
        const resp = await fetch(`${WISP_API_URL}/wisps/status`);
        const data = await resp.json() as { wisps?: { name: string }[] };
        const wispList = data.wisps?.map((w) => `- ${w.name}`).join('\n') || 'No wisps available';
        return {
          detected: true, action: 'list',
          response: `Available wisps:\n${wispList}`,
        };
      }
      case 'scenario': {
        const scenarioName = tokens[1] || 'group-chat';
        await fetch(`${WISP_API_URL}/wisps/scenario`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: scenarioName }),
        });
        return {
          detected: true, action: 'scenario',
          response: `Running "${scenarioName}" scenario! Watch the wisps do their thing.`,
        };
      }

      // ── Community commands ─────────────────────────────────────
      case 'community':
        return handleCommunitySubcommand(tokens.slice(1), userDid, log);

      // ── Voice commands ─────────────────────────────────────────
      case 'voice':
        return handleVoiceSubcommand(tokens.slice(1), log);

      // ── Schedule commands ──────────────────────────────────────
      case 'schedule':
        return handleScheduleSubcommand(tokens.slice(1), log);

      default:
        return {
          detected: true, action: 'unknown',
          response: `Unknown swarm command: "${subcommand}". Try: summon, status, group, list, scenario, community, voice, schedule.`,
        };
    }
  } catch (err) {
    log.warn(`Swarm API call failed for "${subcommand}":`, err);
    return {
      detected: true, action: subcommand,
      response: 'The wisps seem to be sleeping. Make sure the wisp swarm is running and try again!',
    };
  }
}

// ── Community subcommand router ──────────────────────────────────────────────

async function handleCommunitySubcommand(
  tokens: string[],
  userDid: string,
  log: Logger,
): Promise<WispCommandResult> {
  const sub = tokens[0]?.toLowerCase();

  switch (sub) {
    case 'join': {
      // Community join requires full CommunityInfo (synced from the app), not an invite code.
      // The /wisps/community/join endpoint expects { info: CommunityInfo } with channels, members, etc.
      return {
        detected: true, action: 'community-join',
        response: 'Community join requires syncing community data from the app. Use the community sync feature in Umbra settings to push community info to Ghost, which will register the community for wisp activity.',
      };
    }

    case 'leave': {
      const communityId = tokens[1];
      if (!communityId) {
        return {
          detected: true, action: 'community-leave',
          response: 'Usage: /swarm community leave <community-id>',
        };
      }
      log.info(`Community leave requested for: ${communityId}`);
      await fetch(`${WISP_API_URL}/wisps/community/leave`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ communityId }),
      });
      return {
        detected: true, action: 'community-leave',
        response: `All wisps are leaving community ${communityId}. They\'ll pack their bags and head out.`,
      };
    }

    case 'status':
      return handleCommunityStatus(log);

    case 'activity': {
      const actSub = tokens[1]?.toLowerCase();
      switch (actSub) {
        case 'start':
          return handleCommunityActivityStart(log);
        case 'stop':
          return handleCommunityActivityStop(log);
        case 'rate': {
          const rate = parseInt(tokens[2], 10);
          if (!rate || rate < 1) {
            return {
              detected: true, action: 'community-activity-rate',
              response: 'Usage: /swarm community activity rate <msgs-per-hour> (minimum 1)',
            };
          }
          return handleCommunityActivityRate(rate, log);
        }
        default:
          return {
            detected: true, action: 'community-activity',
            response: 'Usage: /swarm community activity <start|stop|rate <n>>',
          };
      }
    }

    default:
      return {
        detected: true, action: 'community',
        response: 'Community commands: join <invite-code>, leave <community-id>, status, activity <start|stop|rate>',
      };
  }
}

// ── Voice subcommand router ──────────────────────────────────────────────────

async function handleVoiceSubcommand(
  tokens: string[],
  log: Logger,
): Promise<WispCommandResult> {
  const sub = tokens[0]?.toLowerCase();

  switch (sub) {
    case 'join': {
      const channelId = tokens[1];
      if (!channelId) {
        return {
          detected: true, action: 'voice-join',
          response: 'Usage: /swarm voice join <channel-id>',
        };
      }
      log.info(`Voice join requested for channel: ${channelId}`);
      await fetch(`${WISP_API_URL}/wisps/voice/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId }),
      });
      return {
        detected: true, action: 'voice-join',
        response: `Some wisps are joining voice channel ${channelId}. Expect chatter!`,
      };
    }

    case 'leave':
      return handleVoiceLeave(log);

    case 'status':
      return handleVoiceStatus(log);

    default:
      return {
        detected: true, action: 'voice',
        response: 'Voice commands: join <channel-id>, leave, status',
      };
  }
}

// ── Schedule subcommand router ───────────────────────────────────────────────

async function handleScheduleSubcommand(
  tokens: string[],
  log: Logger,
): Promise<WispCommandResult> {
  const sub = tokens[0]?.toLowerCase();

  switch (sub) {
    case 'on':
      return handleScheduleOn(log);
    case 'off':
      return handleScheduleOff(log);
    case 'status':
      return handleScheduleStatus(log);
    default:
      return {
        detected: true, action: 'schedule',
        response: 'Schedule commands: on, off, status',
      };
  }
}

// ── Shared handler functions ─────────────────────────────────────────────────

async function handleCommunityStatus(log: Logger): Promise<WispCommandResult> {
  const resp = await fetch(`${WISP_API_URL}/wisps/community/status`);
  const data = await resp.json() as {
    communities?: { id: string; name: string; memberCount: number; messageCount?: number }[];
  };
  if (!data.communities?.length) {
    return {
      detected: true, action: 'community-status',
      response: 'The wisps are not in any communities yet. Use /swarm community join <invite-code> to join one.',
    };
  }
  const lines = data.communities.map(
    (c) => `- ${c.name} (${c.id.slice(0, 8)}...): ${c.memberCount} members, ${c.messageCount ?? 0} messages sent`,
  );
  return {
    detected: true, action: 'community-status',
    response: `Community status:\n${lines.join('\n')}`,
  };
}

async function handleCommunityActivityStart(log: Logger): Promise<WispCommandResult> {
  log.info('Starting community activity engine');
  await fetch(`${WISP_API_URL}/wisps/community/activity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'start' }),
  });
  return {
    detected: true, action: 'community-activity-start',
    response: 'Community activity engine started! The wisps will begin chatting in community channels.',
  };
}

async function handleCommunityActivityStop(log: Logger): Promise<WispCommandResult> {
  log.info('Stopping community activity engine');
  await fetch(`${WISP_API_URL}/wisps/community/activity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'stop' }),
  });
  return {
    detected: true, action: 'community-activity-stop',
    response: 'Community activity engine stopped. The wisps are taking a break.',
  };
}

async function handleCommunityActivityRate(
  msgsPerHour: number,
  log: Logger,
): Promise<WispCommandResult> {
  log.info(`Setting community activity rate to ${msgsPerHour} msgs/hour`);
  await fetch(`${WISP_API_URL}/wisps/community/activity`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'rate', msgsPerHour }),
  });
  return {
    detected: true, action: 'community-activity-rate',
    response: `Community activity rate set to ${msgsPerHour} messages per hour.`,
  };
}

async function handleVoiceLeave(log: Logger): Promise<WispCommandResult> {
  log.info('All wisps leaving voice channels');
  await fetch(`${WISP_API_URL}/wisps/voice/leave`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  return {
    detected: true, action: 'voice-leave',
    response: 'All wisps are leaving voice channels.',
  };
}

async function handleVoiceStatus(log: Logger): Promise<WispCommandResult> {
  const resp = await fetch(`${WISP_API_URL}/wisps/voice/status`);
  const data = await resp.json() as {
    channels?: { channelId: string; channelName?: string; wisps: string[] }[];
  };
  if (!data.channels?.length) {
    return {
      detected: true, action: 'voice-status',
      response: 'No wisps are currently in voice channels.',
    };
  }
  const lines = data.channels.map(
    (c) => `- ${c.channelName ?? c.channelId}: ${c.wisps.join(', ')}`,
  );
  return {
    detected: true, action: 'voice-status',
    response: `Voice channel status:\n${lines.join('\n')}`,
  };
}

async function handleScheduleOn(log: Logger): Promise<WispCommandResult> {
  log.info('Enabling presence scheduling');
  await fetch(`${WISP_API_URL}/wisps/schedule`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  return {
    detected: true, action: 'schedule-on',
    response: 'Presence scheduling enabled. Wisps will rotate on/off in shifts to simulate natural activity patterns.',
  };
}

async function handleScheduleOff(log: Logger): Promise<WispCommandResult> {
  log.info('Disabling presence scheduling');
  await fetch(`${WISP_API_URL}/wisps/schedule`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  return {
    detected: true, action: 'schedule-off',
    response: 'Presence scheduling disabled. All wisps will stay online continuously.',
  };
}

async function handleScheduleStatus(log: Logger): Promise<WispCommandResult> {
  const resp = await fetch(`${WISP_API_URL}/wisps/schedule/status`);
  const data = await resp.json() as {
    enabled?: boolean;
    shifts?: { wispName: string; status: string; nextChange?: string }[];
  };
  if (!data.enabled) {
    return {
      detected: true, action: 'schedule-status',
      response: 'Presence scheduling is disabled. All wisps are online continuously.',
    };
  }
  const lines = (data.shifts ?? []).map(
    (s) => `- ${s.wispName}: ${s.status}${s.nextChange ? ` (next change: ${s.nextChange})` : ''}`,
  );
  return {
    detected: true, action: 'schedule-status',
    response: `Scheduling enabled. Shift assignments:\n${lines.join('\n') || 'No shift data available.'}`,
  };
}
