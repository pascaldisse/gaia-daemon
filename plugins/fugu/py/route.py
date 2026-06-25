#!/usr/bin/env python3
"""TRINITY router sidecar for the `trinity-head` routing policy.

The TS policy (src/runtime/monad/policies/trinity-head.ts) spawns this script once
per turn, writes the raw "role: content" transcript to stdin, and reads ONE JSON
line from stdout:

    {"agent_id": <int>, "role_id": <int>}        # role_id: 0=worker 1=thinker 2=verifier

That is exactly the contract of openfugu/mini.py's FuguRouter.route(messages):
a frozen Qwen3-0.6B forwards the transcript, a tiny bias-free linear head reads
the penultimate hidden state, and argmax over the worker logits (and, when
--roles is on, the 3 role logits) gives the decision. The SVF/head weights are
the trained artifact (model_iter_60.npy); fetch them with fetch_artifacts.py.

This file is intentionally a thin, dependency-light wrapper: it shells the real
inference out to a local openfugu checkout if present, so GAIA core ships no
torch dependency. If openfugu / torch / the weights are missing it prints a clear
error to stderr and exits non-zero — the TS policy surfaces that verbatim.

Usage (driven by the policy, not by hand):
    cat transcript.txt | python3 route.py --weights model_iter_60.npy \
        --base-model Qwen/Qwen3-0.6B [--no-roles]
"""
import argparse
import json
import os
import sys


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def main() -> int:
    parser = argparse.ArgumentParser(description="TRINITY router sidecar")
    parser.add_argument("--weights", help="path to the trained head weights (model_iter_*.npy)")
    parser.add_argument("--base-model", default="Qwen/Qwen3-0.6B", help="frozen base model id/path")
    parser.add_argument("--no-roles", action="store_true", help="production L-only head (drop the 3 role logits)")
    parser.add_argument("--openfugu", default=os.environ.get("OPENFUGU_DIR", ""), help="path to an openfugu checkout (for mini.FuguRouter)")
    args = parser.parse_args()

    transcript = sys.stdin.read()
    if not transcript.strip():
        log("route.py: empty transcript on stdin")
        return 2

    # Prefer the real router from a local openfugu checkout. We do NOT vendor it
    # (Apache/Llama-licensed); the plugin points at the user's checkout.
    openfugu_dir = args.openfugu or _guess_openfugu_dir()
    if not openfugu_dir or not os.path.isdir(openfugu_dir):
        log("route.py: no openfugu checkout found. Clone github.com/trotsky1997/openfugu and set --openfugu or $OPENFUGU_DIR.")
        return 3
    if not args.weights or not os.path.isfile(os.path.expanduser(args.weights)):
        log(f"route.py: weights not found: {args.weights}. Run plugins/fugu/py/fetch_artifacts.py first.")
        return 4

    sys.path.insert(0, openfugu_dir)
    try:
        # mini.py exposes the FuguRouter used in the paper's self-test.
        from mini import FuguRouter  # type: ignore
    except Exception as exc:  # pragma: no cover - depends on user's environment
        log(f"route.py: cannot import openfugu mini.FuguRouter ({exc}). Is torch installed?")
        return 5

    try:
        router = FuguRouter(
            base_model=args.base_model,
            weights=os.path.expanduser(args.weights),
            with_roles=not args.no_roles,
        )
        agent_id, role_id = router.route(transcript)
    except Exception as exc:  # pragma: no cover
        log(f"route.py: routing failed ({exc})")
        return 6

    out = {"agent_id": int(agent_id)}
    if not args.no_roles and role_id is not None:
        out["role_id"] = int(role_id)
    print(json.dumps(out))
    return 0


def _guess_openfugu_dir() -> str:
    for candidate in (
        os.path.join(os.path.dirname(__file__), "..", "vendor", "openfugu"),
        os.path.expanduser("~/.gaia/plugins/fugu/openfugu"),
    ):
        if os.path.isdir(candidate):
            return os.path.abspath(candidate)
    return ""


if __name__ == "__main__":
    raise SystemExit(main())
