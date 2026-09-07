import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CpuFreqInfo } from '../types.js';

/**
 * Linux CPU frequency scaling provider.
 *
 * Scans `/sys/devices/system/cpu/cpu*` to discover available processor cores and reads
 * their instantaneous clock frequencies from `cpufreq/scaling_cur_freq`.
 * Handles core parking and hotplugging by ignoring offline cores dynamically.
 */
export class CpuFreqProvider {
  private freqPaths: { coreIndex: number; filePath: string }[] = [];

  /**
   * Initializes the provider and performs initial core discovery.
   */
  constructor() {
    this.discoverCores();
  }

  /**
   * Scans sysfs to identify logical CPU directories and their frequency control endpoints.
   */
  private discoverCores(): void {
    const basePath = '/sys/devices/system/cpu';
    try {
      if (!fs.existsSync(basePath)) {
        return;
      }

      const entries = fs.readdirSync(basePath);
      const coreEntries: { coreIndex: number; filePath: string }[] = [];

      for (const entry of entries) {
        const match = /^cpu(\d+)$/.exec(entry);
        if (match && match[1]) {
          const coreIndex = parseInt(match[1], 10);
          const freqPath = path.join(basePath, entry, 'cpufreq', 'scaling_cur_freq');
          coreEntries.push({ coreIndex, filePath: freqPath });
        }
      }

      // Sort by core index ascending
      coreEntries.sort((a, b) => a.coreIndex - b.coreIndex);
      this.freqPaths = coreEntries;
    } catch {
      this.freqPaths = [];
    }
  }

  /**
   * Samples current clock frequencies across all active cores.
   *
   * @returns Average, maximum, and per-core clock frequencies in Hertz, or `null` if no cores could be sampled.
   */
  public sample(): CpuFreqInfo | null {
    if (this.freqPaths.length === 0) {
      this.discoverCores();
      if (this.freqPaths.length === 0) {
        return null;
      }
    }

    const perCoreHz: number[] = [];
    let sumHz = 0;
    let maxHz = 0;
    let activeCoreCount = 0;

    for (const { coreIndex, filePath } of this.freqPaths) {
      try {
        const raw = fs.readFileSync(filePath, 'utf8').trim();
        const khz = parseInt(raw, 10);

        if (!isNaN(khz) && khz > 0) {
          const hz = khz * 1000;
          perCoreHz[coreIndex] = hz;
          sumHz += hz;
          if (hz > maxHz) {
            maxHz = hz;
          }
          activeCoreCount++;
        }
      } catch {
        // Core might be offline, sleeping, or parked (ENOENT); ignore for this tick
      }
    }

    if (activeCoreCount === 0) {
      return null;
    }

    const avgHz = sumHz / activeCoreCount;

    return {
      avgHz,
      maxHz,
      perCoreHz,
    };
  }
}
