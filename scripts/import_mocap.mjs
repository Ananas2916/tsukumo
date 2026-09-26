#!/usr/bin/env node
/**
 * Scarica una selezione di motion capture gratuito e lo installa come clip
 * per Tsukumo (frontend/public/animations/).
 *
 *   node scripts/import_mocap.mjs            # scarica (se manca) e converte
 *   node scripts/import_mocap.mjs --offline  # solo conversione dei BVH gia' scaricati
 *
 * Fonte: Bandai Namco Research Motion Dataset 1, attori professionisti
 * ripresi in studio, licenza CC BY-NC 4.0 (uso non commerciale, citando la
 * fonte). I file restano fuori dal repository: i BVH in models/mocap/, le
 * clip in frontend/public/animations/ (entrambe ignorate da git).
 *
 * Il nome della clip dice quando usarla (vedi frontend/src/clips.js):
 * greet* quando compare o torni, dance* con Spotify, le altre dal pannello.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { convert, parseBVH, writeVRMA } from './bvh2vrma.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(ROOT, 'models', 'mocap', 'bandai');
const TARGET = join(ROOT, 'frontend', 'public', 'animations');
const BASE =
  'https://raw.githubusercontent.com/BandaiNamcoResearchInc/Bandai-Namco-Research-Motiondataset/master/dataset/Bandai-Namco-Research-Motiondataset-1';

/** Clip scelte a mano: file d'origine, nome per Tsukumo, finestra in secondi. */
const CLIPS = [
  { source: 'bye_happy_001', name: 'greet-ciao' },
  { source: 'bye_feminine_001', name: 'greet-ciao-timido', end: 8.5 },
  { source: 'bye_childish_001', name: 'greet-ciao-grande' },
  { source: 'byebye_happy_001', name: 'greet-evviva' },
  { source: 'bow_happy_001', name: 'inchino' },
  { source: 'bow_feminine_001', name: 'inchino-elegante' },
  { source: 'guide_feminine_001', name: 'indica', end: 6.5 },
  { source: 'call_normal_001', name: 'chiama' },
  { source: 'respond_normal_001', name: 'alza-la-mano' },
  { source: 'dance-short_normal_001', name: 'dance-corto' },
  { source: 'dance-long_normal_001', name: 'dance-lungo' },
];

const CREDITS = `Animazioni da Bandai Namco Research Motion Dataset 1
https://github.com/BandaiNamcoResearchInc/Bandai-Namco-Research-Motiondataset
(c) 2022 Bandai Namco Research Inc. - licenza CC BY-NC 4.0
https://creativecommons.org/licenses/by-nc/4.0/

Convertite da BVH a VRMA con scripts/bvh2vrma.mjs (riportate in T-pose,
rivolte verso lo spettatore). Solo uso non commerciale.
`;

async function download(name) {
  const file = join(SOURCE, `${name}.bvh`);
  if (existsSync(file)) return file;
  const response = await fetch(`${BASE}/data/dataset-1_${name}.bvh`);
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  return file;
}

const offline = process.argv.includes('--offline');
mkdirSync(SOURCE, { recursive: true });
mkdirSync(TARGET, { recursive: true });
let installed = 0;
for (const clip of CLIPS) {
  try {
    const file = offline ? join(SOURCE, `${clip.source}.bvh`) : await download(clip.source);
    if (!existsSync(file)) {
      console.log(`- ${clip.name}: manca ${clip.source}.bvh (togli --offline per scaricarlo)`);
      continue;
    }
    const result = convert(parseBVH(readFileSync(file, 'utf8')), { start: clip.start, end: clip.end, trim: true });
    writeFileSync(join(TARGET, `${clip.name}.vrma`), writeVRMA(result));
    console.log(`+ ${clip.name}.vrma (${result.duration.toFixed(1)} s)`);
    installed++;
  } catch (error) {
    console.log(`- ${clip.name}: ${error.message}`);
  }
}
writeFileSync(join(TARGET, 'CREDITS-bandai-namco.txt'), CREDITS);
console.log(`\n${installed} clip in ${TARGET}. Riavvia Tsukumo (o ricarica il personaggio) per usarle.`);
