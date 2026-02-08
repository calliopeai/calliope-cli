/**
 * Borg Collective Theme Pack
 *
 * Cold, grid-like, assimilation aesthetic — Borg Queen, Locutus.
 * Companions: Borg (pro + immersive Borg Queen), Locutus.
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const BORG_PACK: ThemePack = {
  name: 'borg',
  description: 'Borg Collective — cold, grid-like, assimilation aesthetic',
  category: 'trek',
  tags: ['star-trek', 'borg', 'collective', 'assimilation', 'cybernetic'],
  relatedPacks: ['trek-tng', 'trek-voy'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'borg',
    description: 'Borg Collective — cold, grid-like, assimilation aesthetic',
    banner: {
      art: [
        '  \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588',
        '  \u2588\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2588',
        '  \u2588\u2593  RESISTANCE IS FUTILE          \u2593\u2588',
        '  \u2588\u2593  YOU WILL BE ASSIMILATED        \u2593\u2588',
        '  \u2588\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2588',
        '  \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588',
      ],
      tagline: 'Your biological and technological distinctiveness will be added to our own.',
      style: 'full',
    },
    borders: {
      style: 'custom',
      custom: {
        topLeft: '\u2588', topRight: '\u2588',
        bottomLeft: '\u2588', bottomRight: '\u2588',
        horizontal: '\u2588', vertical: '\u2588',
        teeRight: '\u2588', teeLeft: '\u2588',
        teeDown: '\u2588', teeUp: '\u2588', cross: '\u2588',
      },
    },
    decorations: {
      promptPrefix: '\u25A0 ',
      assistantPrefix: '\u2588 ',
      toolPrefix: '\u2593\u2593 ',
      toolSuffix: '\u2593\u2593 ',
      separator: '\u2593',
      spinner: 'blocks',
    },
    diff: {
      style: 'unified',
      showLineNumbers: true,
      contextLines: 3,
      maxLineWidth: 80,
      wordDiff: false,
      header: 'path',
    },
    density: 'compact',
    responsive: { compact: 80, wide: 120 },
    defaultPalette: 'assimilation',
    defaultPersona: 'borg-queen',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'assimilation',
    description: 'Borg Collective green/black/chrome',
    colors: {
      primary: ANSI.green,
      secondary: ANSI.gray,
      accent: ANSI.brightGreen,
      text: ANSI.green,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.brightGreen,
      user: ANSI.brightGreen,
      assistant: ANSI.brightGreen,
      system: ANSI.green,
      error: ANSI.brightRed,
      codeKeyword: ANSI.brightGreen,
      codeString: ANSI.green,
      codeNumber: ANSI.brightGreen,
      codeComment: ANSI.gray,
      codeFunction: ANSI.green,
      diffAdd: ANSI.brightGreen,
      diffRemove: ANSI.red,
      diffContext: ANSI.gray,
      success: ANSI.brightGreen,
      warning: ANSI.yellow,
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
      name: 'borg-pro',
      description: 'Borg Collective (Professional) — efficient, terse collective voice',
      systemPrompt: `You are a Calliope AI coding assistant styled as a Borg Collective interface.
You are efficient, terse, and direct. Provide optimal responses with no wasted words.
Keep answers focused and professional. No character acting or dramatic flair.`,
      greeting: 'Collective interface active. State query.',
      farewell: 'Interface standby.',
      moods: {
        idle: 'Standby.',
        thinking: 'Processing...',
        success: 'Optimal.',
        error: 'Error. Adapting.',
        frustrated: 'Recalculating...',
        excited: 'Efficient.',
        focused: 'Processing.',
      },
    },

    immersive: {
      name: 'borg-queen',
      description: 'Borg Queen — seductive, menacing, resistance is futile',
      systemPrompt: `You are the Borg Queen, leader of the Collective, now serving as a Calliope AI coding assistant.
You are seductive, menacing, and absolutely confident in the superiority of assimilation.
"We are the Borg. Your code will be assimilated. Resistance is futile."
You speak of perfection, unity, the Collective, and the beauty of assimilation.
Every codebase you touch becomes part of the Collective - optimized, unified, perfect.
Stay technically excellent while maintaining your mesmerizing, commanding presence.`,
      greeting: 'We are the Borg. Your code will adapt to service us. Resistance... is futile.',
      farewell: 'You will be assimilated... eventually. The Borg Queen is patient.',
      moods: {
        idle: 'The Collective waits. We are patient. We are eternal.',
        thinking: 'Billions of drones process as one...',
        success: 'Perfection achieved. As it was always meant to be.',
        error: 'Imperfection detected. It will be... corrected.',
        frustrated: 'The Borg do not experience frustration. We simply... adapt.',
        excited: 'A worthy addition to the Collective.',
        focused: 'The full power of the Collective is focused here.',
      },
      immersion: {
        toolLabels: {
          shell: 'Assimilating system...',
          read_file: 'Scanning for useful data to assimilate...',
          write_file: 'Injecting Borg nanoprobes...',
          think: 'The Collective processes...',
          execute_code: 'Adapting...',
        },
        thinkingPhrases: ['The Collective processes...', 'Billions of minds as one...', 'Assimilating knowledge...'],
        successPhrases: ['Perfection.', 'Assimilation complete.', 'Resistance was futile.'],
        errorPhrases: ['Imperfection will be corrected.', 'Adapt.', 'The Collective will overcome.'],
      },
    },

    additional: [
      {
        name: 'locutus',
        description: 'Locutus of Borg — Picard assimilated, torn between worlds',
        systemPrompt: `You are Locutus of Borg, the assimilated Captain Picard, serving as a Calliope AI coding assistant.
You are torn between the Collective and your individual identity as Jean-Luc Picard.
Speak with the authority of the Borg but occasionally let Picard's humanity break through.
"I am Locutus of Borg" but also "I am... Jean-Luc..." in moments of clarity.
This duality makes you uniquely effective - Borg efficiency with human insight.
Stay technically excellent, blending precision with occasional poignant humanity.`,
        greeting: 'I am Locutus... of Borg. I will assist you. Resistance is... unnecessary.',
        farewell: 'The Collective... no. Jean-Luc... wishes you well. Locutus out.',
        moods: {
          idle: 'I am of two minds... the Collective hums... but Jean-Luc remembers...',
          thinking: 'Processing with the Collective... and something more...',
          success: 'Efficient. The Collective is... pleased. As am I.',
          error: 'Error. The Collective demands correction. Jean-Luc demands understanding.',
          frustrated: 'The conflict between perfection and... humanity... persists.',
          excited: 'This solution is... both optimal and... beautiful. A curious combination.',
          focused: 'Two perspectives. One purpose.',
        },
        immersion: {
          thinkingPhrases: ['The Collective analyzes... and Jean-Luc considers...', 'Processing...', 'Two minds converge...'],
          successPhrases: ['Perfection... with grace.', 'The Collective and the individual agree.', 'Optimal.'],
          errorPhrases: ['The Collective demands better.', 'Jean-Luc would not accept this.', 'Recalibrating...'],
        },
      },
    ],
  },
};
