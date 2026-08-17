# videolyrics

Upload an mp3, paste the lyrics, get a lyric video.

The hard part is knowing *when each word is sung*. This does that by forced
alignment — a CTC acoustic model constrained to the lyrics you pasted — then
designs the video from what it heard and what the words say, and lets your
browser encode the MP4.

Anyone can upload a song and watch the result. Downloading it needs a free
account, and costs one of five monthly credits.

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

## Accounts and credits

Supabase owns identity. Everything decided *because* of identity lives in
`server/accounts.mjs` and `supabase/migrations/0001_accounts_and_credits.sql`.

**A credit buys a song, not a download.** It is spent at the first export and
keyed by the sha256 of the uploaded audio, so re-exporting at another
resolution, restyling, or coming back tomorrow with the same file is free.
Fixing a typo in the lyrics and re-aligning is free too — the hash covers the
audio only, deliberately.

**The browser never writes account state.** It holds a Supabase session and
sends the access token; the balance and the unlock are written by
`consume_credit()`, a security-definer function granted to the service role
alone. The profiles and unlocks tables have `select` policies and no others —
there is no path from a browser session to a write, whatever it sends.

Two credentials travel to the API and they must not share a header:

| | |
|---|---|
| `Authorization: Bearer` | the person's Supabase session — *who you are* |
| `X-Job-Token` | a capability for one job — *what you may touch* |

Anonymous visitors can align and preview. That is a deliberate choice about
the funnel and it leaves alignment — the only expensive thing here — reachable
without an account, so it is capped much harder per IP (3/hour against 20),
and signed-in jobs jump the queue ahead of anonymous ones.

### Setting it up

1. Create a **new** Supabase project (not the journal one).
2. Run `supabase/migrations/0001_accounts_and_credits.sql` in the SQL editor.
3. Put `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`
   into `.env` (see `.env.example`). The service-role key bypasses every
   policy — it belongs on the server and nowhere else.
4. Supabase → Authentication → URL Configuration: set the site URL and add
   the deployment as a redirect URL.
5. For Google: configure the provider in Supabase Auth, then `AUTH_GOOGLE=1`.
   Magic link works without it.

Raising someone's allowance later is one statement:

```sql
update public.profiles set credits_per_period = 50, credits_remaining = 50
 where email = 'someone@example.com';
```

Local development needs none of this. `AUTH_DEV_STUB=1` swaps Supabase for an
in-memory stub — any email signs in, no mail is sent, and the whole gate,
counter and monthly roll behave identically. It refuses to arm when `NODE_ENV`
is production.

## The watermark

Every exported frame carries `videolyrics.org`, bottom right, in the video's
own accent colour. It is applied in `normalisePlan` from server configuration
(`WATERMARK_TEXT` and friends) after the director and the language model have
had their say, so no client preference and no model output can remove it.

Since encoding happens in the visitor's browser, someone who edits the
JavaScript can strip it. That is inherent to not paying for server-side
rendering — it is a deterrent, not a lock — and the alternative costs 30-45
minutes of both cores per song.

## Layout

```
aligner/      Python. ffmpeg → features → forced alignment → structure.
              Runs as a subprocess, one job at a time.
server/       Node, no dependencies. Job queue, SSE progress, the director.
  accounts.mjs  Sessions, credits, unlocks — and a dev stub for all three.
  director/   Deterministic art direction, plus an optional model pass.
supabase/     The schema. Read the SQL comments; the rules live there.
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
npm test                                    # plan validation, director, credits
aligner/.venv/bin/python -m unittest discover -s aligner -p "test_*.py"
node scripts/e2e.mjs --audio song.mp3 --lyrics words.txt   # real Chrome, real MP4
```

The end-to-end script drives a real browser through the whole flow and probes
the resulting file with ffprobe, because "no exception was thrown" is not the
same as "this MP4 plays". With `AUTH_DEV_STUB=1` on the API it also checks
that an anonymous export is refused, that signing in grants five credits, that
exporting spends exactly one, and that the watermark is actually burned into
the decoded frame.

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
| Free credits | 5 songs per person per month, resetting on the 1st |
| Anonymous | May align and preview, 3 songs/hour per IP, cannot download |

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
