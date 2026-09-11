/**
 * UI Module - Entry Point
 *
 * TerminalChat (composition), App wrapper, printBanner, startInkCLI. All state
 * and orchestration live in useChatController; the JSX here just wires the four
 * memoized regions together inside the HUD frame.
 */

import { useEffect } from 'react';
import type { MutableRefObject } from 'react';
import { render, Box } from 'ink';
import { selectProvider, ProviderUnavailableError } from '../providers/index.js';
import { DEFAULT_MODELS } from '../types.js';
import type { LLMProvider } from '../types.js';
import { resolvePreferences, type ModelPreference } from '../preferences/index.js';
import { getVersion } from '../version-check.js';
import { getCurrentSkin, paletteColorize } from '../hud/api.js';
import { renderColoredBanner, renderSplashAnimation, renderTransition, colorFg } from '../terminal-image.js';
import { fleetPostOffline } from '../fleet.js';

import { HUDFrame } from './frame.js';
import { ErrorBoundary } from './error-boundary.js';
import { spawnPendingRestart } from './self-restart.js';
import { useChatController } from './state/use-chat-controller.js';
import { TranscriptRegion } from './regions/transcript-region.js';
import { WorkflowRegion } from './regions/workflow-region.js';
import { StatusRegion } from './regions/status-region.js';
import { InputRegion } from './regions/input-region.js';
import { ModalHost } from './regions/modal-host.js';
import { probeMount } from './regions/render-probe.js';

// ============================================================================
// Main Chat Component (composition only)
// ============================================================================

/** Imperative handle exposed for tests/automation to drive a session reset. */
export interface ChatHandle {
  resetSession: () => void;
}

export function TerminalChat({ controllerRef, initialPreference }: { controllerRef?: MutableRefObject<ChatHandle | null>; initialPreference?: ModelPreference }) {
  const c = useChatController(initialPreference);

  // Mount counter for the reset-without-remount assertion (no-op in production).
  useEffect(() => { probeMount('terminal-chat'); }, []);

  // Expose resetSession for tests/automation; production renders without a ref.
  useEffect(() => {
    if (!controllerRef) return;
    controllerRef.current = { resetSession: c.resetSession };
    return () => { controllerRef.current = null; };
  }, [controllerRef, c.resetSession]);

  return (
    <HUDFrame width={c.width}>
      <Box flexDirection="column" width={c.width}>
        <TranscriptRegion {...c.transcript} />
        <ModalHost {...c.modal} />
        <WorkflowRegion {...c.workflow} />
        <InputRegion {...c.input} />
        <StatusRegion {...c.status} />
      </Box>
    </HUDFrame>
  );
}

// ============================================================================
// App Wrapper & Entry Point
// ============================================================================

function App({ initialPreference }: { initialPreference?: ModelPreference }) {
  // The ErrorBoundary swaps in a fallback on a render crash; retrying clears its
  // error state, which remounts TerminalChat fresh — no remount key needed.
  return (
    <ErrorBoundary>
      <TerminalChat initialPreference={initialPreference} />
    </ErrorBoundary>
  );
}

// Print banner before Ink takes over (stays fixed at top)
export async function printBanner(initial?: ModelPreference): Promise<void> {
  const preference = resolvePreferences(process.cwd(), { session: initial });
  const requested = preference.provider;
  // Never claim a provider that won't serve (#217). If the selected provider is
  // unconfigured, show the real selection annotated as such rather than
  // crashing the banner or pretending a working provider.
  let provider: LLMProvider;
  let providerNote = '';
  try {
    provider = selectProvider(requested);
  } catch (err) {
    provider = err instanceof ProviderUnavailableError ? err.provider : requested;
    providerNote = ' (not configured — run calliope --setup)';
  }
  const model = preference.model || DEFAULT_MODELS[provider];
  const skin = getCurrentSkin();

  const dim = '\x1b[2m';
  const reset = '\x1b[0m';

  // Run theme transition on startup if configured
  if (skin.splash?.transition && skin.splash.transition.effect !== 'none') {
    await renderTransition(skin.splash.transition);
  }

  if (skin.banner.style === 'none') {
    // No banner
  } else if (skin.splash?.coloredArt && skin.splash.coloredArt.length > 0) {
    // Rich colored banner from splash config
    console.log();
    if (skin.splash.entryAnimation && skin.splash.entryAnimation !== 'none') {
      // Animated splash
      const coloredLines = skin.splash.coloredArt.map(l => colorFg(l.text, l.color));
      await renderSplashAnimation(
        coloredLines,
        skin.splash.entryAnimation,
        skin.splash.animationSpeed ?? 50,
      );
    } else {
      // Static colored banner
      const banner = renderColoredBanner(
        skin.splash.coloredArt,
        skin.banner.tagline,
      );
      console.log(banner);
    }
    console.log();
    if (skin.banner.tagline && skin.splash.entryAnimation) {
      console.log(`${dim}        ${skin.banner.tagline}${reset}`);
      console.log();
    }
  } else {
    // Standard banner (existing behavior)
    console.log();
    for (const line of skin.banner.art) {
      if (line.includes('\x1b[')) {
        console.log(line);
      } else {
        console.log(paletteColorize(line, 'primary'));
      }
    }
    console.log();
    if (skin.banner.tagline) {
      console.log(`${dim}        ${skin.banner.tagline}${reset}`);
      console.log();
    }
  }

  console.log(`${dim}  v${getVersion()} | ${provider}:${model}${providerNote}${reset}`);
  console.log(`${dim}  /help for commands | ESC to exit${reset}`);
  console.log();
}

export async function startInkCLI(options: { skipPermissions?: boolean; initialPreference?: ModelPreference } = {}): Promise<void> {

  // Print banner BEFORE Ink starts - it stays fixed at the top
  await printBanner(options.initialPreference);

  const { waitUntilExit } = render(<App initialPreference={options.initialPreference} />, {
    patchConsole: true,  // Prevent console.log during session from mixing with Ink
  });
  await waitUntilExit();

  // Session cleanup
  await fleetPostOffline();
  await spawnPendingRestart();
}
