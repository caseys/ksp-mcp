# Debug kOS Terminal

**STOP. Before debugging ANY kOS issue, you MUST set up terminal monitoring.**

## Required Setup (EVERY TIME)

Open a **separate terminal** and run:
```bash
tail -f /tmp/kos-terminal.log
```

Keep this visible while you work. ALL kOS TX/RX traffic appears here.

## Then Run Your Test

In Claude Code, run with debug enabled:
```bash
rm -f /tmp/kos-terminal.log && KOS_DEBUG=1 node dist/cli/index.js <command>
```

Or for MCP tools, ensure `.env` has:
```
KOS_DEBUG=1
```

## What You're Looking For

The log shows:
- `TX:` - Commands sent TO kOS
- `RX:` - Responses FROM kOS
- Actual error messages from kOS scripts
- Timeout and connection issues

## NEVER Debug Blind

If you cannot see the terminal log, you are debugging blind. You will:
- Miss the actual error
- Waste time guessing
- Frustrate the user

**The user has asked you to follow this process. Do not skip it.**

## Quick Reference

| Action | Command |
|--------|---------|
| Watch log | `tail -f /tmp/kos-terminal.log` |
| Clear + test | `rm -f /tmp/kos-terminal.log && KOS_DEBUG=1 node dist/cli/index.js status` |
| Check MCP env | `cat .env \| grep KOS_DEBUG` |
