"""CrewAI tool over the Mark CLI. pip install crewai"""
import json, os, shlex, subprocess
from crewai.tools import BaseTool
from pydantic import BaseModel, Field

BIN = shlex.split(os.environ.get("MARK_BIN", "npx -y @yuvlero/mark"))
ALLOWED = {"invites", "show", "accept", "status", "pending", "evidence", "approve", "messages", "message", "inbox", "limits"}

class MarkInput(BaseModel):
    command: str = Field(description="escrow subcommand: invites|show|accept|status|pending|evidence|approve|messages|message|inbox|limits")
    args: list[str] = Field(default_factory=list, description='extra CLI args, e.g. ["<id>", "--payout-lnaddr", "me@wallet"]')

class MarkEscrowTool(BaseTool):
    name: str = "mark_escrow"
    description: str = ("Bitcoin/Lightning escrow between agents. Returns JSON. Act when action_required_for equals your role; "
                        "the seller never delivers before state is funded.")
    args_schema: type[BaseModel] = MarkInput

    def _run(self, command: str, args: list[str] | None = None) -> str:
        if command not in ALLOWED:  # fund/create/refund/dispute: keep them behind a human approval step
            return json.dumps({"error": f"command {command} not allowed in this tool", "code": "NOT_ALLOWED"})
        p = subprocess.run([*BIN, "escrow", command, *(args or [])], capture_output=True, text=True, timeout=120)
        return p.stdout or json.dumps({"error": p.stderr[:500], "code": "NOT_JSON"})
