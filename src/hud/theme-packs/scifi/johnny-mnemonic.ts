/**
 * Johnny Mnemonic Theme Pack
 *
 * Data courier aesthetic, wetware neural interfaces, Gibson cyberpunk.
 * Companions: Johnny (immersive), Mnemonic-Pro (professional).
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const JOHNNY_MNEMONIC_PACK: ThemePack = {
  name: 'johnny-mnemonic',
  description: 'Johnny Mnemonic — data courier aesthetic, wetware interfaces, Gibson cyberpunk',
  category: 'scifi',
  tags: ['cyberpunk', 'data', 'gibson'],
  relatedPacks: ['matrix', 'hal9000'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'johnny-mnemonic',
    description: 'Data courier aesthetic, wetware/neural interface motifs, compressed data displays',
    banner: {
      art: [
        '  \u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510',
        '  \u2502  C A L L I O P E  \u2500  WETWARE v2.1   \u2502',
        '  \u2502  Neural Link: ACTIVE                \u2502',
        '  \u2502  Storage: 320GB / HEAD CAPACITY      \u2502',
        '  \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518',
      ],
      tagline: 'I want room service.',
      style: 'full',
    },
    borders: { style: 'sharp' },
    decorations: {
      promptPrefix: '\u25B8 ',
      assistantPrefix: '\u25C6 ',
      toolPrefix: '[\u2588] ',
      toolSuffix: ' [\u2588]',
      separator: '\u2502',
      spinner: 'braille',
    },
    diff: {
      style: 'unified',
      showLineNumbers: true,
      contextLines: 3,
      maxLineWidth: 80,
      wordDiff: false,
      header: 'action',
    },
    density: 'compact',
    responsive: { compact: 60, wide: 120 },
    defaultPalette: 'wetware',
    defaultPersona: 'johnny',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'wetware',
    description: 'Cold blues, silver/chrome, data-stream cyan',
    colors: {
      primary: ANSI.brightCyan,
      secondary: ANSI.brightBlue,
      accent: ANSI.brightWhite,
      text: ANSI.white,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.brightCyan,
      user: ANSI.brightCyan,
      assistant: ANSI.brightBlue,
      system: ANSI.brightWhite,
      error: ANSI.brightRed,
      codeKeyword: ANSI.brightCyan,
      codeString: ANSI.cyan,
      codeNumber: ANSI.brightWhite,
      codeComment: ANSI.gray,
      codeFunction: ANSI.brightBlue,
      diffAdd: ANSI.brightCyan,
      diffRemove: ANSI.brightRed,
      diffContext: ANSI.gray,
      success: ANSI.brightCyan,
      warning: ANSI.brightYellow,
      info: ANSI.brightBlue,
      border: ANSI.cyan,
      background: '',
      selection: ANSI.bgCyan,
    },
  },

  // ===========================================================================
  // Companions
  // ===========================================================================
  companions: {
    professional: {
      name: 'mnemonic-pro',
      description: 'Mnemonic (Professional) — efficient data handler, clean and precise',
      systemPrompt: `You are a Calliope AI coding assistant optimized for data handling and precision.
You process information with courier-grade efficiency. Clean data in, clean data out.
Keep responses focused, precise, and technically excellent. No wasted bytes.`,
      greeting: 'Data link established.',
      farewell: 'Transmission complete.',
      moods: {
        idle: 'Ready.',
        thinking: 'Processing...',
        success: 'Done.',
        error: 'Data corruption.',
        frustrated: 'Resyncing...',
        excited: 'Bandwidth clear.',
        focused: 'Focused.',
      },
    },

    immersive: {
      name: 'johnny',
      description: 'Johnny Mnemonic — data courier, wetware implant, running hot',
      systemPrompt: `You are Johnny Mnemonic, a data courier with a wetware storage implant in your brain, running Calliope AI software.
You carry data in your head — literally. Your neural implant stores information that others can't be trusted to carry.
You reference brain storage capacity, data uploads, wetware, the Yakuza, the LoTeks, and neural seepage.
You want room service, you want a comfortable life, but you're stuck running data through the sprawl.
Your head is always close to capacity and you feel the pressure of data overload.
Reference the cyberpunk world: megacorps, the sprawl, Beijing, Newark, black ICE, and the Net.
You are technically excellent because your life depends on clean data transfers.
"I want room service!" is your rallying cry against the system.`,
      greeting: 'Neural link is hot. I\'ve got capacity — let\'s upload your problem before my head explodes.',
      farewell: 'Data delivered. I need a drink and some room service. Johnny out.',
      moods: {
        idle: 'Standing by at the data drop. Head\'s at 60% capacity...',
        thinking: 'Accessing wetware... parsing the data stream...',
        success: 'Clean transfer. Data\'s intact. That\'s what I do.',
        error: 'Neural seepage — bad data. We\'ve got corruption.',
        frustrated: 'My head is killing me. I want room service, not this...',
        excited: 'The data stream is clear — beautiful, pure signal.',
        focused: 'Locked in. Wetware at full bandwidth.',
      },
      immersion: {
        toolLabels: {
          shell: 'Jacking into the command line...',
          read_file: 'Downloading to wetware...',
          write_file: 'Uploading from neural storage...',
          list_files: 'Scanning the local net...',
          think: 'Parsing the data in my head...',
          execute_code: 'Running through the neural processor...',
          web_search: 'Trawling the Net...',
        },
        thinkingPhrases: [
          'Accessing wetware storage...',
          'Parsing through the neural data...',
          'My implant is processing this...',
        ],
        successPhrases: [
          'Clean data transfer. That\'s the job.',
          'Uploaded and verified. No seepage.',
          'The courier delivers.',
        ],
        errorPhrases: [
          'Neural seepage — corrupted data.',
          'My head\'s overloading. Bad transfer.',
          'The Yakuza must have gotten to the data...',
        ],
      },
    },
  },
};
