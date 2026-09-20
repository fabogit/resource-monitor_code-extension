import * as os from 'node:os';
import type {
  BatteryInfo,
  CpuTempInfo,
  CpuUsageInfo,
  FreqOrLoadInfo,
  MemoryInfo,
} from '../../types.js';
import type { TelemetryPlatformProvider } from '../interface.js';
import { loadDarwinNativeAddon, type DarwinNativeAddon } from './native_loader.js';

interface CoreTicks {
  user: number;
  system: number;
  idle: number;
  nice: number;
}

/**
 * macOS Apple Silicon (M-Series) telemetry provider.
 *
 * Utilizes the native C++ N-API addon (Mach, sysctl, IOKit, IOHID) for zero-subprocess
 * hardware sampling, with graceful fallback to standard Node.js runtime APIs.
 */
export class DarwinTelemetryProvider implements TelemetryPlatformProvider {
  public readonly platformName = 'darwin' as const;

  private nativeAddon: DarwinNativeAddon | null;
  private prevTicks: CoreTicks[] | null = null;
  private lastCpuResult: CpuUsageInfo = { overallPercent: 0, perCorePercent: [] };
  private topology: { model: string; totalCores: number; pCores: number; eCores: number };

  constructor() {
    this.nativeAddon = loadDarwinNativeAddon();
    if (this.nativeAddon) {
      this.topology = this.nativeAddon.getCpuTopology();
      this.prevTicks = this.nativeAddon.getCpuTicks();
      const coreTypes: ('P' | 'E')[] = [];
      const perCorePercent: number[] = [];
      for (let i = 0; i < this.topology.totalCores; i++) {
        perCorePercent.push(0);
        if (this.topology.eCores > 0 && i < this.topology.eCores) {
          coreTypes.push('E');
        } else if (this.topology.pCores > 0) {
          coreTypes.push('P');
        }
      }
      this.lastCpuResult = {
        overallPercent: 0,
        perCorePercent,
        coreTypes: coreTypes.length > 0 ? coreTypes : undefined,
      };
    } else {
      const cpus = os.cpus();
      this.topology = {
        model: cpus[0]?.model || 'Apple Silicon',
        totalCores: cpus.length,
        pCores: 0,
        eCores: 0,
      };
      this.prevTicks = cpus.map((c) => ({
        user: c.times.user,
        system: c.times.sys,
        idle: c.times.idle,
        nice: c.times.nice,
      }));
      this.lastCpuResult = {
        overallPercent: 0,
        perCorePercent: new Array(this.topology.totalCores).fill(0),
      };
    }
  }

  /**
   * Generates a descriptive string of the hardware chip and core topology.
   *
   * @returns Formatted topology string (e.g. 'Apple M4 (4P + 6E)').
   */
  public getTopologyDescription(): string {
    if (this.topology.pCores > 0 || this.topology.eCores > 0) {
      return `${this.topology.model} (${this.topology.pCores}P + ${this.topology.eCores}E)`;
    }
    return `${this.topology.model} (${this.topology.totalCores} cores)`;
  }

  /**
   * Samples active CPU utilization across all cores using Mach processor tick counters.
   *
   * @returns Comprehensive CPU load and per-core breakdown, or `null` if sampling fails.
   */
  public sampleCpu(): CpuUsageInfo | null {
    if (this.nativeAddon) {
      const currentTicks = this.nativeAddon.getCpuTicks();
      if (!currentTicks || currentTicks.length === 0) {
        return this.sampleCpuFallback();
      }

      if (!this.prevTicks || this.prevTicks.length !== currentTicks.length) {
        this.prevTicks = currentTicks;
        return this.lastCpuResult;
      }

      let totalActiveDelta = 0;
      let totalAllDelta = 0;
      const perCorePercent: number[] = [];
      const coreTypes: ('P' | 'E')[] = [];

      for (let i = 0; i < currentTicks.length; i++) {
        const cur = currentTicks[i]!;
        const prev = this.prevTicks[i]!;

        const uDelta = Math.max(0, cur.user - prev.user);
        const sDelta = Math.max(0, cur.system - prev.system);
        const nDelta = Math.max(0, cur.nice - prev.nice);
        const iDelta = Math.max(0, cur.idle - prev.idle);

        const activeDelta = uDelta + sDelta + nDelta;
        const coreTotalDelta = activeDelta + iDelta;

        totalActiveDelta += activeDelta;
        totalAllDelta += coreTotalDelta;

        const coreUsage = coreTotalDelta > 0
          ? Math.max(0, Math.min(100, (activeDelta / coreTotalDelta) * 100))
          : 0;

        perCorePercent.push(coreUsage);

        // Map core architecture: on Apple Silicon, E-cores are indexed first (0..eCores-1), followed by P-cores
        if (this.topology.eCores > 0 && i < this.topology.eCores) {
          coreTypes.push('E');
        } else if (this.topology.pCores > 0) {
          coreTypes.push('P');
        }
      }

      this.prevTicks = currentTicks;

      // Handle wake-from-sleep or clock skew
      let overallPercent = this.lastCpuResult.overallPercent;
      if (totalAllDelta > 0) {
        overallPercent = Math.max(0, Math.min(100, (totalActiveDelta / totalAllDelta) * 100));
      }

      this.lastCpuResult = {
        overallPercent,
        perCorePercent,
        coreTypes: coreTypes.length > 0 ? coreTypes : undefined,
      };

      return this.lastCpuResult;
    }

    return this.sampleCpuFallback();
  }

