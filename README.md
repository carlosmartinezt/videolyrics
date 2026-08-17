# videolyrics

Upload an mp3, paste the lyrics, get a lyric video.

The hard part is knowing *when each word is sung*. This does that by forced
alignment — a CTC acoustic model constrained to the lyrics you pasted — then
designs the video from what it heard and what the words say, and lets your
browser encode the MP4.

Live at **https://videolyrics.carlosmartinezt.com**

---

## How it works

```
browser                          server (2 vCPU, no GPU)
───────                          ───────────────────────
mp3 + lyrics ──── upload ──────▶ ffmpeg → 16 kHz mono
                                 librosa → tempo, beats, onsets, key, dynamics
                                 wav2vec2 CTC forced alignment
                                   → start/end for every word
                                 structure: intro / verse / chorus / bridge / outro
                                 director: template, palette, type, cue per section
             ◀──── SSE progress ──
             ◀──── alignment + plan
canvas renderer (preview)
WebCodecs H.264  ─────────────▶  mp4  ← audio stream copied from your upload
```

Three decisions shape everything:

**Forced alignment, not transcription.** We already know every word, so the
only unknown is timing. A model constrained to the known text cannot invent
word order the way ASR does on singing; when the vocal is buried it degrades
to "roughly the right place" rather than to nonsense.

**The browser encodes.** This box has two shared cores. Server-side encoding
of a four-minute 1080p video would take most of an hour and block everyone
else; the visitor's laptop does it in a fraction of that, for free, in
parallel with every other visitor. The server never touches video.

**The audio is copied, never re-encoded.** Chrome on Linux ships an AAC
decoder but no AAC *encoder*, so re-encoding would have failed for a large
share of users. Instead the uploaded file's audio stream is muxed into the MP4
untouched: no encoder dependency, no generation loss, near-instant.

## Layout

```
aligner/      Python. ffmpeg → features → forced alignment → structure.
              Runs as a subprocess, one job at a time.
server/       Node, no dependencies. Job queue, SSE progress, the director.
  director/   Deterministic art direction, plus an optional model pass.
shared/       Imported by both server and browser: templates, palettes,
              and the plan schema + validator.
src/          The web app. render/ is the renderer; encode/ is WebCodecs.
scripts/      fetch-fonts, warm-models, e2e, contact-sheet.
deploy/       systemd user unit, Caddy site block.
```

## The plan

Everything converges into one document — the *plan* — and everything
downstream reads only that. It names the template, palette, typography, lyric
mode, reactivity, and one **cue** per section of the song:

```jsonc
{
  "template": "neon",
  "palette":  { "id": "ultraviolet", "accent": "#b388ff", … },
  "lyrics":   { "mode": "karaoke", "highlight": "glow" },
  "cues": [
    { "segment": 0, "treatment": "still",  "intensity": 0.2, "note": "Hold back." },
    { "segment": 1, "treatment": "build",  "intensity": 0.6, "note": "Ramp into the chorus." },
    { "segment": 2, "treatment": "surge",  "intensity": 0.9, "note": "First chorus. Open it up." }
  ]
}
```

`shared/plan.mjs` validates it. That is a hard boundary, not a helper: the
optional model pass can only ever replace individual fields that survive
validation, unknown values fall back to the deterministic plan, every number
is clamped, and lyric colour is forced to 7:1 contrast regardless of what
anyone asked for. Tested in `shared/plan.test.mjs`.

## The art director

Two passes. The **deterministic** pass always runs and always produces a
shippable plan: mood from tempo, loudness, onset density, key and a small
affect lexicon over the lyrics; template and palette scored against that;
lyric mode chosen from word density; a cue per section with choruses that
escalate each time they return.

The **model** pass is optional and only refines. Set a key in `.env`:

```sh
DIRECTOR_PROVIDER=deepseek       # or kimi
DIRECTOR_API_KEY=sk-…
# DIRECTOR_MODEL=deepseek-chat   # override if you want a different model
```

Any OpenAI-compatible endpoint works — set `DIRECTOR_BASE_URL` for others.
With no key the app says so in the interface rather than pretending.

## Running it

```sh
npm install
npm run fonts          # downloads the 11 typefaces into public/fonts (once)

uv venv --python 3.12 aligner/.venv
uv pip install --python aligner/.venv/bin/python --index-strategy unsafe-best-match \
  --extra-index-url https://download.pytorch.org/whl/cpu -r aligner/requirements.txt

npm run warmup         # pre-downloads the acoustic models
npm run dev            # web on :5174, api on :3058
```

ffmpeg is needed but not from apt — a static build in `~/bin` is enough:

```sh
curl -L -o ff.tar.xz https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n7.1-latest-linux64-gpl-7.1.tar.xz
tar xf ff.tar.xz && cp ffmpeg-*/bin/{ffmpeg,ffprobe} ~/bin/
```

### Tests

```sh
npm test                                    # plan validation + director
aligner/.venv/bin/python -m unittest discover -s aligner -p "test_*.py"
node scripts/e2e.mjs --audio song.mp3 --lyrics words.txt   # real Chrome, real MP4
```

The end-to-end script drives a real browser through the whole flow and probes
the resulting file with ffprobe, because "no exception was thrown" is not the
same as "this MP4 plays".

### Render lab

Judging six visual systems by exporting six videos is unworkable, so:

```sh
npm run dev:web
open http://localhost:5174/lab.html          # every template, one frame each
node scripts/contact-sheet.mjs --t 6.2       # screenshot it
node scripts/contact-sheet.mjs --palettes --template neon
```

Dev-server only; `vite build` never sees `lab.html`.

## Deploying

```sh
./ops/deploy.sh
```

Builds `dist/` (which Caddy serves directly, so the build *is* the deploy),
warms the models, and restarts the systemd **user** unit — no sudo anywhere.

Two things need a human, once:

1. **Cloudflare** — an A record `videolyrics` → `5.161.231.48`, proxied.
   There is no `*.carlosmartinezt.com` wildcard.
2. **Caddy** — `sudo sh -c 'cat deploy/Caddyfile.snippet >> /etc/caddy/Caddyfile' && sudo systemctl reload caddy`

## Limits and what they cost

| | |
|---|---|
| Alignment speed | ~0.4× realtime (English), ~0.8× (multilingual). A 3½ min song takes 80–170 s. |
| Concurrency | One alignment at a time. Two cores, five other services on this box. |
| Upload | 40 MB, 12 minutes |
| Retention | Uploads deleted after 6 hours |
| Export | Needs a Chromium browser. Firefox and Safari can do everything except the final encode. |
| Reference pictures | Never uploaded. Only the hex colours extracted from them are sent. |

The English model (`WAV2VEC2_ASR_BASE_960H`) is picked automatically when the
lyrics look English, the multilingual one (`MMS_FA`) otherwise; `mms` is twice
as slow and handles any Latin-script language.

## Adding a template

1. Add an entry to `TEMPLATES` in `shared/templates.mjs` — moods, which lyric
   modes it supports, its typography, whether it wants photographs.
2. Write a painter in `src/render/backgrounds.ts` and register it in
   `PAINTERS`. Painters must be pure functions of their context: no
   accumulated state and no `Math.random`, or seeking will disagree with
   playback and the preview will stop matching the export.
3. Check it in the render lab.
