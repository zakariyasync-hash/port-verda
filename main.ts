// Port Verda — entry program for make.fun's gta6-01 ("Make GTA 6") bounty.
//
// The game itself lives in game/ beside this file: a 2D top-down open-world
// crime game set in a fictional harbour city, written in vanilla JavaScript
// ES modules with no library and no network request, so any static server can
// serve it straight from disk. This program is only the hand-in step. It
// gathers game/ and screenshots/ from this repository into the output folder
// the grader reads, and writes dossier.json there with the vendored make.fun
// helper, so the judge gets the game, its screenshots and a summary of its
// source in one place.
//
// Run it locally (Node 22, standard library only) with:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
// Outside the grader, MAKEFUN_OUTPUT_DIR stands in for /output; without it
// the program writes to /output. Run it twice and the two outputs must be
// byte-identical.

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

// The folder this file sits in is the repository root: game/ and
// screenshots/ are its neighbours.
const repoRoot = fileURLToPath(new URL('.', import.meta.url));
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Fresh output folder, then the game and its screenshots, copied whole.
mkdirSync(outputDir, { recursive: true });
cpSync(join(repoRoot, 'game'), join(outputDir, 'game'), { recursive: true });
mkdirSync(join(outputDir, 'screenshots'), { recursive: true });
if (existsSync(join(repoRoot, 'screenshots'))) {
  cpSync(join(repoRoot, 'screenshots'), join(outputDir, 'screenshots'), { recursive: true });
}

// The dossier the judge reads, built by the kit's own library from the files
// just copied. The caps mirror the scorer's gate (reference/gate.json): the
// dossier text is capped at 160 KiB, at most 4 screenshots of at most
// 256 KiB each, and game/ holds at most 993 files, 48 MiB in all, with no
// path longer than 1,000 bytes. Anything past a cap is refused, so the
// program fails here rather than handing in an entry the scorer would drop.
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
