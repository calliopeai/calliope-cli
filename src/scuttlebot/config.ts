import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';

export interface RepoScuttlebotConfig {
  channel?: string;
  channels?: string[];
  /** HTTP API base URL (e.g. "https://scuttlebot.net"). Not a secret — safe in yaml. */
  url?: string;
  /** IRC server address "host:port" (e.g. "irc.scuttlebot.net:6667"). */
  irc_addr?: string;
  /** Use TLS for IRC. Inferred from port 6697 if not specified. */
  tls?: boolean;
  /** Stable pre-registered IRC nick. Overridden by SCUTTLEBOT_NICK env var. */
  nick?: string;
}

export interface ResolvedChannelConfig {
  channel: string;
  channels: string[];
  /** From .scuttlebot.yaml url field (overridden by SCUTTLEBOT_URL env var). */
  url?: string;
  /** From .scuttlebot.yaml irc_addr field (overridden by SCUTTLEBOT_IRC_ADDR env var). */
  ircAddr?: string;
  /** From .scuttlebot.yaml tls field. */
  tls?: boolean;
  /** From .scuttlebot.yaml nick field (overridden by SCUTTLEBOT_NICK env var). */
  nick?: string;
}

function normalizeChannelName(channel: string): string {
  return channel.trim().replace(/^#/, '');
}

function parseChannels(raw?: string): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(',')
    .map(normalizeChannelName)
    .filter(Boolean);
}

function allChannels(config: RepoScuttlebotConfig): string[] {
  const combined = [
    ...(config.channel ? [config.channel] : []),
    ...(config.channels ?? []),
  ];

  return combined.map(normalizeChannelName).filter(Boolean);
}

export function mergeChannels(existing: string[], extra: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const channel of [...existing, ...extra]) {
    const normalized = normalizeChannelName(channel);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    merged.push(normalized);
  }

  return merged;
}

export function loadRepoConfig(dir: string): RepoScuttlebotConfig | null {
  let current = path.resolve(dir);

  for (;;) {
    const candidate = path.join(current, '.scuttlebot.yaml');
    if (fs.existsSync(candidate)) {
      const raw = fs.readFileSync(candidate, 'utf-8');
      const parsed = parseYaml(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {};
      }

      const config = parsed as Record<string, unknown>;
      return {
        channel: typeof config.channel === 'string' ? config.channel : undefined,
        channels: Array.isArray(config.channels)
          ? config.channels.filter((value): value is string => typeof value === 'string')
          : undefined,
        url: typeof config.url === 'string' ? config.url : undefined,
        irc_addr: typeof config.irc_addr === 'string' ? config.irc_addr : undefined,
        tls: typeof config.tls === 'boolean' ? config.tls : undefined,
        nick: typeof config.nick === 'string' ? config.nick : undefined,
      };
    }

    // Stop once we reach the repo root.
    if (fs.existsSync(path.join(current, '.git'))) {
      return null;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function resolveChannelConfig(cwd: string, channel?: string, channelsEnv?: string): ResolvedChannelConfig {
  const explicitChannel = channel ? normalizeChannelName(channel) : '';
  let channels = parseChannels(channelsEnv);
  if (channels.length === 0 && explicitChannel) {
    channels = [explicitChannel];
  }

  const repoConfig = loadRepoConfig(cwd);
  if (repoConfig) {
    channels = mergeChannels(channels, allChannels(repoConfig));
  }

  if (channels.length === 0) {
    channels = ['general'];
  }

  return {
    channel: channels[0]!,
    channels,
    url: repoConfig?.url,
    ircAddr: repoConfig?.irc_addr,
    tls: repoConfig?.tls,
    nick: repoConfig?.nick,
  };
}
