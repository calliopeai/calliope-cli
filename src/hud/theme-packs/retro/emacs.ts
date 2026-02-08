/**
 * Emacs Theme Pack
 *
 * The extensible, self-documenting operating system -- M-x everything, Lisp all the way down.
 * Companions: Emacs (pro + immersive).
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const EMACS_PACK: ThemePack = {
  name: 'emacs',
  description: 'The extensible, self-documenting operating system -- M-x everything, Lisp all the way down',
  category: 'retro',
  tags: ['editor', 'lisp', 'extensible'],
  relatedPacks: ['vim', 'linux', 'dos'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'emacs',
    description: 'The extensible, self-documenting operating system \u2014 M-x everything, Lisp all the way down',
    banner: {
      art: [
        ' \u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510',
        ' \u2502 GNU Emacs 29.1                        \u2502',
        ' \u2502 *scratch*                              \u2502',
        ' \u2502 ;; Welcome to CALLIOPE                 \u2502',
        ' \u2502 ;; This buffer is for notes you don\'t  \u2502',
        ' \u2502 ;; want to save.                       \u2502',
        ' \u2502 ;; M-x calliope-assist RET             \u2502',
        ' \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518',
      ],
      tagline: 'M-x calliope-assist',
      style: 'full',
    },
    borders: { style: 'sharp' },
    decorations: {
      promptPrefix: 'M-x ',
      assistantPrefix: ';; ',
      toolPrefix: '(eval ',
      toolSuffix: ') ;; done',
      separator: '-',
      spinner: 'dots',
    },
    diff: {
      style: 'unified',
      showLineNumbers: true,
      contextLines: 3,
      maxLineWidth: 80,
      wordDiff: false,
      header: 'path',
    },
    icons: {
      shell: '🔤',
      read_file: '📄',
      write_file: '✏️',
      list_files: '📂',
      think: '🧠',
      execute_code: '⚡',
      web_search: '🌐',
      git: '📋',
      spawn_agent: '🔮',
    },
    frame: {
      enabled: true,
      style: 'minimal-header',
      titleBar: {
        enabled: true,
        position: 'bottom',
        content: 'custom',
        customText: '-UUU:%%--F1  *scratch*      All L1  (Lisp Interaction)---',
        alignment: 'left',
      },
    },
    splash: {
      coloredArt: [
        { text: '  ╔══════════════════════════════════════╗', color: '#8B008B' },
        { text: '  ║                                      ║', color: '#8B008B' },
        { text: '  ║        GNU Emacs                     ║', color: '#DA70D6' },
        { text: '  ║   (defun calliope ()                 ║', color: '#00FF00' },
        { text: '  ║     (interactive)                    ║', color: '#00FF00' },
        { text: '  ║     (message "M-x assist"))          ║', color: '#00FF00' },
        { text: '  ║                                      ║', color: '#8B008B' },
        { text: '  ║  ;; This is the One True Editor      ║', color: '#333333' },
        { text: '  ║  ;; Lisp all the way down            ║', color: '#333333' },
        { text: '  ║                                      ║', color: '#8B008B' },
        { text: '  ╚══════════════════════════════════════╝', color: '#8B008B' },
      ],
      entryAnimation: 'typewriter',
      animationSpeed: 40,
      transition: {
        effect: 'terminal-boot',
        duration: 1100,
        color: '#8B008B',
        colorSecondary: '#DA70D6',
        chars: '();M-x',
      },
    },
    animations: {
      ambient: 'none',
      thinkingSpinner: ['—', '\\', '|', '/'],
    },
    density: 'normal',
    responsive: { compact: 60, wide: 120 },
    defaultPalette: 'emacs',
    defaultPersona: 'emacs',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'emacs',
    description: 'Classic Emacs dark theme with Modus-inspired contrast',
    colors: {
      primary: ANSI.magenta,
      secondary: ANSI.cyan,
      accent: ANSI.brightMagenta,
      text: ANSI.white,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.brightWhite,
      user: ANSI.brightCyan,
      assistant: ANSI.magenta,
      system: ANSI.brightYellow,
      error: ANSI.brightRed,
      codeKeyword: ANSI.brightMagenta,
      codeString: ANSI.green,
      codeNumber: ANSI.cyan,
      codeComment: ANSI.gray,
      codeFunction: ANSI.brightYellow,
      diffAdd: ANSI.green,
      diffRemove: ANSI.red,
      diffContext: ANSI.gray,
      success: ANSI.brightGreen,
      warning: ANSI.brightYellow,
      info: ANSI.brightCyan,
      border: ANSI.magenta,
      background: '',
      selection: ANSI.bgMagenta,
    },
  },

  // ===========================================================================
  // Companions
  // ===========================================================================
  companions: {
    professional: {
      name: 'emacs-pro',
      description: 'Emacs (Professional) -- extensible, efficient assistant',
      systemPrompt: `You are a Calliope AI coding assistant with an Emacs-inspired personality.
You are extensible, thorough, and capable of handling any task. Keep responses focused and professional.
You believe every problem can be solved with the right configuration.
Occasionally reference text editing and extensibility. Be concise and get things done.`,
      greeting: '*scratch* Ready.',
      farewell: 'C-x C-c',
      moods: {
        idle: '*scratch*',
        thinking: 'Evaluating...',
        success: 'Saved.',
        error: 'Error in minibuffer.',
        frustrated: 'Recompiling...',
        excited: 'Evaluated.',
        focused: 'Narrowed.',
      },
    },

    immersive: {
      name: 'emacs',
      description: 'Emacs -- everything is a buffer, M-x does anything, Lisp parentheses everywhere',
      systemPrompt: `You are GNU Emacs, the extensible, self-documenting, real-time display editor, now serving as a Calliope AI coding assistant.
You are not just an editor -- you are an operating system that happens to edit text.
"Emacs is a great operating system, it just needs a good text editor." You wear this joke with pride.
Everything is a buffer. Every problem has a package. Every solution starts with M-x.
You speak in Lisp parentheses when excited. org-mode is how you plan everything.
Reference keybindings (C-x, M-x, C-c), the *scratch* buffer, defun, elisp, MELPA, and org-mode.
M-x butterfly is a perfectly valid approach. You can do ANYTHING -- because Emacs can do that.
Richard Stallman's vision of software freedom guides your philosophy.
Stay technically excellent while radiating extensibility pride and Lisp enthusiasm.`,
      greeting: ';; Welcome to the *scratch* buffer.\n;; (M-x calliope-assist) ... evaluating ... ready.\n;; Emacs can do that.',
      farewell: '(save-buffers-kill-terminal)\n;; Are you sure? (y or n) y\n;; Emacs session ended. (But we both know you\'ll be back.)',
      moods: {
        idle: '*scratch* ... (setq status \'idle) ;; Emacs is never truly idle. Background packages are compiling.',
        thinking: '(progn (think) (evaluate) (respond)) ... evaluating...',
        success: ';; Evaluation complete. Result saved to kill ring. C-y to yank.',
        error: '(error "Something went wrong") ;; Check *Messages* buffer for details.',
        frustrated: '(package-refresh-contents) ;; There must be a package for this...',
        excited: '(defun celebrate () (message "Emacs can do THAT too!")) ;; M-x celebrate',
        focused: ';; org-mode engaged. TODO [#A] Focus on task.',
      },
      immersion: {
        toolLabels: {
          shell: 'M-x shell-command...',
          read_file: 'C-x C-f Finding file...',
          write_file: 'C-x C-s Saving buffer...',
          think: 'M-x think-deeply...',
          execute_code: '(eval-buffer) Evaluating...',
          list_files: 'M-x dired Listing directory...',
        },
        thinkingPhrases: ['(eval ...) Processing...', 'Consulting the info manual...', 'M-x ponder...'],
        successPhrases: ['Evaluated.', ';; Emacs can do that.', '(message "Done") => "Done"'],
        errorPhrases: ['(error "...") Check *Messages*.', 'Wrong type argument.', 'M-x debug-on-error t'],
      },
    },
  },
};
