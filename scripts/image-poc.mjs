#!/usr/bin/env node
/**
 * Terminal Image Renderer POC — Calliope CLI
 *
 * Renders images in the terminal using multiple protocols and fallback modes.
 * Supports: iTerm2, Kitty, Sixel, Unicode half-block, braille, and ASCII.
 *
 * Usage:
 *   node scripts/image-poc.mjs <image>                    # auto-detect best mode
 *   node scripts/image-poc.mjs <image> --mode=braille     # force a mode
 *   node scripts/image-poc.mjs <image> --width=80         # set width (chars)
 *   node scripts/image-poc.mjs <image> --all              # render all modes side by side
 *   node scripts/image-poc.mjs --demo                     # use a built-in test image
 *   node scripts/image-poc.mjs <image> --mode=kitty --mode=iterm2  # compare specific modes
 *
 * Modes: iterm2, kitty, halfblock, braille, ascii
 */

import sharp from "sharp";
import { readFileSync, existsSync, writeFileSync } from "fs";
import { basename } from "path";
import { deflateSync } from "zlib";

// ─── Constants ───────────────────────────────────────────────────────────────

const MODES = ["iterm2", "kitty", "halfblock", "braille", "ascii"];

const ASCII_RAMP = " .:-=+*#%@";

// Braille encoding: each 2x4 cell maps to a Unicode braille character (U+2800)
// Dot positions:  0 3
//                 1 4
//                 2 5
//                 6 7
const BRAILLE_MAP = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80];

// ─── Terminal Detection ──────────────────────────────────────────────────────

function detectTerminal() {
  const env = process.env;
  const term = {
    program: env.TERM_PROGRAM || env.LC_TERMINAL || "unknown",
    term: env.TERM || "unknown",
    colorterm: env.COLORTERM || "none",
    cols: parseInt(env.COLUMNS) || process.stdout.columns || 80,
    rows: parseInt(env.LINES) || process.stdout.rows || 24,
    truecolor: env.COLORTERM === "truecolor" || env.COLORTERM === "24bit",
    protocols: {
      iterm2: !!(
        env.ITERM_SESSION_ID ||
        env.LC_TERMINAL === "iTerm2" ||
        env.TERM_PROGRAM === "iTerm.app" ||
        env.TERM_PROGRAM === "WezTerm"
      ),
      kitty: !!(
        env.KITTY_PID ||
        env.TERM === "xterm-kitty" ||
        env.GHOSTTY_RESOURCES_DIR ||
        env.TERM_PROGRAM === "WezTerm"
      ),
      sixel: false, // would need escape sequence query to detect
    },
  };
  return term;
}

function bestMode(term) {
  if (term.protocols.kitty) return "kitty";
  if (term.protocols.iterm2) return "iterm2";
  if (term.truecolor) return "halfblock";
  return "ascii";
}

// ─── Minimal PNG Encoder (for Kitty/iTerm2 protocols) ────────────────────────

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    raw[rowStart] = 0; // no filter
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }
  const compressed = deflateSync(raw);
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ─── Renderers ───────────────────────────────────────────────────────────────

function renderIterm2(pngBuf, _w, _h) {
  const b64 = pngBuf.toString("base64");
  return `\x1b]1337;File=inline=1;size=${pngBuf.length};preserveAspectRatio=1:${b64}\x07\n`;
}

function renderKitty(pngBuf, _w, _h) {
  const b64 = pngBuf.toString("base64");
  const chunkSize = 4096;
  let out = "";
  for (let i = 0; i < b64.length; i += chunkSize) {
    const slice = b64.slice(i, i + chunkSize);
    const more = i + chunkSize < b64.length ? 1 : 0;
    if (i === 0) {
      out += `\x1b_Ga=T,f=100,m=${more};${slice}\x1b\\`;
    } else {
      out += `\x1b_Gm=${more};${slice}\x1b\\`;
    }
  }
  return out + "\n";
}

