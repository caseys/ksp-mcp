# MCP for kOS — High-Level Architecture Plan (Authoritative)  
##   
## 0. Purpose  
Design a **terminal-friendly, event-driven control system** for kOS that:  
* Runs automatically at vessel boot  
* Never monopolizes the terminal  
* Exposes live vessel status  
* Accepts commands from local and remote clients  
* Executes complex actions (e.g. landing) deterministically  
* Survives program replacement, aborts, and reboots  
The system must respect kOS’s **single-threaded, non-reentrant execution model**.  
  
## 1. Fundamental Constraints (Non-negotiable)  
Codex **must not violate** these:  
1. Only **one kOS program executes at a time**  
2. RUN / RUNPATH **replace** the current program  
3. The terminal is usable **only while no instructions are executing**  
4. There is **no persistent process**  
5. Triggers (WHEN) may persist after program exit  
6. Files are the **only reliable shared state**  
7. Globals are ephemeral and **must not be authoritative**  
Any design that contradicts these is invalid.  
  
## 2. Core Design Principle  
**The “daemon” is not a loop.The daemon is a set of triggers plus files.**  
There must be:  
* **No infinite loops**  
* **No background polling**  
* **No RUNPATH inside long-running loops**  
Execution must be **short-lived, event-driven, and serialized**.  
  
## 3. System Components (Clear Separation)  
## 3.1 Boot Installer (runs once, exits)  
Responsibilities:  
* Wait for SHIP:UNPACKED  
* Ensure directory structure exists  
* Copy / compile scripts if needed  
* Install triggers  
* Exit immediately  
This is the **only script** set as CORE:BOOTFILENAME.  
  
## 3.2 Triggers (the “resident logic”)  
Responsibilities:  
* Detect *changes*, not poll  
* Update state files  
* Dispatch commands  
* Never block  
Triggers must:  
* Be short  
* Never loop  
* Use PRESERVE  
* Defer all heavy work to short-lived scripts  
  
## 3.3 State (single source of truth)  
Use **files only**.  
Example:  
```
1:/mcp/state.json

```
Contains:  
* Time (UT)  
* Vessel name  
* SOI  
* Target  
* Radio state  
* Current mode (idle / landing / etc.)  
* Last command  
* Error state (if any)  
No script may assume in-memory state is authoritative.a  
  
## 3.4 Command Interface (RPC-like)  
Commands are file-based.  
Example:  
```
1:/mcp/cmd.txt
1:/mcp/resp.txt
1:/mcp/lock.txt

```
Flow:  
1. Client writes cmd.txt  
2. Trigger detects it  
3. Dispatcher runs exactly once  
4. Dispatcher writes response  
5. Dispatcher exits  
No concurrency. No queues unless explicitly implemented.  
  
## 3.5 Action Scripts (e.g. landing)  
Responsibilities:  
* Perform one task  
* Read state from file  
* Write updates to state  
* Exit cleanly  
They must **not**:  
* Install triggers  
* Assume persistence  
* Loop forever  
* Call other long-running scripts  
  
## 3.6 Status Renderer  
Responsibilities:  
* Read state file  
* Print or rewrite status  
* Exit immediately  
Status is **pulled**, not pushed.  
No background printing.  
  
## 4. Explicitly Remove / Do Not Recreate  
Codex must **not recreate**:  
* mcp_env-style “environment scripts”  
* Infinite daemon loops  
* Polling _MCP_OP-style globals  
* Long-running background programs  
* “Service” scripts expecting return  
* Any assumption of parallel execution  
  
## 5. Execution Flow (Authoritative)  
## Boot  
```
BOOTFILENAME → installer → trigger setup → exit

```
## Normal Operation  
```
(trigger fires) → update state → exit

```
## Command Execution  
```
cmd.txt appears
→ trigger fires
→ dispatcher runs
→ action script runs
→ state updated
→ dispatcher exits
→ terminal free

```
  
## 6. Error Handling & Safety  
* Use a lock file to prevent reentry  
* Always delete lock on exit  
* Action scripts must be abort-safe  
* Optional: abort handler writes error state to file  
* No script may assume it will resume  
  
## 7. Client Model  
Clients (human or AI) interact **only via files**.  
They may:  
* Read state.json  
* Write cmd.txt  
* Wait for resp.txt  
They may not:  
* Depend on terminal availability  
* Expect synchronous responses  
* Assume ordering beyond one command at a time  
  
## 8. Style & Discipline Rules for Codex  
Codex must:  
* Favor **small scripts**  
* Use **explicit filenames**  
* Never hide state in globals  
* Avoid cleverness  
* Prefer determinism over convenience  
* Treat kOS like an embedded controller, not an OS  
  
## 9. Success Criteria  
The system is correct if:  
* Terminal is usable >95% of the time  
* No script runs indefinitely  
* Commands always serialize  
* Rebooting the vessel does not corrupt state  
* Landing and other complex actions work identically  
* No part of the system depends on “what ran before”  
  
## 10. Summary (one-paragraph version)  
Implement MCP for kOS as an event-driven, file-backed control system with no persistent processes. A one-shot boot installer installs triggers that react to vessel events and file-based commands. All state is stored in files. All actions are short-lived scripts that read state, act, write results, and exit. There are no daemons, no background loops, no shared memory, and no assumptions of concurrency.  
