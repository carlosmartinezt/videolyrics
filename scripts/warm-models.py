#!/usr/bin/env python
"""Download the acoustic models ahead of the first job.

torchaudio fetches a bundle's weights the first time you ask for the model,
which without this would happen *inside* somebody's first alignment and look
like a two minute stall with no explanation. Run at deploy time instead.

    aligner/.venv/bin/python scripts/warm-models.py
"""

import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "aligner"))

import torch  # noqa: E402
import torchaudio  # noqa: E402

BUNDLES = [
    ("base", torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H),
    ("mms", torchaudio.pipelines.MMS_FA),
]


def main() -> int:
    torch.set_num_threads(1)
    for name, bundle in BUNDLES:
        started = time.time()
        try:
            model = bundle.get_model()
        except Exception as exc:
            print(f"  ! {name}: {exc}")
            return 1
        params = sum(p.numel() for p in model.parameters())
        print(f"  ✓ {name}: {params / 1e6:.0f}M parameters, ready in {time.time() - started:.1f}s")
        del model
    print(f"  cache: {os.environ.get('TORCH_HOME', '~/.cache/torch')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