function renderHalfblock(rgba, w, h) {
  let out = "";
  for (let y = 0; y < h; y += 2) {
    let line = "";
    for (let x = 0; x < w; x++) {
      const ti = (y * w + x) * 4;
      const bi = ((y + 1) * w + x) * 4;
      const tr = rgba[ti], tg = rgba[ti + 1], tb = rgba[ti + 2], ta = rgba[ti + 3];
      let br = 0, bg = 0, bb = 0;
      if (y + 1 < h) {
        br = rgba[bi]; bg = rgba[bi + 1]; bb = rgba[bi + 2];
      }
      if (ta < 128) {
        line += `\x1b[0m `;
      } else {
        line += `\x1b[38;2;${tr};${tg};${tb}m\x1b[48;2;${br};${bg};${bb}m▀`;
      }
    }
    line += `\x1b[0m`;
    out += line + "\n";
  }
  return out;
}

function luminance(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function renderBraille(rgba, w, h) {
  // Braille: 2 cols x 4 rows per character cell
  // Each cell produces one braille character, colored with the average color
  let out = "";
  for (let cy = 0; cy < h; cy += 4) {
    let line = "";
    for (let cx = 0; cx < w; cx += 2) {
      let dots = 0;
      let rSum = 0, gSum = 0, bSum = 0, count = 0;
      // Map each dot position
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const px = cx + dx;
          const py = cy + dy;
          if (px < w && py < h) {
            const i = (py * w + px) * 4;
            const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2], a = rgba[i + 3];
            const lum = luminance(r, g, b);
            if (lum > 80 && a > 128) {
              const dotIndex = dy + dx * (dy < 3 ? 0 : 1);
              // Braille dot mapping: column 0 = bits 0,1,2,6  column 1 = bits 3,4,5,7
              const bitIndex = dx === 0
                ? (dy < 3 ? dy : 6)
                : (dy < 3 ? dy + 3 : 7);
              dots |= BRAILLE_MAP[bitIndex];
            }
            rSum += r; gSum += g; bSum += b; count++;
          }
        }
      }
      const avgR = Math.round(rSum / (count || 1));
      const avgG = Math.round(gSum / (count || 1));
      const avgB = Math.round(bSum / (count || 1));
      const ch = String.fromCharCode(0x2800 + dots);
      line += `\x1b[38;2;${avgR};${avgG};${avgB}m${ch}`;
    }
    line += "\x1b[0m";
    out += line + "\n";
  }
  return out;
}

function renderAscii(rgba, w, h) {
  let out = "";
  // Each character cell is ~2:1 aspect ratio, so step by 2 vertically
  for (let y = 0; y < h; y += 2) {
    let line = "";
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const lum = luminance(rgba[i], rgba[i + 1], rgba[i + 2]);
      const idx = Math.floor((lum / 255) * (ASCII_RAMP.length - 1));
      line += `\x1b[38;2;${rgba[i]};${rgba[i + 1]};${rgba[i + 2]}m${ASCII_RAMP[idx]}`;
    }
    line += "\x1b[0m";
    out += line + "\n";
  }
  return out;
}

// ─── Image Loading ───────────────────────────────────────────────────────────

async function loadImage(path, targetWidth) {
  const img = sharp(path);
  const meta = await img.metadata();

  // Calculate dimensions to fit target width
  // For halfblock/ascii: 1 char = 1 pixel wide, 2 pixels tall
  // For braille: 1 char = 2 pixels wide, 4 pixels tall
  const aspect = meta.height / meta.width;
  const w = targetWidth;
  const h = Math.round(w * aspect);

  const resized = await img
    .resize(w, h, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    width: resized.info.width,
    height: resized.info.height,
    rgba: resized.data,
    format: meta.format,
    originalWidth: meta.width,
    originalHeight: meta.height,
  };
}

async function loadImageForProtocol(path, targetWidth) {
  // For iTerm2/Kitty, we send a real PNG at higher res — terminal handles display
  const img = sharp(path);
  const meta = await img.metadata();
  const aspect = meta.height / meta.width;
  // Pixel width for protocol = char width * ~8 (approximate cell pixel width)
  const pixelW = Math.min(meta.width, targetWidth * 8);
  const pixelH = Math.round(pixelW * aspect);

  const pngBuf = await img
    .resize(pixelW, pixelH, { fit: "inside" })
    .png()
    .toBuffer();

  return { pngBuf, width: pixelW, height: pixelH };
}

// ─── Demo Image Generator ────────────────────────────────────────────────────

