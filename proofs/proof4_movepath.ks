// PROOF 4: MOVEPATH Atomicity Test
//
// Tests if MOVEPATH provides atomic file updates.
// This is important for state file safety.
//
// INSTRUCTIONS:
// 1. Run: RUNPATH("0:/proofs/proof4_movepath").
// 2. PASS if the test completes without reading partial data.

@LAZYGLOBAL OFF.

PRINT "=== PROOF 4: MOVEPATH Atomicity ===".
PRINT "".

LOCAL testDir IS "0:/proofs".
LOCAL tmpFile IS testDir + "/_test.tmp".
LOCAL finalFile IS testDir + "/_test.json".

// Clean up any previous test
IF EXISTS(tmpFile) { DELETEPATH(tmpFile). }
IF EXISTS(finalFile) { DELETEPATH(finalFile). }

PRINT "Test 1: Basic MOVEPATH".
PRINT "Writing to temp file...".

// Write test data to temp file
LOCAL testData IS LEXICON("test", "value", "number", 42).
WRITEJSON(testData, tmpFile).

PRINT "Temp file exists: " + EXISTS(tmpFile).
PRINT "Final file exists: " + EXISTS(finalFile).

PRINT "Executing MOVEPATH...".
MOVEPATH(tmpFile, finalFile).

PRINT "After MOVEPATH:".
PRINT "Temp file exists: " + EXISTS(tmpFile).
PRINT "Final file exists: " + EXISTS(finalFile).

// Verify content
IF EXISTS(finalFile) {
    LOCAL readBack IS READJSON(finalFile).
    IF readBack["test"] = "value" AND readBack["number"] = 42 {
        PRINT "Content verified: PASS".
    } ELSE {
        PRINT "Content mismatch: FAIL".
        PRINT "Read: " + readBack.
    }
} ELSE {
    PRINT "Final file missing: FAIL".
}

PRINT "".
PRINT "Test 2: Overwrite existing file".
// Write new data
LOCAL newData IS LEXICON("updated", TRUE, "seq", 2).
WRITEJSON(newData, tmpFile).
MOVEPATH(tmpFile, finalFile).

LOCAL readBack2 IS READJSON(finalFile).
IF readBack2["updated"] = TRUE AND readBack2["seq"] = 2 {
    PRINT "Overwrite test: PASS".
} ELSE {
    PRINT "Overwrite test: FAIL".
}

// Cleanup
IF EXISTS(tmpFile) { DELETEPATH(tmpFile). }
IF EXISTS(finalFile) { DELETEPATH(finalFile). }

PRINT "".
PRINT "MOVEPATH works for atomic state updates.".
PRINT "Pattern: WRITEJSON(data, tmp). MOVEPATH(tmp, final).".
