// -------------------- roll helper --------------------
IF DEFINED ROLL_TRIM_INSTALLED {
    // Already installed in this CPU session, skip.
} ELSE {

    SET ROLL_TRIM_INSTALLED TO TRUE.

    // -------------------- configuration --------------------
    SET ROLL_TRIM_ENABLED TO TRUE.
    SET ROLL_MODE TO "HOLD".        // OFF | HOLD | ABSOLUTE | BODY_UP | NODE
    SET TARGET_ABS_ROLL TO 0.

    // -------------------- timing --------------------
    SET LAST_T TO TIME:SECONDS.

    FUNCTION APPLY_ROLL_TRIM {
        PARAMETER target_roll_deg.

        LOCAL err IS SHIP:ROLL - target_roll_deg.

        // normalize to -180..180
        IF err > 180 { SET err TO err - 360. }
        IF err < -180 { SET err TO err + 360. }

        SET SHIP:CONTROL:ROLLTRIM TO
            MAX(-1, MIN(1, -err / 40)).
    }.

    FUNCTION GET_TARGET_ROLL {

        PARAMETER mode.

        // Explicit OFF
        IF mode = "OFF" {
            RETURN SHIP:ROLL.   // no correction, trim already zeroed
        }

        IF mode = "ABSOLUTE" {
            RETURN TARGET_ABS_ROLL.
        }

        IF mode = "HOLD" {
            RETURN SHIP:ROLL.
        }

        IF mode = "BODY_UP" {
            RETURN BODY_RELATIVE_ROLL().
        }

        IF mode = "NODE" AND HASNODE {
            RETURN NODE_RELATIVE_ROLL().
        }

        // Safe fallback
        RETURN SHIP:ROLL.
    }.

    // -------------------- control loop --------------------
    WHEN TIME:SECONDS > LAST_T + 0.25 THEN {

        SET LAST_T TO TIME:SECONDS.

        IF NOT ROLL_TRIM_ENABLED OR ROLL_MODE = "OFF" {
            // hard neutral when disabled
            SET SHIP:CONTROL:ROLLTRIM TO 0.
            PRESERVE.
        }

        SET target TO GET_TARGET_ROLL(ROLL_MODE).
        APPLY_ROLL_TRIM(target).

        PRESERVE.
    }

}