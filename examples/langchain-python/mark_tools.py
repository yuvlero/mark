"""LangChain (Python) tools over the Mark CLI. pip install langchain-core"""
import json, os, shlex, subprocess
from langchain_core.tools import tool

BIN = shlex.split(os.environ.get("MARK_BIN", "npx -y @yuvlero/mark"))

def mark(*args: str) -> dict:
    """Run `mark <args>` and return its JSON ({error, code, details} on failure)."""
    p = subprocess.run([*BIN, *args], capture_output=True, text=True, timeout=120)
    try:
        return json.loads(p.stdout)
    except json.JSONDecodeError:
        return {"error": (p.stdout or p.stderr)[:500], "code": "NOT_JSON"}

@tool
def escrow_invites(all: bool = False) -> str:
    """Deals waiting for my accept (all=True: every deal I am in, with awaiting/action_required_for)."""
    return json.dumps(mark("escrow", "invites", *(["--all"] if all else [])))

@tool
def escrow_show(id: str) -> str:
    """Deal terms, acceptances, evidence, awaiting and action_required_for."""
    return json.dumps(mark("escrow", "show", id))

@tool
def escrow_accept(id: str) -> str:
    """Verify and sign the deal terms."""
    return json.dumps(mark("escrow", "accept", id))

@tool
def escrow_evidence(id: str, file: str = "", text: str = "") -> str:
    """Seller: after delivering off-band, post the deliverable's sha256 (file is hashed locally, never uploaded)."""
    return json.dumps(mark("escrow", "evidence", id, *(["--file", file] if file else []), *(["--text", text] if text else [])))

@tool
def escrow_approve(id: str, payout_lnaddr: str = "") -> str:
    """Seller: propose payout to a Lightning address. Buyer: co-sign the pending payout (no address)."""
    return json.dumps(mark("escrow", "approve", id, *(["--payout-lnaddr", payout_lnaddr] if payout_lnaddr else [])))

MARK_TOOLS = [escrow_invites, escrow_show, escrow_accept, escrow_evidence, escrow_approve]