async function generateDemoImage() {
  // Create a colorful 256x256 test image with gradients, shapes, and text-like patterns
  const size = 256;
  const channels = 4;
  const pixels = Buffer.alloc(size * size * channels);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * channels;
      const cx = x - size / 2;
      const cy = y - size / 2;
      const dist = Math.sqrt(cx * cx + cy * cy);
      const angle = Math.atan2(cy, cx);

      // Background: dark gradient
      let r = Math.floor(20 + (x / size) * 40);
      let g = Math.floor(15 + (y / size) * 30);
      let b = Math.floor(30 + ((x + y) / (size * 2)) * 50);

      // Concentric rings
      if (dist < 100) {
        const ring = Math.sin(dist * 0.3) * 0.5 + 0.5;
        const hue = ((angle + Math.PI) / (2 * Math.PI)) * 360;
        const rgb = hslToRgb(hue, 0.8, 0.3 + ring * 0.4);
        r = rgb[0]; g = rgb[1]; b = rgb[2];
      }

      // Corner accents
      if (x < 40 && y < 40) { r = 255; g = 100; b = 50; }
      if (x > size - 40 && y < 40) { r = 50; g = 200; b = 255; }
      if (x < 40 && y > size - 40) { r = 100; g = 255; b = 100; }
      if (x > size - 40 && y > size - 40) { r = 255; g = 200; b = 50; }

      // Grid lines every 32px
      if (x % 32 === 0 || y % 32 === 0) {
        r = Math.min(255, r + 30);
        g = Math.min(255, g + 30);
        b = Math.min(255, b + 30);
      }

      // Star burst from center
      if (dist < 120 && dist > 20) {
        const spoke = Math.abs(Math.sin(angle * 8));
        if (spoke > 0.9) {
          r = 255; g = 255; b = 200;
        }
      }

      // Central dot
      if (dist < 8) {
        r = 255; g = 255; b = 255;
      }

      pixels[i] = r;
      pixels[i + 1] = g;
      pixels[i + 2] = b;
      pixels[i + 3] = 255;
    }
  }

  // Save as a temp PNG using sharp
  const tmpPath = "/tmp/calliope-image-demo.png";
  await sharp(pixels, { raw: { width: size, height: size, channels: 4 } })
    .png()
    .toFile(tmpPath);

  return tmpPath;
}

