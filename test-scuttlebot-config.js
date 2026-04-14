#!/usr/bin/env node

import { resolveChannelConfig } from './dist/scuttlebot/config.js';

console.log('Testing scuttlebot config resolution...\n');

// Test 1: Load from .scuttlebot.yaml in current directory
console.log('Test 1: Load from .scuttlebot.yaml');
const config1 = resolveChannelConfig(process.cwd());
console.log('  Result:', config1);
console.log('  ✓ Should use "calliope" channel from .scuttlebot.yaml\n');

// Test 2: Override with explicit channel
console.log('Test 2: Explicit channel override');
const config2 = resolveChannelConfig(process.cwd(), 'testing');
console.log('  Result:', config2);
console.log('  ✓ Should use "testing" as primary, but include "calliope" in channels\n');

// Test 3: Environment variable channels
console.log('Test 3: SCUTTLEBOT_CHANNELS env var');
const config3 = resolveChannelConfig(process.cwd(), undefined, 'dev,staging');
console.log('  Result:', config3);
console.log('  ✓ Should merge env channels with repo config\n');

// Test 4: All three combined
console.log('Test 4: All sources combined');
const config4 = resolveChannelConfig(process.cwd(), 'primary', 'env1,env2');
console.log('  Result:', config4);
console.log('  ✓ Should prioritize explicit channel, merge all sources\n');

console.log('✅ All tests complete!');
