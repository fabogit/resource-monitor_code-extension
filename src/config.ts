import * as vscode from 'vscode';
import type { DiskSpaceFormat, FreqUnit, MemUnit } from './types.js';

export interface ResMonConfig {
  showCpuUsage: boolean;
  showCpuFreq: boolean;
  showCpuTemp: boolean;
  showMem: boolean;
  showBattery: boolean;
  showDisk: boolean;
  diskFormat: DiskSpaceFormat;
  diskDrives: string[];
  updateFrequencyMs: number;
  freqUnit: FreqUnit;
  memUnit: MemUnit;
}

export function getConfig(): ResMonConfig {
  const config = vscode.workspace.getConfiguration('resmon');

  return {
    showCpuUsage: config.get<boolean>('show.cpuusage', true),
    showCpuFreq: config.get<boolean>('show.cpufreq', true),
    showCpuTemp: config.get<boolean>('show.cputemp', true),
    showMem: config.get<boolean>('show.mem', true),
    showBattery: config.get<boolean>('show.battery', true),
    showDisk: config.get<boolean>('show.disk', false),
    diskFormat: config.get<DiskSpaceFormat>('disk.format', 'PercentRemaining'),
    diskDrives: config.get<string[]>('disk.drives', []),
    updateFrequencyMs: Math.max(200, config.get<number>('updatefrequencyms', 2000)),
    freqUnit: config.get<FreqUnit>('freq.unit', 'GHz'),
    memUnit: config.get<MemUnit>('mem.unit', 'GB'),
  };
}

export const UNIT_DIVISORS: Record<string, number> = {
  GHz: 1_000_000_000,
  MHz: 1_000_000,
  KHz: 1_000,
  Hz: 1,
  GB: 1024 * 1024 * 1024,
  MB: 1024 * 1024,
  KB: 1024,
  B: 1,
};
