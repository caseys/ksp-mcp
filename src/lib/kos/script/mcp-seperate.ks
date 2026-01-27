FOR p IN SHIP:PARTSTAGGED("break") {

    // 1. Stack decouplers, separators, engine plates
    IF p:HASMODULE("ModuleDecouple") {
        p:GETMODULE("ModuleDecouple"):DOEVENT("Decouple").
    }

    // 2. Radial (anchored) decouplers
    ELSEIF p:HASMODULE("ModuleAnchoredDecoupler") {
        p:GETMODULE("ModuleAnchoredDecoupler"):DOEVENT("Decouple").
    }

    // 3. Docking ports
    ELSEIF p:HASMODULE("ModuleDockingNode") {
        LOCAL m IS p:GETMODULE("ModuleDockingNode").

        IF m:HASEVENT("Undock") {
            m:DOEVENT("Undock").
        }
        ELSEIF m:HASEVENT("UndockSameVessel") {
            m:DOEVENT("UndockSameVessel").
        }
        ELSEIF m:HASEVENT("Decouple") {
            m:DOEVENT("Decouple").
        }
    }

    // 4. Fairings
    ELSEIF p:HASMODULE("ModuleProceduralFairing") {
        p:GETMODULE("ModuleProceduralFairing"):DOEVENT("Jettison").
    }
    WAIT 0.
}