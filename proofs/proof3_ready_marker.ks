// PROOF 3: Ready Marker Test
//
// Tests that we can reliably output a marker for TypeScript to detect.
// The marker must appear on its own line after all other output.
//
// INSTRUCTIONS:
// 1. Run: RUNPATH("0:/proofs/proof3_ready_marker").
// 2. Observe terminal output.
// 3. PASS if you see JSON on one line, then [MCP READY]> on the next.
//
// For full test: Have TypeScript send this command WITHOUT Ctrl+C
// and verify it can detect the ready marker in output.

@LAZYGLOBAL OFF.

PRINT "=== PROOF 3: Ready Marker ===".
PRINT "".

// Simulate what mcp_status.ks would do
LOCAL statusJson IS LEXICON(
    "body", SHIP:BODY:NAME,
    "status", SHIP:STATUS,
    "radio", HOMECONNECTION:ISCONNECTED,
    "action", ""
).

PRINT "Below is the exact output format for TypeScript:".
PRINT "--- BEGIN OUTPUT ---".

// This is the contract: one JSON line, then ready marker
PRINT JSON:STRINGIFY(statusJson).
PRINT "[MCP READY]>".

PRINT "--- END OUTPUT ---".
PRINT "".
PRINT "TypeScript should:".
PRINT "1. Read all output".
PRINT "2. Find line containing valid JSON".
PRINT "3. Stop reading when [MCP READY]> appears".
PRINT "4. Parse the JSON line".
PRINT "".
PRINT "PASS: If you see JSON then [MCP READY]> above.".
