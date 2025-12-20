# MCP Transport Stabilization Plan

## Goals
- Restore a reliable end-of-output signal so `KosConnection.execute()` no longer returns empty responses.
- Add observability that captures raw telnet transcripts whenever we experiment with protocol parsing.
- Introduce an explicit sentinel-based completion strategy to replace timing assumptions while keeping the improved Unicode cleanup logic.

## Planned Work
1. **Revert to prompt-based completion for stability**
   - Replace the current CRLF/timed drain loop in `src/transport/kos-connection.ts` with the original `waitFor(/>\s*$/)` logic from commit `8ddd905`.
   - Keep the modernized `cleanOutput()` and Unicode stripping helpers intact.
   - Retest ascent/mechjeb flows to confirm the regression is resolved before making further changes.

2. **Add optional raw trace logging**
   - Extend `BaseTransport` (or the socket transport) with a `KOS_TRACE` env toggle that writes all bytes read/written to timestamped logs.
   - Use the traces to capture real world samples of slow MechJeb interactions and complex screen updates to guide future parsing work.

3. **Implement explicit sentinel completion**
   - After every user command, enqueue a unique `PRINT "__MCP_DONE_<token>".` sentinel and wait for that token in the stream.
   - Consider wrapping this in a helper so both command and sentinel share the same timeout budget but report clearer errors when the sentinel never appears.
   - Strip the sentinel line during `cleanOutput()` so callers only see the original command output.

4. **Optimize and harden once sentinel flow works**
   - Replace arbitrary delays with a tight read loop that stops when the sentinel is seen.
   - Add fallback logic: if the sentinel is missed (e.g., command crashed), fall back to prompt wait + trace dump.
   - Document the new protocol expectations in `docs/kos-protocol-analysis.md` so future refactors start from the proven design rather than speculation.

5. **Regression testing**
   - Re-run existing CLI tools (`npm run ascent`, `npm run test:connection`, etc.) using both socket and tmux transports.
   - Capture trace samples of successful and failing commands to validate that the sentinel approach eliminates timing-dependent gaps.

## Open Questions
- Does kOS ever emit `>` in legitimate output (e.g., `PRINT ">"`), and if so should prompt detection remain as a last-resort fallback?
- Should sentinel insertion be optional for interactive REPL flows, or can we enforce it everywhere without affecting user experience?
