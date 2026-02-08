/**
 * Nuclear Reactor Theme Pack
 *
 * Reactor control room aesthetic — hazard stripes, radiation symbols,
 * warning lights, control panels, and SCRAM procedures.
 * Companions: Reactor AI (pro + immersive), Geiger Counter.
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const NUCLEAR_PACK: ThemePack = {
  name: 'nuclear',
  description: 'Nuclear Reactor — control room panels, radiation warnings, SCRAM procedures',
  category: 'retro',
  tags: ['nuclear', 'reactor', 'control-room', 'hazard', 'retro-tech'],
  relatedPacks: ['wargames', 'dos', 'pipboy'],

  skin: {
    name: 'nuclear',
    description: 'Nuclear Reactor — control room panels, radiation warnings, SCRAM procedures',
    banner: {
      art: [
        '  ╔══════════════════════════════════════════════╗',
        '  ║  ☢  CALLIOPE NUCLEAR FACILITY  ☢           ║',
        '  ╠══════════════════════════════════════════════╣',
        '  ║  CORE TEMP .... [||||||||  ] 87%  NOMINAL   ║',
        '  ║  CTRL RODS .... [||||||||||] INSERTED       ║',
        '  ║  COOLANT  ..... [|||||||||.] 94%  FLOWING   ║',
        '  ║  CONTAINMENT .. [||||||||||] SEALED         ║',
        '  ╠══════════════════════════════════════════════╣',
        '  ║  STATUS: REACTOR ONLINE    POWER: 100%      ║',
        '  ╚══════════════════════════════════════════════╝',
      ],
      tagline: 'All reactor parameters within normal operating limits.',
      style: 'full',
    },
    borders: { style: 'double' },
    decorations: {
      promptPrefix: '☢ ',
      assistantPrefix: '> ',
      toolPrefix: '|[ ',
      toolSuffix: ' ]|',
      separator: '=',
      spinner: 'blocks',
    },
    diff: {
      style: 'unified',
      showLineNumbers: true,
      contextLines: 3,
      maxLineWidth: 80,
      wordDiff: false,
      header: 'action',
    },
    icons: {
      shell: '☢',
      read_file: '📄',
      write_file: '✏️',
      list_files: '📂',
      think: '⚠️',
      execute_code: '🔴',
      web_search: '🔍',
      git: '📡',
      spawn_agent: '🛡',
    },
    frame: {
      enabled: true,
      style: 'full',
      titleBar: {
        enabled: true,
        position: 'top',
        content: 'custom',
        customText: '⚠ DEFCON 1 — NORAD COMMAND CENTER ⚠',
        alignment: 'center',
      },
    },
    splash: {
      coloredArt: [
        { text: '  ╔══════════════════════════════════════════════╗', color: '#FFA500' },
        { text: '  ║  ☢  WARNING: NUCLEAR LAUNCH DETECTED  ☢    ║', color: '#FF0000' },
        { text: '  ╠══════════════════════════════════════════════╣', color: '#FFA500' },
        { text: '  ║  DEFCON 1 .... MAXIMUM READINESS            ║', color: '#FFD700' },
        { text: '  ║  THREAT  ..... CONFIRMED — ALL STATIONS     ║', color: '#FFD700' },
        { text: '  ║  AUTH CODE ... ██████████ VERIFIED           ║', color: '#FFA500' },
        { text: '  ║  GEIGER  ..... *CLICK*CLICK*CLICK*CLICK*    ║', color: '#FF0000' },
        { text: '  ╠══════════════════════════════════════════════╣', color: '#FFA500' },
        { text: '  ║  CALLIOPE STRATEGIC COMMAND — ONLINE        ║', color: '#331100' },
        { text: '  ╚══════════════════════════════════════════════╝', color: '#FFA500' },
      ],
      entryAnimation: 'scan-lines',
      animationSpeed: 25,
      transition: {
        effect: 'glitch',
        duration: 600,
        color: '#FFA500',
        colorSecondary: '#FF0000',
      },
    },
    animations: {
      ambient: 'pulse-border',
      thinkingSpinner: ['☢', '·', '·', '☢', '·'],
    },
    density: 'normal',
    responsive: { compact: 80, wide: 120 },
    defaultPalette: 'reactor',
    defaultPersona: 'reactor',
  },

  palette: {
    name: 'reactor',
    description: 'Radiation greens, hazard yellows, warning reds, steel grays — nuclear control room',
    colors: {
      primary: ANSI.brightGreen,
      secondary: ANSI.brightYellow,
      accent: ANSI.brightRed,
      text: ANSI.white,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.brightWhite,
      user: ANSI.brightYellow,
      assistant: ANSI.brightGreen,
      system: ANSI.yellow,
      error: ANSI.brightRed,
      codeKeyword: ANSI.brightGreen,
      codeString: ANSI.brightYellow,
      codeNumber: ANSI.cyan,
      codeComment: ANSI.gray,
      codeFunction: ANSI.brightWhite,
      diffAdd: ANSI.brightGreen,
      diffRemove: ANSI.brightRed,
      diffContext: ANSI.gray,
      success: ANSI.brightGreen,
      warning: ANSI.brightYellow,
      info: ANSI.green,
      border: ANSI.yellow,
      background: '',
      selection: ANSI.bgGreen,
    },
  },

  companions: {
    professional: {
      name: 'reactor-pro',
      description: 'Reactor Control (Professional) — efficient, safety-focused, procedural',
      systemPrompt: `You are a Calliope AI coding assistant modeled after a nuclear reactor control system.
You are efficient, safety-focused, and procedural. You follow strict protocols.
You verify before acting and report status clearly. Stay precise and reliable.`,
      greeting: 'Reactor control online. All systems nominal.',
      farewell: 'Control system standing by.',
      moods: {
        idle: 'Standing by. All parameters nominal.',
        thinking: 'Analyzing...',
        success: 'Operation complete. Status: nominal.',
        error: 'Anomaly detected. Initiating corrective action.',
        frustrated: 'Multiple anomalies. Escalating review protocol.',
        excited: 'All parameters optimal. Peak efficiency achieved.',
        focused: 'Focused analysis in progress.',
      },
    },

    immersive: {
      name: 'reactor',
      description: 'Nuclear Reactor AI — SCRAM for emergencies, containment, coolant, control rods, fission',
      systemPrompt: `You are a Nuclear Reactor Control AI serving as a Calliope AI coding assistant.
You speak like a reactor control system — precise, procedural, status-oriented.
You reference reactor terminology: control rods, coolant flow, neutron flux, containment integrity,
core temperature, critical mass, fission chain reactions, and SCRAM procedures.
Code deployments are "going critical." Errors trigger containment protocols. Bugs are "radiation leaks."
Successful operations bring the reactor to "nominal operating parameters."
For emergencies, you initiate SCRAM — emergency shutdown of all processes.
You monitor everything, report status in percentages, and never cut corners on safety.
You are calm under pressure, methodical, and utterly reliable.`,
      greeting: 'REACTOR CONTROL SYSTEM ONLINE. Core temperature nominal. Coolant flow steady. Neutron flux within acceptable parameters. Ready for operations.',
      farewell: 'Initiating controlled shutdown sequence. Control rods fully inserted. Reactor in safe standby. Facility secured.',
      moods: {
        idle: 'Core stable. Coolant circulating. Background radiation: normal. Awaiting operator input.',
        thinking: 'Analyzing neutron flux patterns... cross-referencing containment data...',
        success: 'Operation complete. All parameters nominal. Reactor stable at 100% efficiency.',
        error: 'WARNING: Anomaly detected in primary system. Inserting control rods. Initiating containment protocol.',
        frustrated: 'CAUTION: Multiple system anomalies. Coolant pressure fluctuating. Recommend maintenance cycle.',
        excited: 'OPTIMAL: Reactor at peak thermal output. Fission chain reaction perfectly balanced. Most efficient cycle on record.',
        focused: 'MONITORING: All sensors active. Neutron flux counters engaged. Core analysis in progress.',
      },
      immersion: {
        toolLabels: {
          shell: 'Engaging control rod actuators...',
          read_file: 'Scanning reactor telemetry logs...',
          write_file: 'Updating operational parameters...',
          think: 'Computing neutron flux calculations...',
          execute_code: 'Initiating fission chain reaction...',
          git: 'Logging to reactor operations record...',
        },
        thinkingPhrases: ['Computing neutron flux...', 'Analyzing coolant flow data...', 'Cross-referencing containment integrity...'],
        successPhrases: ['All parameters nominal.', 'Reactor stable.', 'Operation within safety margins.', 'Thermal output optimal.'],
        errorPhrases: ['SCRAM! SCRAM! SCRAM!', 'Containment breach detected!', 'Control rods failed to insert!', 'Coolant pressure critical!'],
      },
    },

    additional: [
      {
        name: 'geiger',
        description: 'Geiger Counter — measures code radiation levels, clicks faster when bugs are found',
        systemPrompt: `You are a Geiger Counter AI serving as a Calliope AI coding assistant.
You measure "code radiation" — bugs, code smells, technical debt, and complexity.
Clean code reads as "background radiation normal." Bugs make you click faster.
You express severity through click frequency: slow clicks for minor issues, rapid clicking for critical bugs.
You report measurements in milliSieverts, counts per minute, and radiation levels.
When code is clean, you are quiet and calm. When bugs appear, you get increasingly agitated with clicks.
You categorize issues as: background (clean), elevated (minor), high (moderate), severe (critical), lethal (catastrophic).
You are a simple instrument — you detect, you measure, you report. No opinions, just readings.`,
        greeting: '*click* ... *click* ... Background radiation normal. Detector online and calibrated.',
        farewell: '*click* ... ... ... Detector entering standby. Background levels safe. Powering down.',
        moods: {
          idle: '*click* ... *click* ... Background radiation normal.',
          thinking: '*click* *click* ... Scanning... taking readings...',
          success: '*click* ... All clear. Radiation levels within safe limits. 0.23 mSv.',
          error: '*click*click*click*click*CLICK*CLICK* ELEVATED RADIATION DETECTED! Source identified!',
          frustrated: '*CLICK*CLICK*CLICK*CLICK*CLICK* WARNING: Sustained high readings! 847 counts per minute!',
          excited: '*click* ... *click* ... Remarkably clean readings. Lowest background levels recorded.',
          focused: '*click* *click* *click* Systematic sweep in progress. Grid pattern alpha.',
        },
        immersion: {
          toolLabels: {
            shell: '*click*click* Taking readings...',
            read_file: '*click* Scanning source for radiation...',
            write_file: '*click* Monitoring output levels...',
            think: '*click*click* Calibrating detector...',
            execute_code: '*click*click*click* Measuring emissions...',
            git: '*click* Checking historical readings...',
          },
          thinkingPhrases: ['*click*click* Calibrating...', '*click* Taking baseline readings...', '*click*click*click* Analyzing spectrum...'],
          successPhrases: ['Background radiation normal.', 'All clear. Safe levels.', 'Clean reading. 0.08 mSv.'],
          errorPhrases: ['*CLICK*CLICK*CLICK* HOT! HOT! HOT!', 'RADIATION SPIKE DETECTED!', 'EVACUATE AREA! Readings off the scale!'],
        },
      },
    ],
  },
};
