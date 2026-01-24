@LAZYGLOBAL OFF.
PARAMETER _setOp IS "-".
LOCAL _op IS "".
IF _setOp <> "-" {
LOCAL opData IS LEXICON("op", _setOp, "ts", TIME:SECONDS).
WRITEJSON(opData, "1:/mcp_op.json").
SET _op TO _setOp.
} ELSE IF EXISTS("1:/mcp_op.json") {
LOCAL opFile IS READJSON("1:/mcp_op.json").
SET _op TO opFile["op"].
}
LOCAL s IS LEXICON().
SET s["v"] TO "__VERSION__".
SET s["op"] TO _op.
SET s["soi"] TO SHIP:BODY:NAME.
SET s["soiParent"] TO CHOOSE "Sun" IF SHIP:BODY:NAME = "Sun" ELSE SHIP:BODY:BODY:NAME.
SET s["apo"] TO CHOOSE -1 IF ORBIT:ECCENTRICITY >= 1 ELSE ROUND(APOAPSIS).
SET s["per"] TO ROUND(PERIAPSIS).
SET s["period"] TO CHOOSE -1 IF ORBIT:ECCENTRICITY >= 1 ELSE ROUND(ORBIT:PERIOD).
SET s["inc"] TO ROUND(ORBIT:INCLINATION,2).
SET s["ecc"] TO ROUND(ORBIT:ECCENTRICITY,4).
SET s["lan"] TO ROUND(ORBIT:LAN,2).
SET s["shipName"] TO SHIP:NAME.
SET s["shipType"] TO SHIP:TYPE.
SET s["status"] TO SHIP:STATUS.
SET s["alt"] TO ROUND(ALTITUDE).
SET s["lat"] TO ROUND(SHIP:LATITUDE,4).
SET s["lng"] TO ROUND(SHIP:LONGITUDE,4).
SET s["deltaV"] TO ROUND(SHIP:DELTAV:CURRENT).
SET s["speed"] TO ROUND(SHIP:VELOCITY:ORBIT:MAG).
SET s["hasNode"] TO HASNODE.
LOCAL _ndv IS 0. LOCAL _neta IS 0. LOCAL _nenc IS ORBIT:HASNEXTPATCH.
IF HASNODE { SET _ndv TO ROUND(NEXTNODE:DELTAV:MAG,1). SET _neta TO ROUND(NEXTNODE:ETA). SET _nenc TO NEXTNODE:ORBIT:HASNEXTPATCH. }
SET s["nodeDv"] TO _ndv.
SET s["nodeEta"] TO _neta.
SET s["nodeHasEnc"] TO _nenc.
SET s["hasNextPatch"] TO ORBIT:HASNEXTPATCH.
SET s["etaApo"] TO ROUND(ETA:APOAPSIS).
SET s["etaPer"] TO ROUND(ETA:PERIAPSIS).
SET s["etaTrans"] TO ROUND(ETA:TRANSITION).
SET s["atmHeight"] TO ROUND(CHOOSE SHIP:BODY:ATM:HEIGHT IF SHIP:BODY:ATM:EXISTS ELSE 0).
SET s["hasAtm"] TO SHIP:BODY:ATM:EXISTS.
LOCAL _tti IS ADDONS:MJ:INFO:TIMETOIMPACT.
SET s["tti"] TO CHOOSE ROUND(_tti) IF _tti:TYPENAME = "Scalar" ELSE -1.
LOCAL _slope IS 0.
IF SHIP:STATUS = "LANDED" OR SHIP:STATUS = "SPLASHED" OR SHIP:STATUS = "PRELAUNCH" { SET _slope TO ROUND(ABS(90 - VANG(SHIP:UP:VECTOR, SHIP:FACING:TOPVECTOR)),1). }
SET s["slope"] TO _slope.
SET s["hasTarget"] TO HASTARGET.
LOCAL _encB IS "". LOCAL _encPe IS 0. LOCAL _encDist IS 0. LOCAL _encAtmH IS 0. LOCAL _encPeTime IS 0.
IF ORBIT:HASNEXTPATCH {
LOCAL _nextPatch IS ORBIT:NEXTPATCH.
IF HASNODE AND NEXTNODE:ORBIT:HASNEXTPATCH { SET _nextPatch TO NEXTNODE:ORBIT:NEXTPATCH. }
SET _encB TO _nextPatch:BODY:NAME.
SET _encPe TO ROUND(_nextPatch:PERIAPSIS).
SET _encDist TO ROUND(_nextPatch:BODY:POSITION:MAG).
SET _encAtmH TO ROUND(_nextPatch:BODY:ATM:HEIGHT).
SET _encPeTime TO ROUND(_nextPatch:ETA:PERIAPSIS).
}
SET s["encBody"] TO _encB.
SET s["encPe"] TO _encPe.
SET s["encDist"] TO _encDist.
SET s["encAtmH"] TO _encAtmH.
SET s["encPeTime"] TO _encPeTime.
LOCAL _tgtName IS "". LOCAL _tgtType IS "". LOCAL _tgtDist IS 0. LOCAL _tgtParent IS "".
IF HASTARGET {
SET _tgtName TO TARGET:NAME.
SET _tgtType TO TARGET:TYPENAME.
SET _tgtDist TO ROUND(TARGET:DISTANCE).
IF TARGET:TYPENAME = "Body" { SET _tgtParent TO TARGET:BODY:NAME. }
}
SET s["tgtName"] TO _tgtName.
SET s["tgtType"] TO _tgtType.
SET s["tgtDist"] TO _tgtDist.
SET s["tgtParent"] TO _tgtParent.
IF HASTARGET AND ADDONS:MJ:HASSUFFIX("TGT") {
SET s["caTime"] TO ADDONS:MJ:TGT:CLOSESTAPPROACHTIME.
SET s["caDist"] TO ADDONS:MJ:TGT:CLOSESTAPPROACHDISTANCE.
SET s["anTime"] TO ADDONS:MJ:TGT:TIMETOAN.
SET s["dnTime"] TO ADDONS:MJ:TGT:TIMETODN.
SET s["anEx"] TO ADDONS:MJ:TGT:ANEXISTS.
SET s["dnEx"] TO ADDONS:MJ:TGT:DNEXISTS.
SET s["relInc"] TO ADDONS:MJ:TGT:RELATIVEINCLINATION.
}
LOCAL tgts IS LIST().
LOCAL _moonParent IS SHIP:BODY.
IF SHIP:BODY:BODY:NAME <> "Sun" { SET _moonParent TO SHIP:BODY:BODY. }
LOCAL _allBodies IS LIST(). LIST BODIES IN _allBodies.
FOR b IN _allBodies {
IF b:NAME <> SHIP:BODY:NAME AND b:NAME <> "Sun" {
LOCAL _dist IS ROUND((b:POSITION - SHIP:POSITION):MAG).
IF b:BODY:NAME = "Sun" { tgts:ADD(LEXICON("type", "planet", "name", b:NAME, "distance", _dist)). }
ELSE IF b:BODY = _moonParent { tgts:ADD(LEXICON("type", "moon", "name", b:NAME, "distance", _dist)). }
}
}
LOCAL _vessels IS LIST(). LIST TARGETS IN _vessels.
FOR v IN _vessels {
IF v <> SHIP AND v:BODY = SHIP:BODY { tgts:ADD(LEXICON("type", "vessel", "name", v:NAME, "distance", ROUND((v:POSITION - SHIP:POSITION):MAG))). }
}
SET s["targets"] TO tgts.
WRITEJSON(s, "1:/mcp_status.json").
CLEARSCREEN.
LOCAL fileContent IS OPEN("1:/mcp_status.json"):READALL.
LOCAL result IS "".
LOCAL typeStack IS LIST().
LOCAL pendingOpen IS FALSE.
FOR line IN fileContent {
SET line TO line:TRIM().
IF line:CONTAINS("$type") { }
ELSE IF line = "{" { SET pendingOpen TO TRUE. }
ELSE IF line = "}," OR line = "}" {
IF typeStack:LENGTH > 0 {
LOCAL top IS typeStack[typeStack:LENGTH - 1]. typeStack:REMOVE(typeStack:LENGTH - 1).
IF top = "lex" { IF line = "}," { SET result TO result + "},". } ELSE { SET result TO result + "}". } }
ELSE IF top = "list" { }
}
SET pendingOpen TO FALSE.
}
ELSE IF line = "]," OR line = "]" {
SET result TO result + line.
}
ELSE IF line:STARTSWITH(CHAR(34) + "value" + CHAR(34)) {
IF pendingOpen { typeStack:ADD("val"). SET pendingOpen TO FALSE. }
LOCAL colonPos IS line:FIND(":").
IF colonPos > 0 {
LOCAL val IS line:SUBSTRING(colonPos + 1, line:LENGTH - colonPos - 1):TRIM().
IF val:ENDSWITH(",") { SET val TO val:SUBSTRING(0, val:LENGTH - 1). }
SET result TO result + val + ",".
}
}
ELSE IF line:STARTSWITH(CHAR(34) + "entries" + CHAR(34)) {
IF pendingOpen { typeStack:ADD("lex"). SET result TO result + "{". SET pendingOpen TO FALSE. }
SET result TO result + line.
}
ELSE IF line:STARTSWITH(CHAR(34) + "items" + CHAR(34)) {
IF pendingOpen { typeStack:ADD("list"). SET pendingOpen TO FALSE. }
SET result TO result + "[".
}
ELSE { SET result TO result + line. }
}
IF result:ENDSWITH(",}") { SET result TO result:SUBSTRING(0, result:LENGTH - 2) + "}". }
SET result TO result:REPLACE(",]", "]"). SET result TO result:REPLACE(",}", "}").
PRINT result.
PRINT "[MCP_STATUS_END]".
