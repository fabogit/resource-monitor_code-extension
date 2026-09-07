import * as fs from 'node:fs';
import type { CpuUsageInfo } from '../types.js';

interface CoreStat {
  total: number;
  idle: number;
}

export class CpuProvider {
  private prevOverall: CoreStat | null = null;
  private prevCores: Map<number, CoreStat> = new Map();
  private lastResult: CpuUsageInfo = { overallPercent: 0, perCorePercent: [] };

  public sample(): CpuUsageInfo | null {
    try {
      const content = fs.readFileSync('/proc/stat', 'utf8');
      const lines = content.split('\n');

      let overallPercent = this.lastResult.overallPercent;
      const perCorePercent: number[] = [];

      for (const line of lines) {
        if (!line.startsWith('cpu')) {
          continue;
        }

        const parts = line.trim().split(/\s+/);
        const name = parts[0];
        if (!name) {
          continue;
        }

        // Parts: [cpu, user, nice, system, idle, iowait, irq, softirq, steal]
        const user = Number(parts[1]) || 0;
        const nice = Number(parts[2]) || 0;
        const system = Number(parts[3]) || 0;
        const idle = Number(parts[4]) || 0;
        const iowait = Number(parts[5]) || 0;
        const irq = Number(parts[6]) || 0;
        const softirq = Number(parts[7]) || 0;
        const steal = Number(parts[8]) || 0;

        const total = user + nice + system + idle + iowait + irq + softirq + steal;
        const idleAll = idle + iowait;

        if (name === 'cpu') {
          if (this.prevOverall !== null) {
            const totalDelta = total - this.prevOverall.total;
            const idleDelta = idleAll - this.prevOverall.idle;

            if (totalDelta > 0) {
              const activeDelta = totalDelta - idleDelta;
              overallPercent = Math.max(0, Math.min(100, (activeDelta / totalDelta) * 100));
            }
          }
          this.prevOverall = { total, idle: idleAll };
        } else {
          // Individual core (cpu0, cpu1, ...)
          const coreIndex = parseInt(name.slice(3), 10);
          if (!isNaN(coreIndex)) {
            const prevCore = this.prevCores.get(coreIndex);
            let coreUsage = 0;

            if (prevCore) {
              const totalDelta = total - prevCore.total;
              const idleDelta = idleAll - prevCore.idle;

              if (totalDelta > 0) {
                const activeDelta = totalDelta - idleDelta;
                coreUsage = Math.max(0, Math.min(100, (activeDelta / totalDelta) * 100));
              }
            }

            perCorePercent[coreIndex] = coreUsage;
            this.prevCores.set(coreIndex, { total, idle: idleAll });
          }
        }
      }

      this.lastResult = { overallPercent, perCorePercent };
      return this.lastResult;
    } catch {
      return null;
    }
  }
}
