// =======================================================
// Roll oscillation detector (back-and-forth rotation)
// Trigger-only, no loops
// =======================================================

IF NOT EXISTS("OSC_TRIGGERS_INSTALLED") OR NOT OSC_TRIGGERS_INSTALLED {

    SET GLOBAL OSC_TRIGGERS_INSTALLED TO TRUE.

    // ---------- configuration ----------
    SET AXIS   TO SHIP:FACING:ROLLVECTOR.
    SET THRESH TO 0.2.     // rad/s (edge threshold)
    SET WINDOW TO 1.0.     // seconds (max time between reversals)
    SET DEAD   TO 0.05.    // rad/s (settle zone)

    // ---------- master enable ----------
    SET OSC_ENABLED TO TRUE.

    // ---------- state ----------
    SET POS_T TO -1.
    SET NEG_T TO -1.

    // Invariant:
    //  - Initial/reset: POS_ARMED = TRUE, NEG_ARMED = TRUE
    //  - After first edge: exactly one is TRUE
    SET POS_ARMED TO TRUE.
    SET NEG_ARMED TO TRUE.

    // Latch prevents repeated firing per oscillation
    SET OSC_LATCH TO FALSE.

    // ---------- + roll edge ----------
    WHEN OSC_ENABLED
    AND POS_ARMED
    AND (SHIP:ANGULARVEL DOT AXIS) > THRESH THEN {

        SET POS_T TO TIME:SECONDS.
        SET POS_ARMED TO FALSE.
        SET NEG_ARMED TO TRUE.
    }.

    // ---------- - roll edge ----------
    WHEN OSC_ENABLED
    AND NEG_ARMED
    AND (SHIP:ANGULARVEL DOT AXIS) < -THRESH THEN {

        SET NEG_T TO TIME:SECONDS.
        SET NEG_ARMED TO FALSE.
        SET POS_ARMED TO TRUE.
    }.

    // ---------- coordinator: confirms oscillation ----------
    WHEN OSC_ENABLED
    AND (NOT OSC_LATCH)
    AND POS_T >= 0
    AND NEG_T >= 0
    AND ABS(POS_T - NEG_T) <= WINDOW THEN {

        SET OSC_LATCH TO TRUE.
        PRINT "BACK-AND-FORTH ROLL OSCILLATION DETECTED".

        // Consume the pair so a fresh alternation is required
        SET POS_T TO -1.
        SET NEG_T TO -1.
    }.

    // ---------- re-arm after settling ----------
    WHEN OSC_ENABLED
    AND OSC_LATCH
    AND ABS(SHIP:ANGULARVEL DOT AXIS) < DEAD THEN {

        SET OSC_LATCH TO FALSE.

        // Reset to initial state
        SET POS_ARMED TO TRUE.
        SET NEG_ARMED TO TRUE.
    }.
}.