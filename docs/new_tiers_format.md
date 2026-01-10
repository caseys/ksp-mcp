# Tiers Resource Format

The `ksp://tiers` MCP resource returns a JSON array with 4 elements, one for each tool tier.

## Structure

```json
[
  { "_desc": "...", "tool_name": { "description": "..." }, ... },
  { "_desc": "...", "tool_name": { "description": "..." }, ... },
  { "_desc": "...", "tool_name": { "description": "..." }, ... },
  { "_desc": "...", "tool_name": { "description": "..." }, ... }
]
```

- **Array index 0**: Tier 1 tools
- **Array index 1**: Tier 2 tools
- **Array index 2**: Tier 3 tools
- **Array index 3**: Tier 4 tools

## Fields

### `_desc`
A brief summary of representative tools in the tier. Useful for quick identification without parsing all tool names.

### Tool entries
Each tool is a key with an object value containing:
- `description`: The tool's description string

## Tier Descriptions

| Tier | Purpose | Examples |
|------|---------|----------|
| 1 | Core Mission Operations | launch, land, circularize, inclination, warp |
| 2 | Maneuvers & Orbital Changes | match_velocities, adjust_apoapsis, ellipticize, crash_avoidance |
| 3 | Targeting & Landing Config | get_target_info, clear_target, set_position_target |
| 4 | Utility & Low-Level | run_script, load_save, command |

## Example Output

```json
[
  {
    "_desc": "launch, land, circularize, inclination, warp...",
    "land": {
      "description": "Land on surface from orbit."
    },
    "launch": {
      "description": "Launch from pad or ground to orbit. Automatically circularizes after ascent."
    },
    "circularize": {
      "description": "Circularize to a stable orbit in current SOI."
    }
  },
  {
    "_desc": "match_velocities, adjust_apoapsis, ellipticize, crash_avoidance...",
    "match_velocities": {
      "description": "Match speed with target for docking in same SOI."
    },
    "adjust_apoapsis": {
      "description": "Change orbit high point. Use to raise/lower orbit."
    }
  },
  {
    "_desc": "get_target_info, clear_target, set_position_target...",
    "get_target_info": {
      "description": "Get comprehensive target information: orbit, position, velocity, and rendezvous data."
    }
  },
  {
    "_desc": "run_script, load_save, command...",
    "run_script": {
      "description": "Run kOS script file."
    },
    "command": {
      "description": "Run raw kOS command."
    }
  }
]
```

## Usage

Access via MCP resource read:
```
uri: ksp://tiers
```

The resource requires no parameters and returns the current tool tier configuration.