function hslToRgb(h, s, l) {
  h /= 360;
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

// ─── Rendering Orchestration ─────────────────────────────────────────────────

async function renderMode(mode, imagePath, targetWidth) {
  if (mode === "iterm2" || mode === "kitty") {
    const { pngBuf, width, height } = await loadImageForProtocol(imagePath, targetWidth);
    if (mode === "iterm2") return renderIterm2(pngBuf, width, height);
    return renderKitty(pngBuf, width, height);
  }

  // For text-based modes, determine pixel width based on mode
  let pixelWidth = targetWidth;
  if (mode === "braille") pixelWidth = targetWidth * 2; // 2 dots per char horizontally

  const { rgba, width, height } = await loadImage(imagePath, pixelWidth);

  switch (mode) {
    case "halfblock": return renderHalfblock(rgba, width, height);
    case "braille": return renderBraille(rgba, width, height);
    case "ascii": return renderAscii(rgba, width, height);
    default: throw new Error(`Unknown mode: ${mode}`);
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    image: null,
    modes: [],
    width: null,
    all: false,
    demo: false,
    help: false,
  };

  for (const arg of args) {
    if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--all") opts.all = true;
    else if (arg === "--demo") opts.demo = true;
    else if (arg.startsWith("--mode=")) opts.modes.push(arg.slice(7));
    else if (arg.startsWith("--width=")) opts.width = parseInt(arg.slice(8));
    else if (!arg.startsWith("-")) opts.image = arg;
  }

  return opts;
}

function printHelp() {
  console.log(`
  Terminal Image Renderer POC

  Usage:
    node scripts/image-poc.mjs <image>                     auto-detect best mode
    node scripts/image-poc.mjs <image> --mode=braille      force a mode
    node scripts/image-poc.mjs <image> --width=60          set render width
    node scripts/image-poc.mjs <image> --all               show ALL render modes
    node scripts/image-poc.mjs --demo                      use built-in test image
    node scripts/image-poc.mjs <image> --mode=halfblock --mode=braille

  Modes: ${MODES.join(", ")}
  `);
}

function box(title, content, width) {
  const top = `┌─ ${title} ${"─".repeat(Math.max(0, width - title.length - 4))}┐`;
  const bot = `└${"─".repeat(width)}┘`;
  const lines = content.split("\n").filter(Boolean);
  const padded = lines.map((l) => {
    // Strip ANSI to measure visible length
    const vis = l.replace(/\x1b\[[^m]*m/g, "").replace(/\x1b[\\_\]][^\x07\x1b]*[\x07\x1b\\]?/g, "");
    const pad = Math.max(0, width - 1 - vis.length);
    return `│${l}${" ".repeat(pad)}│`;
  });
  return [top, ...padded, bot].join("\n");
}

async function main() {
  const opts = parseArgs();
  if (opts.help) return printHelp();

  const term = detectTerminal();
  const targetWidth = opts.width || Math.min(term.cols - 4, 60);

  // Resolve image path
  let imagePath = opts.image;
  if (opts.demo || !imagePath) {
    console.log("\n  Generating demo image...");
    imagePath = await generateDemoImage();
  } else if (!existsSync(imagePath)) {
    console.error(`  Error: file not found: ${imagePath}`);
    process.exit(1);
  }

  // Print terminal info
  console.log(`
  ┌────────────────────────────────────────────┐
  │  Terminal Image Renderer POC               │
  ├────────────────────────────────────────────┤
  │  Terminal:   ${(term.program).padEnd(29)}│
  │  Size:       ${(term.cols + "x" + term.rows).padEnd(29)}│
  │  Truecolor:  ${(term.truecolor ? "yes" : "no").padEnd(29)}│
  │  iTerm2:     ${(term.protocols.iterm2 ? "yes" : "no").padEnd(29)}│
  │  Kitty:      ${(term.protocols.kitty ? "yes" : "no").padEnd(29)}│
  │  Best mode:  ${bestMode(term).padEnd(29)}│
  │  Image:      ${basename(imagePath).padEnd(29)}│
  │  Width:      ${(targetWidth + " chars").padEnd(29)}│
  └────────────────────────────────────────────┘
`);

  // Determine which modes to render
  let modes = opts.modes.length > 0 ? opts.modes : (opts.all ? MODES : [bestMode(term)]);

  // Filter to only protocol modes the terminal supports (unless explicitly requested)
  if (!opts.modes.length && !opts.all) {
    modes = modes.filter((m) => {
      if (m === "iterm2") return term.protocols.iterm2;
      if (m === "kitty") return term.protocols.kitty;
      return true;
    });
  }

  // If --all, show all text modes (skip protocol modes if unsupported)
  if (opts.all) {
    modes = modes.filter((m) => {
      if (m === "iterm2") return term.protocols.iterm2;
      if (m === "kitty") return term.protocols.kitty;
      return true;
    });
  }

  // Render each mode
  for (const mode of modes) {
    const label = {
      iterm2: "iTerm2 Inline Image",
      kitty: "Kitty Graphics Protocol",
      halfblock: "Unicode Half-Block (▀)",
      braille: "Braille Dots (⠿)",
      ascii: "Colored ASCII",
    }[mode] || mode;

    console.log(`  ── ${label} ${"─".repeat(Math.max(0, 42 - label.length))}──\n`);

    try {
      const rendered = await renderMode(mode, imagePath, targetWidth);
      process.stdout.write(rendered);
    } catch (err) {
      console.log(`  Error: ${err.message}`);
    }
    console.log();
  }

  // Summary
  if (modes.length > 1) {
    console.log("  ── Comparison Notes ─────────────────────────\n");
    console.log("  halfblock  Best color fidelity, 1 char = 1x2 pixels");
    console.log("  braille    2x resolution, 1 char = 2x4 pixels, lighter look");
    console.log("  ascii      Classic aesthetic, varies by font");
    console.log("  iterm2     Native protocol, pixel-perfect (iTerm2/WezTerm)");
    console.log("  kitty      Native protocol, pixel-perfect (Kitty/Ghostty/WezTerm)");
    console.log();
  }
}

main().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
