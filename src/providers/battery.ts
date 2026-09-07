import * as fs from 'node:fs';
import * as path from 'node:path';
import type { BatteryInfo } from '../types.js';

interface BatteryPath {
  capacityPath: string;
  statusPath: string;
}

export class BatteryProvider {
  private batteries: BatteryPath[] = [];
  public isAvailable = false;
  private discoveryAttempted = false;

  constructor() {
    this.discoverBatteries();
  }

  private discoverBatteries(): void {
    this.discoveryAttempted = true;
    const basePath = '/sys/class/power_supply';

    try {
      if (!fs.existsSync(basePath)) {
        this.isAvailable = false;
        return;
      }

      const entries = fs.readdirSync(basePath);
      const found: BatteryPath[] = [];

      for (const entry of entries) {
        if (/^BAT\d*$/i.test(entry)) {
          const batDir = path.join(basePath, entry);
          const capacityPath = path.join(batDir, 'capacity');
          const statusPath = path.join(batDir, 'status');

          if (fs.existsSync(capacityPath)) {
            found.push({ capacityPath, statusPath });
          }
        }
      }

      this.batteries = found;
      this.isAvailable = found.length > 0;
    } catch {
      this.isAvailable = false;
    }
  }

  public sample(): BatteryInfo | null {
    if (!this.discoveryAttempted) {
      this.discoverBatteries();
    }

    if (!this.isAvailable || this.batteries.length === 0) {
      return null;
    }

    try {
      let totalPercent = 0;
      let count = 0;
      let combinedStatus = 'Discharging';

      for (const bat of this.batteries) {
        try {
          const rawCap = fs.readFileSync(bat.capacityPath, 'utf8').trim();
          const cap = parseInt(rawCap, 10);
          if (!isNaN(cap)) {
            totalPercent += cap;
            count++;
          }

          if (fs.existsSync(bat.statusPath)) {
            const rawStatus = fs.readFileSync(bat.statusPath, 'utf8').trim();
            if (rawStatus === 'Charging') {
              combinedStatus = 'Charging';
            } else if (rawStatus === 'Full' && combinedStatus !== 'Charging') {
              combinedStatus = 'Full';
            }
          }
        } catch {
          // Skip unreadable battery
        }
      }

      if (count === 0) {
        return null;
      }

      const percent = Math.min(100, Math.max(0, Math.round(totalPercent / count)));
      return {
        percent,
        status: combinedStatus,
      };
    } catch {
      return null;
    }
  }
}
