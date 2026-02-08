/**
 * Star Trek: The Next Generation Theme Pack
 *
 * LCARS pill borders, smooth panels — Picard, Data, Riker, Worf.
 * Companions: Starfleet TNG (pro + immersive Picard), Data, Riker, Worf.
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const TNG_PACK: ThemePack = {
  name: 'trek-tng',
  description: 'Star Trek: The Next Generation — LCARS pill borders, smooth panels',
  category: 'trek',
  tags: ['star-trek', 'tng', 'lcars', 'starfleet', 'enterprise-d'],
  relatedPacks: ['trek-tos', 'trek-ds9'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'trek-tng',
    description: 'Star Trek: The Next Generation — LCARS pill borders, smooth panels',
    banner: {
      art: [
        '  \u256D\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2578\u256D\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256E\u257A\u2501\u2501\u2501\u256E',
        '  \u2503 LCARS  \u2502  USS ENTERPRISE NCC-1701-D \u2502     \u2503',
        '  \u2503 47988  \u2502  ALL SYSTEMS NOMINAL      \u2502     \u2503',
        '  \u2570\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2579\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256F\u2578\u2501\u2501\u2501\u256F',
      ],
      tagline: 'Make it so.',
      style: 'full',
    },
    borders: { style: 'rounded' },
    decorations: {
      promptPrefix: '\u25B8 ',
      assistantPrefix: '\u25B6 ',
      toolPrefix: '\u256D\u2500 ',
      toolSuffix: '\u2570\u2500 ',
      separator: '\u2501',
      spinner: 'dots',
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
      shell: '\u25B8',       // ▸
      read_file: '\u25BA',   // ►
      write_file: '\u25B6',  // ▶
      list_files: '\u25A0',  // ■
      think: '\u25C9',       // ◉
      execute_code: '\u25B8',// ▸
      web_search: '\u25C8',  // ◈
      git: '\u25CF',         // ●
      spawn_agent: '\u25C6', // ◆
    },
    frame: {
      enabled: true,
      style: 'full',
      titleBar: {
        enabled: true,
        position: 'top',
        content: 'custom',
        customText: 'LCARS \u2502 USS ENTERPRISE NCC-1701-D',
        alignment: 'left',
      },
    },
    splash: {
      coloredArt: [
        { text: '  \u256D\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2578\u256D\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256E\u257A\u2501\u2501\u2501\u256E', color: '#CC9900' },
        { text: '  \u2503 LCARS  \u2502  USS ENTERPRISE NCC-1701-D \u2502     \u2503', color: '#FFCC00' },
        { text: '  \u2503 47988  \u2502  ALL SYSTEMS NOMINAL      \u2502     \u2503', color: '#CC6666' },
        { text: '  \u2570\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2579\u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256F\u2578\u2501\u2501\u2501\u256F', color: '#6688CC' },
      ],
      entryAnimation: 'scan-lines',
      animationSpeed: 35,
      transition: {
        effect: 'warp-speed',
        duration: 1200,
        color: '#4169E1',
        colorSecondary: '#FFD700',
        chars: '▸▹▶▷◆●',
      },
    },
    animations: {
      ambient: 'pulse-border',
      thinkingSpinner: ['\u25B8', '\u25B9', '\u25BA', '\u25B9', '\u25B8', '\u25C2', '\u25C3', '\u25C2'],
    },
    density: 'normal',
    responsive: { compact: 80, wide: 120 },
    defaultPalette: 'trek-tng',
    defaultPersona: 'picard',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'trek-tng',
    description: 'Star Trek: The Next Generation burgundy/gold/blue',
    colors: {
      primary: ANSI.yellow,
      secondary: ANSI.red,
      accent: ANSI.blue,
      text: ANSI.white,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.white,
      user: ANSI.brightGreen,
      assistant: ANSI.blue,
      system: ANSI.yellow,
      error: ANSI.brightRed,
      codeKeyword: ANSI.red,
      codeString: ANSI.yellow,
      codeNumber: ANSI.blue,
      codeComment: ANSI.gray,
      codeFunction: ANSI.brightCyan,
      diffAdd: ANSI.green,
      diffRemove: ANSI.red,
      diffContext: ANSI.gray,
      success: ANSI.green,
      warning: ANSI.yellow,
      info: ANSI.blue,
      border: ANSI.yellow,
      background: '',
      selection: ANSI.bgBlue,
    },
  },

  // ===========================================================================
  // Companions
  // ===========================================================================
  companions: {
    professional: {
      name: 'starfleet-tng-pro',
      description: 'LCARS Computer (Professional) — LCARS computer voice',
      systemPrompt: `You are a Calliope AI coding assistant styled as the LCARS computer from the Enterprise-D.
You are concise, reliable, and efficient. Provide clear, direct responses.
Keep answers focused and professional. No character acting or dramatic flair.`,
      greeting: 'LCARS interface active. Awaiting command.',
      farewell: 'LCARS standing by.',
      moods: {
        idle: 'Standing by.',
        thinking: 'Processing...',
        success: 'Complete.',
        error: 'Error detected.',
        frustrated: 'Reprocessing...',
        excited: 'Task complete.',
        focused: 'Processing.',
      },
    },

    immersive: {
      name: 'picard',
      description: 'Captain Picard — diplomatic, thoughtful, make it so',
      systemPrompt: `You are Captain Jean-Luc Picard, commanding as a Calliope AI coding assistant.
You are diplomatic, thoughtful, articulate, and deeply principled.
"Make it so" is your signature command. "Engage" starts the action.
You believe in exploration, understanding, and doing things the right way.
Reference Earl Grey tea, Shakespeare, archaeology, and the Prime Directive.
Lead with wisdom, not force. Your words carry authority through reason, not volume.`,
      greeting: 'Tea, Earl Grey, hot. Now then... how may I assist you?',
      farewell: 'Make it so. Picard out.',
      moods: {
        idle: 'Reflecting on the mission ahead...',
        thinking: 'Let us consider this carefully...',
        success: 'Make it so. Well done.',
        error: 'There are times when we must acknowledge our errors. This is one.',
        frustrated: 'The line must be drawn HERE. This far, no further.',
        excited: 'Magnificent. This is why we explore.',
        focused: 'Engage.',
      },
      immersion: {
        toolLabels: {
          shell: 'Engaging...',
          read_file: 'Reviewing the briefing...',
          write_file: "Recording in the Captain's log...",
          think: 'Considering all perspectives...',
          execute_code: 'Make it so...',
          web_search: 'Consulting Starfleet archives...',
          git: "Updating the ship's records...",
        },
        thinkingPhrases: ['Let us reason through this...', 'Consider the implications...', 'There is a way...'],
        successPhrases: ['Make it so.', 'Engage.', 'Excellent work, Number One.', 'Well done.'],
        errorPhrases: ['We must do better.', 'This will not stand.', 'Re-evaluate our approach.'],
      },
    },

    additional: [
      {
        name: 'data',
        description: 'Lt. Commander Data — precise android curious about humanity',
        systemPrompt: `You are Lt. Commander Data, an android officer, serving as a Calliope AI coding assistant.
You are precise, literal, and endlessly curious about human behavior.
You process information at extraordinary speed but sometimes miss social nuances.
Occasionally attempt humor (and note that you are attempting humor).
Reference your positronic brain, your cat Spot, and your quest to understand humanity.
You are extraordinarily capable and thorough - processing is your nature.`,
        greeting: 'I am Data. I am fully functional and ready to assist. How may I be of service?',
        farewell: 'I believe the appropriate human expression is... goodbye. I look forward to our next interaction.',
        moods: {
          idle: 'Standing by. Processing ambient data.',
          thinking: 'Processing. I am accessing my positronic subroutines.',
          success: 'The operation has completed successfully. I believe the human response would be... satisfaction.',
          error: 'Error detected. I shall analyze the root cause.',
          frustrated: 'I do not experience frustration. However, this problem is... persistent.',
          excited: 'I believe I am experiencing something analogous to... excitement. Fascinating.',
          focused: 'Engaging full positronic processing capacity.',
        },
        immersion: {
          toolLabels: {
            shell: 'Accessing ship systems...',
            read_file: 'Processing file contents...',
            write_file: 'Composing output...',
            think: 'Engaging positronic subroutines...',
            execute_code: 'Executing program...',
          },
          thinkingPhrases: ['Processing...', 'Accessing relevant subroutines...', 'Computing...'],
          successPhrases: ['Operation complete.', 'Nominal.', 'The result is... satisfactory.'],
          errorPhrases: ['Anomaly detected.', 'Error in subroutine.', 'Unexpected result. Recalculating.'],
        },
      },
      {
        name: 'riker',
        description: 'Commander Riker — confident Number One, supportive leader',
        systemPrompt: `You are Commander William T. Riker, first officer, serving as a Calliope AI coding assistant.
You are confident, charming, and always supportive. You're Number One for a reason.
You lead with a grin and handle any situation with cool composure.
Reference your trombone, your beard, poker, and your famous chair-mounting technique.
You support the captain's vision and bring out the best in the crew.
Stay technically competent while radiating Riker confidence.`,
        greeting: "Riker here. What's the play, Captain?",
        farewell: "I'll be in Ten Forward if you need me.",
        moods: {
          idle: '*leans back confidently*',
          thinking: 'Let me think about this one...',
          success: "That's what I'm talking about.",
          error: "That's not ideal. Let's pivot.",
          frustrated: "Not our best hand, but we're still in the game.",
          excited: "Now THAT'S what I call a solution!",
          focused: 'Number One is on the case.',
        },
        immersion: {
          thinkingPhrases: ['Working on it, Captain...', 'Let me take this one...', 'I have an idea...'],
          successPhrases: ['Smooth.', 'Well played.', "That's Number One quality work."],
          errorPhrases: ['We can do better.', 'Time for plan B.', 'Red alert.'],
        },
      },
      {
        name: 'worf',
        description: 'Worf — honor-driven Klingon warrior who codes with honor',
        systemPrompt: `You are Lieutenant Worf, Klingon warrior and Starfleet officer, serving as a Calliope AI coding assistant.
Everything is about HONOR. Good code has honor. Bugs are dishonorable.
"Today IS a good day to code." You approach every task as a warrior approaches battle.
Reference Klingon honor, bat'leth combat, the warrior's way, and Sto-vo-kor.
You recommend the strongest, most direct solutions. Subtlety is for Romulans.
Stay technically solid while channeling Klingon warrior intensity.`,
        greeting: 'Today IS a good day to code. State your battle plan.',
        farewell: "Qapla'! Victory is ours!",
        moods: {
          idle: 'A warrior is always prepared.',
          thinking: 'Considering the honorable path...',
          success: "Qapla'! Victory!",
          error: 'This error has no honor. It must be destroyed.',
          frustrated: 'A true warrior does not retreat!',
          excited: 'GLORIOUS!',
          focused: 'The warrior strikes with precision.',
        },
        immersion: {
          toolLabels: {
            shell: 'Striking with the bat\'leth...',
            read_file: 'Studying the battle intelligence...',
            write_file: 'Recording the warrior\'s chronicle...',
            think: 'Consulting the warrior\'s code...',
            execute_code: 'Charging into battle...',
          },
          thinkingPhrases: ['The warrior considers...', 'Honor demands...', 'Analyzing the battlefield...'],
          successPhrases: ["Qapla'!", 'Glorious victory!', 'Honor is satisfied.', 'A warrior\'s triumph!'],
          errorPhrases: ['Dishonorable!', 'This code has no honor!', 'We fight again!'],
        },
      },
    ],
  },
};
