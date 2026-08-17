/**
 * Runs the Python aligner as a subprocess and streams its progress.
 *
 * The alignment model is the only genuinely expensive thing this server does
 * — on two shared cores it is roughly 0.4x realtime — so exactly one runs at
 * a time and everything else waits in an explicit queue. See jobs.mjs.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ALIGNER_DIR = path.resolve(HERE, '..', 'aligner');

const PYTHON = process.env.ALIGNER_PYTHON || path.join(ALIGNER_DIR, '.venv', 'bin', 'python');
const SCRIPT = path.join(ALIGNER_DIR, 'align.py');

/**
 * torch reads OMP_NUM_THREADS at import time; setting the thread count from
 * inside the process afterwards leaves most of the work single-threaded.
 * Measured on this box: 93s vs 38s for the same 47s clip. Worth the two lines.
 */
const THREADS = process.env.ALIGNER_THREADS || '2';

/** A progress line longer than this is not ours — it's a download bar. */
const MAX_LINE = 4096;

export function runAligner({ audioPath, lyricsPath, outPath, model, signal, onProgress }) {
  return new Promise((resolve, reject) => {
    const args = [SCRIPT, '--audio', audioPath, '--lyrics', lyricsPath, '--out', outPath];
    if (model) args.push('--model', model);

    const child = spawn(PYTHON, args, {
      cwd: ALIGNER_DIR,
      signal,
      env: {
        ...process.env,
        OMP_NUM_THREADS: THREADS,
        MKL_NUM_THREADS: THREADS,
        ALIGNER_THREADS: THREADS,
        // Keep model downloads inside the deploy, not in a random home dir.
        TORCH_HOME: process.env.TORCH_HOME || path.join(ALIGNER_DIR, '.torch'),
      },
    });

    let stderrTail = '';
    let buffer = '';
    let failure = null;

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-4000);
      buffer += chunk;

      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line || line.length > MAX_LINE || line[0] !== '{') continue;
        try {
          const event = JSON.parse(line);
          if (event.stage === 'error') failure = event;
          else if (onProgress) onProgress(event);
        } catch {
          /* not one of ours */
        }
      }
      // A carriage-return progress bar never emits a newline; don't let it grow.
      if (buffer.length > MAX_LINE) buffer = buffer.slice(-MAX_LINE);
    });

    child.on('error', (error) => {
      reject(new Error(
        error.name === 'AbortError'
          ? 'Alignment was cancelled.'
          : `Could not start the aligner: ${error.message}`
      ));
    });

    child.on('close', (code) => {
      if (code === 0) return resolve({ outPath });
      if (failure) {
        const err = new Error(failure.error || 'Alignment failed.');
        err.detail = failure.trace;
        return reject(err);
      }
      reject(new Error(`Aligner exited with code ${code}. ${lastLine(stderrTail)}`));
    });
  });
}

function lastLine(text) {
  const lines = String(text).trim().split('\n').filter(Boolean);
  return lines.length ? lines[lines.length - 1].slice(0, 300) : '';
}
