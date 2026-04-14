import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadRepoConfig, mergeChannels, resolveChannelConfig } from '../src/scuttlebot/config.js';

function makeTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-scuttlebot-'));
  fs.mkdirSync(path.join(dir, '.git'));
  return dir;
}

function write(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('loadRepoConfig', () => {
  it('loads .scuttlebot.yaml from the repo root when called from a nested directory', () => {
    const repo = makeTempRepo();
    tempDirs.push(repo);
    write(path.join(repo, '.scuttlebot.yaml'), 'channel: calliope\nchannels:\n  - release\n');
    const nested = path.join(repo, 'src', 'ui');
    fs.mkdirSync(nested, { recursive: true });

    expect(loadRepoConfig(nested)).toEqual({
      channel: 'calliope',
      channels: ['release'],
    });
  });

  it('returns null when no repo config exists', () => {
    const repo = makeTempRepo();
    tempDirs.push(repo);
    const nested = path.join(repo, 'src');
    fs.mkdirSync(nested, { recursive: true });

    expect(loadRepoConfig(nested)).toBeNull();
  });
});

describe('mergeChannels', () => {
  it('deduplicates while preserving order', () => {
    expect(mergeChannels(['general', '#calliope'], ['calliope', 'release'])).toEqual([
      'general',
      'calliope',
      'release',
    ]);
  });
});

describe('resolveChannelConfig', () => {
  it('uses repo config as additional channels and keeps the primary env/default channel first', () => {
    const repo = makeTempRepo();
    tempDirs.push(repo);
    write(path.join(repo, '.scuttlebot.yaml'), 'channel: calliope\nchannels:\n  - release\n');

    expect(resolveChannelConfig(repo, 'general', 'team')).toEqual({
      channel: 'team',
      channels: ['team', 'calliope', 'release'],
    });
  });

  it('uses repo config as the primary channel when no env channel is set', () => {
    const repo = makeTempRepo();
    tempDirs.push(repo);
    write(path.join(repo, '.scuttlebot.yaml'), 'channel: calliope\n');

    expect(resolveChannelConfig(repo)).toEqual({
      channel: 'calliope',
      channels: ['calliope'],
    });
  });
});