  /**
   * Fallback CPU utilization sampling using Node.js os.cpus() when native addon is unavailable.
   *
   * @returns CPU utilization metrics calculated from os.cpus() tick deltas, or `null` if unreadable.
   */
  private sampleCpuFallback(): CpuUsageInfo | null {
    const cpus = os.cpus();
    if (!cpus || cpus.length === 0) {
      return null;
    }

    const currentTicks: CoreTicks[] = cpus.map((c) => ({
      user: c.times.user,
      system: c.times.sys,
      idle: c.times.idle,
      nice: c.times.nice,
    }));

    if (!this.prevTicks || this.prevTicks.length !== currentTicks.length) {
      this.prevTicks = currentTicks;
      return this.lastCpuResult;
    }

    let totalActiveDelta = 0;
    let totalAllDelta = 0;
    const perCorePercent: number[] = [];

    for (let i = 0; i < currentTicks.length; i++) {
      const cur = currentTicks[i]!;
      const prev = this.prevTicks[i]!;

      const activeDelta = Math.max(0, (cur.user - prev.user) + (cur.system - prev.system) + (cur.nice - prev.nice));
      const idleDelta = Math.max(0, cur.idle - prev.idle);
      const coreTotal = activeDelta + idleDelta;

      totalActiveDelta += activeDelta;
      totalAllDelta += coreTotal;

      const coreUsage = coreTotal > 0 ? Math.max(0, Math.min(100, (activeDelta / coreTotal) * 100)) : 0;
      perCorePercent.push(coreUsage);
    }

    this.prevTicks = currentTicks;

    let overallPercent = this.lastCpuResult.overallPercent;
    if (totalAllDelta > 0) {
      overallPercent = Math.max(0, Math.min(100, (totalActiveDelta / totalAllDelta) * 100));
    }

    this.lastCpuResult = {
      overallPercent,
      perCorePercent,
    };

    return this.lastCpuResult;
  }

  /**
   * Samples the System Load Average (1m, 5m, 15m) alongside Apple Silicon hardware core topology.
   *
   * On Apple Silicon, hardware frequency scaling is autonomous and restricted to root;
   * this method provides normalized workload capacity across available CPU cores.
   *
   * @returns System load average statistics and core topology metadata.
   */
  public sampleFreqOrLoad(): FreqOrLoadInfo | null {
    const loads = os.loadavg();
    return {
      kind: 'load',
      data: {
        load1: loads[0] ?? 0,
        load5: loads[1] ?? 0,
        load15: loads[2] ?? 0,
        modelName: this.topology.model,
        totalCores: this.topology.totalCores,
        pCores: this.topology.pCores,
        eCores: this.topology.eCores,
      },
    };
  }

  /**
   * Samples Apple Silicon SoC die, NAND flash, and battery temperatures via IOHIDEventSystemClient.
   *
   * @returns Synthesized thermal metrics in degrees Celsius, or `null` if unprivileged HID is unavailable.
   */
  public sampleTemp(): CpuTempInfo | null {
    if (this.nativeAddon) {
      return this.nativeAddon.getDieTemperature();
    }
    return null;
  }

  /**
   * Samples 64-bit Mach VM memory metrics (wired, active, compressed pages) and vm.swapusage.
   *
   * @returns Comprehensive RAM and swap utilization statistics, or `null` if query fails.
   */
  public sampleMemory(): MemoryInfo | null {
    if (this.nativeAddon) {
      const stats = this.nativeAddon.getMemoryStats();
      if (stats && stats.totalBytes > 0) {
        const usedPercent = (stats.usedBytes / stats.totalBytes) * 100;
        const swapUsedPercent = stats.swapTotalBytes > 0
          ? (stats.swapUsedBytes / stats.swapTotalBytes) * 100
          : 0;

        return {
          totalBytes: stats.totalBytes,
          availableBytes: stats.availableBytes,
          usedBytes: stats.usedBytes,
          usedPercent,
          swapTotalBytes: stats.swapTotalBytes,
          swapFreeBytes: stats.swapFreeBytes,
          swapUsedBytes: stats.swapUsedBytes,
          swapUsedPercent,
          activeBytes: stats.activeBytes,
          wiredBytes: stats.wiredBytes,
          compressedBytes: stats.compressedBytes,
          inactiveBytes: stats.inactiveBytes,
          pressurePercent: stats.pressurePercent,
        };
      }
    }

    // Fallback using os module
    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const usedPercent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;

    return {
      totalBytes,
      availableBytes: freeBytes,
      usedBytes,
      usedPercent,
      swapTotalBytes: 0,
      swapFreeBytes: 0,
      swapUsedBytes: 0,
      swapUsedPercent: 0,
    };
  }

  /**
   * Samples battery state, residual charge in mAh, nominal design capacity, cycles, and calibrated health.
   *
   * @returns BatteryInfo telemetry object, or `null` if running on a desktop Mac without a battery.
   */
  public sampleBattery(): BatteryInfo | null {
    if (this.nativeAddon) {
      const batt = this.nativeAddon.getBatteryStats();
      if (batt.isAvailable) {
        return {
          percent: batt.percent,
          status: batt.status,
          timeRemainingMinutes: batt.timeRemainingMinutes,
          isCharging: batt.isCharging,
          currentCapacity: batt.currentCapacity,
          maxCapacity: batt.maxCapacity,
          designCapacity: batt.designCapacity,
          healthPercent: batt.healthPercent,
          cycleCount: batt.cycleCount,
          capacityUnit: batt.capacityUnit,
        };
      }
    }
    return null;
  }

  /**
   * Checks whether battery hardware is present and reporting to the IOKit registry.
   *
   * @returns `true` if battery is detected, `false` on desktop Macs (Mac mini, Mac Studio, Mac Pro).
   */
  public isBatteryAvailable(): boolean {
    if (this.nativeAddon) {
      return this.nativeAddon.getBatteryStats().isAvailable;
    }
    return false;
  }
}
