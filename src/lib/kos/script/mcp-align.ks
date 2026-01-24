// ==================================================
// mcp-align.ks
//
// Align vessel to maneuver node.
//
// Strategy:
//   1) Normalize control (no SAS, no steering)
//   2) Optional RCS assist
//   3) Try SAS MANEUVER (read-back probe)
//   4) Fall back to kOS LOCK STEERING if needed
//   5) Watchdog reset ONLY for kOS steering
//   6) Freeze final attitude with SAS STABILITY
//   7) Clean warp exit
//
// PARAMETERS:
//   RCS_MODE (0-3)
//     0 = do not touch RCS
//     1 = RCS on during alignment
//     2 = short burst at start + end
//     3 = pulsed RCS assist
//
//   USE_SAS (BOOLEAN)
//     TRUE  = allow SAS MANEUVER attempt
//     FALSE = force kOS steering
// ==================================================


// ------------------ parameters ------------------
PARAMETER RCS_MODE IS 0.
PARAMETER USE_SAS IS TRUE.


// ------------------ save state ------------------
SET __origSAS TO SAS.
SET __origRCS TO RCS.


// ------------------ enter physics warp x2 ------------------
SET KUNIVERSE:TIMEWARP:MODE TO "PHYSICS".
WAIT 0.
SET KUNIVERSE:TIMEWARP:RATE TO 1.    // 2x
WAIT 0.

PRINT "ALIGN: physics warp x2 engaged".


// ------------------ normalize control ------------------
UNLOCK STEERING.
SET SAS TO FALSE.
WAIT 0.


// ------------------ RCS assist (start) ------------------
IF RCS_MODE > 0 {
    SET RCS TO TRUE.
    WAIT 0.
}


// ==================================================
// SAS-first attempt (only if crewed - probes may not support MANEUVER)
// ==================================================
SET sas_ok TO FALSE.

// Only try SAS MANEUVER on crewed vessels (probes throw errors)
IF USE_SAS AND HASNODE AND SHIP:CREW:LENGTH > 0 {

    PRINT "ALIGN: attempting SAS MANEUVER".

    SET SAS TO TRUE.
    WAIT 0.

    SET SASMODE TO "MANEUVER".
    WAIT 0.

    IF SASMODE = "MANEUVER" {
        SET sas_ok TO TRUE.
        PRINT "ALIGN: SAS MANEUVER active".
    }
}


// ==================================================
// Fallback: kOS steering
// ==================================================
IF NOT sas_ok {

    PRINT "ALIGN: falling back to kOS steering".

    SET SAS TO FALSE.
    WAIT 0.

    LOCK STEERING TO NEXTNODE:BURNVECTOR.
}


// ==================================================
// RCS pulse mode
// ==================================================
IF RCS_MODE = 3 {

    PRINT "ALIGN: RCS pulse assist".

    LOCAL i IS 0.
    UNTIL i >= 3 {
        SET RCS TO TRUE.
        WAIT 0.05.
        SET RCS TO FALSE.
        WAIT 0.1.
        SET i TO i + 1.
    }
}


// ==================================================
// Settle + watchdog (kOS steering only)
// ==================================================
IF NOT sas_ok {

    PRINT "ALIGN: kOS steering settle + watchdog".

    SET stuckTime TO 0.
    SET tStart TO TIME:SECONDS.

    // Wait up to 30 seconds for alignment (kOS steering can be slow)
    UNTIL TIME:SECONDS - tStart > 30 {

        // Check current alignment
        SET errAngle TO VANG(SHIP:FACING:FOREVECTOR, NEXTNODE:BURNVECTOR).

        // Break when aligned (< 1 degree)
        IF errAngle < 1 {
            PRINT "ALIGN: kOS aligned (" + ROUND(errAngle, 1) + " deg)".
            BREAK.
        }

        // Watchdog: detect if steering is stuck
        IF STEERINGMANAGER:ENABLED {

            IF STEERINGMANAGER:ANGLEERROR > 1
               AND SHIP:ANGULARVEL:MAG < 0.001 {

                SET stuckTime TO stuckTime + 0.2.

                IF stuckTime > 0.6 {
                    PRINT "ALIGN: watchdog reset".
                    UNLOCK STEERING.
                    WAIT 0.
                    LOCK STEERING TO NEXTNODE:BURNVECTOR.
                    SET stuckTime TO 0.
                }

            } ELSE {
                SET stuckTime TO 0.
            }
        }

        WAIT 0.2.
    }
}


// ------------------ SAS settle window ------------------
IF sas_ok {
    PRINT "ALIGN: SAS settling".

    // Wait for alignment to complete (max 5 seconds)
    SET tStart TO TIME:SECONDS.
    UNTIL TIME:SECONDS - tStart > 5 {
        SET errAngle TO VANG(SHIP:FACING:FOREVECTOR, NEXTNODE:BURNVECTOR).
        IF errAngle < 1 {
            PRINT "ALIGN: SAS aligned (" + ROUND(errAngle, 1) + " deg)".
            BREAK.
        }
        WAIT 0.2.
    }
}


// ------------------ RCS end burst ------------------
IF RCS_MODE = 2 {
    SET RCS TO TRUE.
    WAIT 0.1.
}


// ------------------ restore RCS ------------------
SET RCS TO __origRCS.
WAIT 0.


// ------------------ restore SAS (freeze attitude) ------------------
SET SAS TO __origSAS.
WAIT 0.

IF __origSAS {
    SET SASMODE TO "STABILITY".
    WAIT 0.
}


// ------------------ clean warp exit ------------------
SET KUNIVERSE:TIMEWARP:MODE TO "RAILS".
WAIT 0.
SET KUNIVERSE:TIMEWARP:RATE TO 0.
WAIT 0.

// ------------------ report final state ------------------
LOCAL finalError IS ROUND(VANG(SHIP:FACING:FOREVECTOR, NEXTNODE:BURNVECTOR), 1).
LOCAL method IS "KOS".
IF sas_ok { SET method TO "SAS". }
CLEARSCREEN.
PRINT "ALIGN_COMPLETE:" + method + ":" + finalError.
