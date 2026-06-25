#!/usr/bin/env python3
"""Fetch the TRINITY head weights + frozen base model for the trinity-head policy.

The GAIA core ships NO weights and NO torch dependency (the RoutingPolicy seam is
language-agnostic by design). This optional helper places the trained artifacts
where setups/fugu-trinity/setup.json expects them:

    ~/.gaia/plugins/fugu/model_iter_60.npy     # the trained SVF/head weights
    (base model pulled by transformers on first use: Qwen/Qwen3-0.6B)

Provenance: the weights are produced by openfugu's training (sep-CMA-ES over the
<20K-param head), or downloaded from the openfugu release if published. This
script is a placeholder that documents the contract and creates the target dir;
wire it to your actual artifact source (a release URL, an S3 path, or a local
training run) before relying on trinity-head.
"""
import os
import sys
import urllib.request

DEST_DIR = os.path.expanduser("~/.gaia/plugins/fugu")
WEIGHTS = os.path.join(DEST_DIR, "model_iter_60.npy")
# Set FUGU_WEIGHTS_URL to a real artifact location to enable the download.
WEIGHTS_URL = os.environ.get("FUGU_WEIGHTS_URL", "")


def main() -> int:
    os.makedirs(DEST_DIR, exist_ok=True)
    print(f"target: {WEIGHTS}")

    if os.path.isfile(WEIGHTS):
        print("weights already present — nothing to do.")
        return 0
    if not WEIGHTS_URL:
        print(
            "No FUGU_WEIGHTS_URL set. Provide the trained head weights yourself:\n"
            "  - train via your openfugu checkout (sep-CMA-ES over the linear head), or\n"
            "  - download a published release artifact, then place it at the target path.\n"
            f"  cp model_iter_60.npy {WEIGHTS}",
            file=sys.stderr,
        )
        return 1

    print(f"downloading {WEIGHTS_URL} …")
    urllib.request.urlretrieve(WEIGHTS_URL, WEIGHTS)
    print("done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
