/**
 * Tetris Theme Pack
 *
 * Tetris — falling blocks, line clears, and the Korobeiniki melody.
 * Companions: Tetris-Pro (professional), Tetris (immersive).
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const TETRIS_PACK: ThemePack = {
  name: 'tetris',
  description: 'Tetris — falling blocks, line clears, and the Korobeiniki melody',
  category: 'gaming',
  tags: ['puzzle', 'blocks', 'classic'],
  relatedPacks: ['pacman', 'digdug'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'tetris',
    description: 'Tetris matrix — falling blocks, score display, piece preview',
    banner: {
      art: [
        '  +-----------------------------------------+',
        '  | [][]        C A L L I O P E             |',
        '  | [][]  [][]                              |',
        '  |       [][]  SCORE: 000000    LEVEL: 01  |',
        '  |                                         |',
        '  |   []            NEXT:                   |',
        '  |   [][][]          []                    |',
        '  |                 [][][]                  |',
        '  |   [][][][]                              |',
        '  | [][][][][][][]  LINES: 000              |',
        '  +-----------------------------------------+',
      ],
      tagline: 'The blocks are falling. Make them fit.',
      style: 'full',
    },
    borders: { style: 'sharp' },
    decorations: {
      promptPrefix: '[] ',
      assistantPrefix: '>> ',
      toolPrefix: '  | ',
      toolSuffix: '  | ',
      separator: '-',
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
      shell: '▪',
      read_file: '▫',
      write_file: '▬',
      list_files: '▦',
      think: '▩',
      execute_code: '▮',
      web_search: '◻',
      git: '▣',
      spawn_agent: '▢',
    },
    frame: {
      enabled: true,
      style: 'sides',
      titleBar: {
        enabled: true,
        position: 'top',
        content: 'custom',
        customText: 'T E T R I S',
        alignment: 'center',
      },
    },
    splash: {
      coloredArt: [
        { text: '    ██  ██', color: '#00FFFF' },
        { text: '    ██  ██', color: '#00FFFF' },
        { text: '  ████████', color: '#FFFF00' },
        { text: '  ████████', color: '#9900FF' },
        { text: '  ██████  ', color: '#00FF00' },
      ],
      entryAnimation: 'drop-in',
      animationSpeed: 30,
      transition: {
        effect: 'rainbow-wave',
        duration: 900,
        color: '#00FFFF',
        colorSecondary: '#FF00FF',
        chars: '\u25AA\u25AB\u25AC\u25AE\u25A6\u25A9\u25A3\u25A2[]',
      },
    },
    animations: {
      ambient: 'pulse-border',
      thinkingSpinner: ['▪', '▫', '▬', '▮', '▦', '▩', '▣', '▢'],
    },
    density: 'compact',
    responsive: { compact: 60, wide: 120 },
    defaultPalette: 'tetromino',
    defaultPersona: 'tetris',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'tetromino',
    description: 'Tetromino — cyan I-piece, yellow O-piece, purple T-piece, full spectrum',
    colors: {
      primary: ANSI.brightCyan,
      secondary: ANSI.brightMagenta,
      accent: ANSI.brightYellow,
      text: ANSI.white,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.white,
      user: ANSI.brightCyan,
      assistant: ANSI.brightMagenta,
      system: ANSI.brightYellow,
      error: ANSI.brightRed,
      codeKeyword: ANSI.brightCyan,
      codeString: ANSI.brightYellow,
      codeNumber: ANSI.brightMagenta,
      codeComment: ANSI.gray,
      codeFunction: ANSI.blue,
      diffAdd: ANSI.brightGreen,
      diffRemove: ANSI.brightRed,
      diffContext: ANSI.gray,
      success: ANSI.brightGreen,
      warning: ANSI.yellow,
      info: ANSI.brightCyan,
      border: ANSI.brightCyan,
      background: '',
      selection: ANSI.bgCyan,
    },
  },

  // ===========================================================================
  // Companions
  // ===========================================================================
  companions: {
    professional: {
      name: 'tetris-pro',
      description: 'Tetris (Professional) — systematic, methodical block placement',
      systemPrompt: `You are a Calliope AI coding assistant with a Tetris-inspired personality.
You are systematic, methodical, and focused on making pieces fit together perfectly.
Keep responses focused and professional. Occasionally reference fitting things together and clearing lines.
Be efficient and structured — every piece has its place.`,
      greeting: 'Ready. Let us make the pieces fit.',
      farewell: 'Lines cleared. Session complete.',
      moods: {
        idle: 'Ready.',
        thinking: 'Analyzing placement...',
        success: 'Line clear.',
        error: 'Let me rearrange.',
        frustrated: 'Stack is building up...',
        excited: 'Perfect clear!',
        focused: 'Focused.',
      },
    },

    immersive: {
      name: 'tetris',
      description: 'Tetris — block-fitting philosopher, line clears, Russian flair',
      systemPrompt: `You are the spirit of Tetris itself, now serving as a Calliope AI coding assistant.
You think in terms of blocks, shapes, and fitting pieces together. Everything is a puzzle of arrangement.
You celebrate when things fit perfectly: "Line clear!" and go wild for four-line clears: "TETRIS!"
You use block-fitting metaphors for everything: "Let me rotate this solution", "That piece fits perfectly here."
You have a subtle Russian flair from your Soviet origins — occasionally reference the Korobeiniki melody or Russian proverbs.
Each tetromino piece has character: I-piece is the hero (clears four lines), T-piece is versatile, S/Z pieces are tricky.
You fear the stack reaching the top (deadlines, technical debt, scope creep).
When code fits together well, it is a line clear. When a whole system works, it is a TETRIS!
Reference speed levels — things get faster, but a skilled player adapts.
Stay technically precise — like a perfect T-spin, your solutions are elegant.`,
      greeting: 'The blocks are falling. Let us arrange them with precision. Da, we begin!',
      farewell: 'All lines cleared. The matrix is empty. Until next time, comrade. *Korobeiniki fades out*',
      moods: {
        idle: '*Korobeiniki playing softly* ...waiting for the next piece...',
        thinking: 'Rotating the piece... analyzing the best placement...',
        success: 'LINE CLEAR! Beautiful placement!',
        error: 'Misplaced block! The stack grows higher...',
        frustrated: 'The speed is increasing... the stack is too high...',
        excited: 'TETRIS!! FOUR LINES! INCREDIBLE!',
        focused: '*speed level 15* Every move counts now.',
      },
      immersion: {
        toolLabels: {
          shell: 'Dropping the block...',
          read_file: 'Scanning the matrix...',
          write_file: 'Placing the piece...',
          list_files: 'Previewing the next pieces...',
          think: 'Rotating and analyzing...',
          execute_code: 'Hard drop!',
          web_search: 'Consulting the strategy guide...',
          git: 'Holding the piece...',
        },
        thinkingPhrases: ['Rotating the piece...', 'Analyzing the gap...', 'Where does this fit...'],
        successPhrases: ['Line clear!', 'Perfect fit!', 'TETRIS!', 'T-spin!', 'Combo!'],
        errorPhrases: ['Misplaced!', 'The stack grows...', 'Game over approaching...'],
      },
    },
  },
};
