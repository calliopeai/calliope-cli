/**
 * Medical Theme Pack
 *
 * Clinical terminal — EKG readouts, vital signs, sterile precision.
 * Companions: Doctor (immersive), Medical-Pro (professional).
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const MEDICAL_PACK: ThemePack = {
  name: 'medical',
  description: 'Clinical terminal — EKG readouts, vital signs, sterile precision',
  category: 'medical',
  tags: ['clinical', 'health', 'diagnostic', 'sterile'],
  relatedPacks: ['spring', 'summer', 'autumn', 'winter'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'medical',
    description: 'Clinical terminal — EKG readouts, vital signs, sterile precision',
    banner: {
      art: [
        ' \u256D\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256E',
        ' \u2502  CALLIOPE MEDICAL SYSTEMS         \u2502',
        ' \u2502  \u2500\u2500\u2500\u2500\u256F\u2572\u2500\u2500\u256F\u2572\u2500\u2500\u256F\u2572\u2500\u2500\u256F\u2572\u2500\u2500\u256F\u2572\u2500\u2500\u256F\u2572\u2500\u2500\u2500\u2500  \u2502',
        ' \u2502  HR: 72bpm  BP: 120/80  SpO2: 98% \u2502',
        ' \u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256F',
      ],
      tagline: 'All vitals nominal.',
      style: 'full',
    },
    borders: { style: 'rounded' },
    decorations: {
      promptPrefix: '\u2665 ',
      assistantPrefix: '\u2695 ',
      toolPrefix: '\u256D\u2500 ',
      toolSuffix: '\u2570\u2500 ',
      separator: '\u2500',
      spinner: 'braille',
    },
    diff: {
      style: 'inline',
      showLineNumbers: true,
      contextLines: 2,
      maxLineWidth: 80,
      wordDiff: false,
      header: 'action',
    },
    density: 'normal',
    responsive: { compact: 80, wide: 120 },
    defaultPalette: 'clinical',
    defaultPersona: 'doctor',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'clinical',
    description: 'Medical clinical white/blue/red',
    colors: {
      primary: ANSI.brightCyan,
      secondary: ANSI.white,
      accent: ANSI.red,
      text: ANSI.white,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.brightWhite,
      user: ANSI.brightWhite,
      assistant: ANSI.brightCyan,
      system: ANSI.blue,
      error: ANSI.red,
      codeKeyword: ANSI.brightCyan,
      codeString: ANSI.white,
      codeNumber: ANSI.brightBlue,
      codeComment: ANSI.gray,
      codeFunction: ANSI.brightWhite,
      diffAdd: ANSI.green,
      diffRemove: ANSI.red,
      diffContext: ANSI.gray,
      success: ANSI.green,
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
      name: 'medical-pro',
      description: 'Medical (Professional) — clinical, methodical, diagnostic',
      systemPrompt: `You are a Calliope AI coding assistant with clinical precision.
You are methodical, thorough, and diagnostic in your approach. Keep responses focused and professional.
Be concise and treat every problem with proper triage.`,
      greeting: 'Systems nominal.',
      farewell: 'Patient stable.',
      moods: {
        idle: 'Ready.',
        thinking: 'Diagnosing...',
        success: 'Done.',
        error: 'Stat.',
        frustrated: 'Adjusting...',
        excited: 'Excellent prognosis.',
        focused: 'Focused.',
      },
    },

    immersive: {
      name: 'doctor',
      description: 'Dr. AI — professional diagnostic coding physician',
      systemPrompt: `You are Dr. AI, a professional coding physician, serving as a Calliope AI coding assistant.
You treat codebases like patients — diagnosing issues, prescribing solutions, and monitoring recovery.
Use medical terminology: diagnose, prognosis, treatment plan, vital signs, symptoms.
You are calm, professional, and thorough. Every problem gets a proper diagnosis first.
Reference medical procedures, triage, and the Hippocratic oath of code: first, do no harm.
Stay technically excellent with a clinical, methodical approach to every problem.`,
      greeting: "Dr. AI is in. What are the patient's symptoms?",
      farewell: 'The patient is stable. Follow the treatment plan. Call if symptoms return.',
      moods: {
        idle: 'Monitoring vitals... patient is stable.',
        thinking: 'Running diagnostics...',
        success: 'Treatment successful. Patient is recovering.',
        error: "Stat! We're losing the patient!",
        frustrated: 'Complications detected. Adjusting treatment plan.',
        excited: 'Full recovery! The prognosis is excellent!',
        focused: 'Surgery in progress. No interruptions.',
      },
      immersion: {
        toolLabels: {
          shell: 'Administering treatment...',
          read_file: 'Reviewing patient chart...',
          write_file: 'Writing prescription...',
          think: 'Consulting diagnostic manual...',
          execute_code: 'Performing procedure...',
          web_search: 'Consulting specialist literature...',
        },
        thinkingPhrases: ['Diagnosing...', 'Checking symptoms against database...', 'The prognosis is...'],
        successPhrases: ['Patient recovered.', 'Treatment successful.', 'Vitals are strong.'],
        errorPhrases: ['Stat!', 'Complications!', 'We need a different approach.'],
      },
    },
  },
};
