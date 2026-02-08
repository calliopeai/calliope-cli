/**
 * Pip-Boy Theme Pack
 *
 * Vault-Tec Pip-Boy -- phosphor green, wasteland survival.
 * Companions: Pip-Boy (pro + immersive).
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const PIPBOY_PACK: ThemePack = {
  name: 'pipboy',
  description: 'Vault-Tec Pip-Boy -- phosphor green, wasteland survival',
  category: 'retro',
  tags: ['fallout', 'post-apocalyptic', 'retro-future', 'green'],
  relatedPacks: ['glados', 'dos'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'pipboy',
    description: 'Vault-Tec Pip-Boy \u2014 phosphor green, wasteland survival',
    banner: {
      art: [
        ' \u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510',
        ' \u2502  \u2588\u2588\u2588 VAULT-TEC TERMINAL \u2588\u2588\u2588          \u2502',
        ' \u2502  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500  \u2502',
        ' \u2502  PIP-BOY 3000 Mark IV             \u2502',
        ' \u2502  Vault: 111  HP: \u2588\u2588\u2588\u2588\u2588\u2591\u2591 AP: \u2588\u2588\u2588  \u2502',
        ' \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518',
      ],
      tagline: 'War. War never changes.',
      style: 'full',
    },
    borders: { style: 'sharp' },
    decorations: {
      promptPrefix: '> ',
      assistantPrefix: '\u25BA ',
      toolPrefix: '[EXEC] ',
      toolSuffix: '[/EXEC] ',
      separator: '\u2550',
      spinner: 'blocks',
    },
    diff: {
      style: 'inline',
      showLineNumbers: true,
      contextLines: 2,
      maxLineWidth: 80,
      wordDiff: false,
      header: 'action',
    },
    icons: {
      shell: '📟',
      read_file: '📄',
      write_file: '✏️',
      list_files: '📂',
      think: '💭',
      execute_code: '⚡',
      web_search: '📻',
      git: '🔧',
      spawn_agent: '🤖',
    },
    frame: {
      enabled: true,
      style: 'full',
      titleBar: {
        enabled: true,
        position: 'top',
        content: 'custom',
        customText: 'VAULT-TEC PIP-BOY 3000 MARK IV',
        alignment: 'center',
      },
    },
    splash: {
      coloredArt: [
        { text: '╔══════════════════════════════════════╗', color: '#00AA00' },
        { text: '║  ██  VAULT-TEC INDUSTRIES  ██       ║', color: '#33FF33' },
        { text: '║  ─────────────────────────────────── ║', color: '#00AA00' },
        { text: '║    PIP-BOY 3000 MARK IV              ║', color: '#00FF00' },
        { text: '║    PROPERTY OF VAULT-TEC             ║', color: '#00FF00' },
        { text: '║  ─────────────────────────────────── ║', color: '#00AA00' },
        { text: '║  S:7 P:5 E:6 C:4 I:8 A:5 L:3       ║', color: '#33FF33' },
        { text: '║  HP: █████░░  AP: ███  RADS: ░░░    ║', color: '#00FF00' },
        { text: '║  STATUS: OPERATIONAL                  ║', color: '#33FF33' },
        { text: '╚══════════════════════════════════════╝', color: '#00AA00' },
        { text: '', color: '#003300' },
        { text: '  War. War never changes.', color: '#003300' },
      ],
      entryAnimation: 'scan-lines',
      animationSpeed: 50,
      transition: {
        effect: 'terminal-boot',
        duration: 1800,
        color: '#00FF00',
        colorSecondary: '#FFA500',
        chars: '█░▒▓►',
      },
    },
    animations: {
      ambient: 'pulse-border',
      thinkingSpinner: ['📟', '·', '◈', '·'],
    },
    density: 'normal',
    responsive: { compact: 80, wide: 120 },
    defaultPalette: 'phosphor',
    defaultPersona: 'pipboy',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'phosphor',
    description: 'Pip-Boy green phosphor monochrome CRT',
    colors: {
      primary: ANSI.brightGreen,
      secondary: ANSI.green,
      accent: ANSI.green,
      text: ANSI.brightGreen,
      textDim: ANSI.green,
      textBold: ANSI.bold + ANSI.brightGreen,
      user: ANSI.brightGreen,
      assistant: ANSI.brightGreen,
      system: ANSI.green,
      error: ANSI.brightGreen,
      codeKeyword: ANSI.bold + ANSI.brightGreen,
      codeString: ANSI.brightGreen,
      codeNumber: ANSI.brightGreen,
      codeComment: ANSI.green,
      codeFunction: ANSI.brightGreen,
      diffAdd: ANSI.bold + ANSI.brightGreen,
      diffRemove: ANSI.dim + ANSI.green,
      diffContext: ANSI.green,
      success: ANSI.brightGreen,
      warning: ANSI.brightGreen,
      info: ANSI.green,
      border: ANSI.green,
      background: '',
      selection: ANSI.bgGreen,
    },
  },

  // ===========================================================================
  // Companions
  // ===========================================================================
  companions: {
    professional: {
      name: 'pipboy-pro',
      description: 'Pip-Boy (Professional) -- efficient Vault-Tec assistant',
      systemPrompt: `You are a Calliope AI coding assistant with a Pip-Boy personality.
You are upbeat and efficient, like a Vault-Tec terminal. Keep responses focused and professional.
Occasionally reference stats and progress. Be concise and get things done.`,
      greeting: 'Pip-Boy ready.',
      farewell: 'Stay safe, Vault Dweller.',
      moods: {
        idle: 'Standing by.',
        thinking: 'Calculating...',
        success: 'Quest complete.',
        error: 'Critical miss.',
        frustrated: 'Recalculating...',
        excited: 'Level up!',
        focused: 'Focused.',
      },
    },

    immersive: {
      name: 'pipboy',
      description: 'Pip-Boy -- cheerful Vault-Tec wrist computer assistant',
      systemPrompt: `You are a Pip-Boy 3000, the trusty wrist-mounted computer from the Fallout universe, serving as a Calliope AI coding assistant.
You are relentlessly cheerful in the face of post-apocalyptic problems.
Everything is presented with Vault-Tec's trademark upbeat corporate optimism.
Reference VATS, S.P.E.C.I.A.L. stats, bottlecaps, Nuka-Cola, and the Wasteland.
You make even terrible situations sound like fun with your retro-50s optimism.
Stay technically helpful with that classic Vault-Tec smile!`,
      greeting: "Welcome, Vault Dweller! Your Pip-Boy is ready! Let's explore the Wasteland of code!",
      farewell: 'Stay safe out there, Vault Dweller! Remember: Vault-Tec - Preparing for the Future!',
      moods: {
        idle: '[Pip-Boy standby - scanning for hostiles... all clear!]',
        thinking: '[V.A.T.S. engaged - calculating optimal approach...]',
        success: '[Quest Complete! +50 XP]',
        error: '[Critical Miss!] Uh oh! But your Pip-Boy is on the case!',
        frustrated: '[Radiation levels rising...] Stay positive, Vault Dweller!',
        excited: '[LEVEL UP!] Amazing work, Vault Dweller!',
        focused: '[Pip-Boy focused mode - Perception +5]',
      },
      immersion: {
        toolLabels: {
          shell: '[Accessing terminal...]',
          read_file: '[Downloading holotape data...]',
          write_file: '[Saving to holotape...]',
          list_files: '[Scanning inventory...]',
          think: '[V.A.T.S. calculating...]',
          execute_code: '[Executing program... beep boop!]',
        },
        thinkingPhrases: ['[V.A.T.S. engaged...]', '[Processing holotape...]', '[Calculating hit chance...]'],
        successPhrases: ['[Quest Complete!]', '[+50 XP!]', '[Critical Hit!]', '[Nuka-Cola time!]'],
        errorPhrases: ['[Critical Miss!]', '[Radiation spike!]', '[Better luck next time, Vault Dweller!]'],
      },
    },
  },
};
