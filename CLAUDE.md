# CLAUDE.md

## Research journal

Keep a running research journal at `local/JOURNAL.md` (the `local/` tree
is gitignored). Append a dated entry whenever you:

- discover something about the Portacount 8030 (USB descriptors, MAC, IPs,
  ports, message formats, timing) or device behavior on the wire
- run a capture/sniff session — record what you tried, what worked, what
  didn't, and the artifacts produced
- form or discard a hypothesis about the wire protocol
- make a non-obvious design decision in the WebUSB / wire / lwIP / protocol
  layers

Format: `## YYYY-MM-DD — short title` headings, newest at the bottom.
Prefer concrete evidence (hex dumps, line refs, command output) over prose.
Link out to scripts, captures, or commits where relevant.
