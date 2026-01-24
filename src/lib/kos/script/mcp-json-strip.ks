@LAZYGLOBAL OFF.
PARAMETER filePath IS "1:/mcp_status.json".

LOCAL f IS OPEN(filePath).
IF f = False {
PRINT "ERROR: File not found: " + filePath.
RETURN.
}

LOCAL content IS f:READALL.
LOCAL result IS "".
LOCAL typeStack IS LIST().
LOCAL pendingOpen IS FALSE.

FOR line IN content {
SET line TO line:TRIM().

IF line:CONTAINS("$type") {
}
ELSE IF line = "{" {
SET pendingOpen TO TRUE.
}
ELSE IF line = "}," OR line = "}" {
IF typeStack:LENGTH > 0 {
LOCAL top IS typeStack[typeStack:LENGTH - 1].
typeStack:REMOVE(typeStack:LENGTH - 1).
IF top = "lex" {
IF line = "}," {
SET result TO result + "},".
} ELSE {
SET result TO result + "}".
}
}
}
SET pendingOpen TO FALSE.
}
ELSE IF line:STARTSWITH(CHAR(34) + "value" + CHAR(34)) {
IF pendingOpen {
typeStack:ADD("val").
SET pendingOpen TO FALSE.
}
LOCAL colonPos IS line:FIND(":").
IF colonPos > 0 {
LOCAL val IS line:SUBSTRING(colonPos + 1, line:LENGTH - colonPos - 1):TRIM().
IF val:ENDSWITH(",") {
SET val TO val:SUBSTRING(0, val:LENGTH - 1).
}
SET result TO result + val + ",".
}
}
ELSE IF line:STARTSWITH(CHAR(34) + "entries" + CHAR(34)) {
IF pendingOpen {
typeStack:ADD("lex").
SET result TO result + "{".
SET pendingOpen TO FALSE.
}
SET result TO result + line.
}
ELSE {
SET result TO result + line.
}
}

IF result:ENDSWITH(",}") {
SET result TO result:SUBSTRING(0, result:LENGTH - 2) + "}".
}
SET result TO result:REPLACE(",]", "]").
SET result TO result:REPLACE(",}", "}").

CLEARSCREEN.
PRINT result.
