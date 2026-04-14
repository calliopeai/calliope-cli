import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';

export interface RepoScuttlebotConfig {
  channel?: string;
  channels?: string[];
}

export interface ResolvedChannelConfig {
  channel: string;
  channels: string[];
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
    channel: channels[0],
    channels,
  };
}
