import { z } from 'zod';
import { SocketTransport } from '../transport/socket-transport.js';
import { TmuxTransport } from '../transport/tmux-transport.js';
import type { Transport } from '../transport/transport.js';
import { config } from '../config/index.js';

export interface CpuInfo {
  id: number;
  vessel: string;
  partName: string;
  tag: string;
  guiOpen: boolean;
  telnets: number;
}

/**
 * Parse CPU menu line into structured CpuInfo
 * Menu format: "[1]   no    1     stick 1 (RC-L01(guidance))"
 * Format: [id] guiOpen? telnets vesselName (PartName(tag))
 */
function parseCpuMenuLine(line: string): CpuInfo | null {
  // Match: [id] gui telnets vessel (Part(tag))
  const match = line.match(/\[\s*(\d+)\]\s+(\w+)\s+(\d+)\s+(.+?)\s+\(([^(]+)\(([^)]*)\)\)/);
  if (!match) {
    return null;
  }

  const [, idStr, guiStr, telnetsStr, vessel, partName, tag] = match;

  return {
    id: Number.parseInt(idStr),
    vessel: vessel.trim(),
    partName: partName.trim(),
    tag: tag || '(unnamed)',
    guiOpen: guiStr === 'yes',
    telnets: Number.parseInt(telnetsStr),
  };
}

/**
 * Parse CPU menu output into array of CpuInfo
 */
function parseCpuMenu(output: string): CpuInfo[] {
  const lines = output.split('\n');
  const cpus: CpuInfo[] = [];

  for (const line of lines) {
    const cpu = parseCpuMenuLine(line);
    if (cpu) {
      cpus.push(cpu);
    }
  }

  return cpus;
}

/**
 * List available kOS CPUs by connecting temporarily and parsing the menu
 */
export async function handleListCpus(rawInput: z.input<typeof listCpusInputSchema>): Promise<CpuInfo[]> {
  // Parse input to apply defaults
  const input = listCpusInputSchema.parse(rawInput);
  let transport: Transport | null = null;

  // Determine effective transport type: explicit input > config > default 'socket'
  const transportType = input.transportType ?? config.transport.type ?? 'socket';

  try {
    // Create temporary transport based on type
    if (transportType === 'tmux') {
      transport = new TmuxTransport(input.host, input.port);
    } else {
      // Default: socket transport (no external dependencies)
      transport = new SocketTransport(input.host, input.port);
    }

    // Initialize transport (connects to telnet)
    await transport.init();

    // Wait for CPU selection menu
    const menuOutput = await transport.waitFor('Choose a CPU', config.timeouts.reboot);

    // Parse menu into structured CPU list
    const cpus = parseCpuMenu(menuOutput);

    return cpus;
  } finally {
    // Always close the transport
    if (transport) {
      await transport.close();
    }
  }
}

// Input schema - defaults come from config
export const listCpusInputSchema = z.object({
  host: z.string().optional().default(config.kos.host).describe('kOS server host'),
  port: z.number().optional().default(config.kos.port).describe('kOS server port'),
  transportType: z.enum(['socket', 'tmux']).optional().describe(`Transport type (default: ${config.transport.type})`),
});

