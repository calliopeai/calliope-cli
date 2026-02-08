import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/bin.ts',
        // React/Ink UI — needs integration testing, not unit tests
        'src/ui/**/*.tsx',
        'src/ui/agent.ts',
        'src/ui/commands.ts',
        'src/ui/completions.ts',
        'src/ui/context.ts',
        'src/ui/pack-picker.tsx',
        // Theme pack registries (data only, no logic)
        'src/hud/theme-packs/index.ts',
        'src/hud/theme-packs/gaming/index.ts',
        'src/hud/theme-packs/trek/index.ts',
        'src/hud/theme-packs/scifi/index.ts',
        'src/hud/theme-packs/retro/index.ts',
        'src/hud/theme-packs/cultural/index.ts',
        'src/hud/theme-packs/seasonal/index.ts',
        'src/hud/theme-packs/minimal/index.ts',
        'src/cli/index.ts',
        'src/providers/index.ts',
        // Pure type files (no runtime code)
        'src/types.ts',
        'src/hud/types.ts',
        'src/hud/theme-packs/types.ts',
        'src/ui/types.ts',
        'src/cli/types.ts',
        'src/providers/types.ts',
        'src/agterm/types.ts',
        // Interactive CLI (requires terminal, user input)
        'src/cli/commands.ts',
        'src/cli/agent.ts',
        'src/cli/completion.ts',
        'src/setup.ts',
        'src/headless.ts',
        'src/cli-backend.ts',
      ],
    },
  },
});
