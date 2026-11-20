// main.ts — entrypoint for the Port Verda entry (Node 22, stdlib only).
//
// What it does, in order:
//   1. Works out where to write: /output inside the grader, or the folder
//      named by MAKEFUN_OUTPUT_DIR anywhere else (the usual local run is
//      `mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts`).
//   2. Copies this repository's game/ (the whole game: index.html plus
//      its ES modules, plain static files, no build step) and
//      screenshots/ (the four real gameplay shots) into that folder.
//   3. Writes dossier.json there with buildDossier from the kit's
//      vendored library (vendor/makefun-game.ts, untouched): the summary
//      the judge reads — the game's source text plus the screenshots.
//      The caps below are the scorer's own limits, so anything this
//      program writes is something the scorer accepts.
//
// The game itself is served locally with `node serve.ts`, which puts
// game/ on http://localhost:8080 to play in a desktop browser.

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

// The folder holding this file — game/ and screenshots/ sit beside it.
const repoRoot = fileURLToPath(new URL('.', import.meta.url));

// Grader container: /output. Anywhere else: MAKEFUN_OUTPUT_DIR wins.
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Start from an empty output folder so a stale file from an earlier run
// can never survive into the entry (the grader's /output starts empty;
// locally, `out/` may hold a previous run).
mkdirSync(outputDir, { recursive: true });
rmSync(join(outputDir, 'game'), { recursive: true, force: true });
rmSync(join(outputDir, 'screenshots'), { recursive: true, force: true });
rmSync(join(outputDir, 'dossier.json'), { force: true });

cpSync(join(repoRoot, 'game'), join(outputDir, 'game'), { recursive: true });
if (existsSync(join(repoRoot, 'screenshots'))) {
  cpSync(join(repoRoot, 'screenshots'), join(outputDir, 'screenshots'), { recursive: true });
}

// The scorer's own caps (from the kit's reference/gate.json): only
// text_max_bytes shapes the dossier's bytes; the rest refuse an entry
// the scorer would refuse — more than 4 screenshots or one over
// 256 KiB; more than 993 files in game/ or 48 MiB of game files in all,
// or a path under game/ over 1000 bytes.
writeFileSync(
  join(outputDir, 'dossier.json'),
  buildDossier(outputDir, {
    text_max_bytes: 163840,
    screenshots: { max: 4, max_bytes: 262144 },
    game_max_files: 993,
    game_max_bytes: 50331648,
    game_path_max_bytes: 1000,
  }),
);
