/**
 * Supported CPU frequency units for display.
 */
export type FreqUnit = 'GHz' | 'MHz' | 'KHz' | 'Hz';

/**
 * Supported memory units for display.
 */
export type MemUnit = 'GB' | 'MB' | 'KB' | 'B';

/**
 * Supported formatting styles for disk space reporting.
 */
export type DiskSpaceFormat = 'PercentRemaining' | 'PercentUsed' | 'Remaining' | 'UsedOutOfTotal';

/**
 * Represents CPU usage percentage statistics across the entire processor and individual cores.
 */
export interface CpuUsageInfo {
  /**
   * Aggregate CPU load across all active cores, ranging from 0.0 to 100.0.
   */
  overallPercent: number;

  /**
   * Per-core utilization percentages indexed by logical core ID (e.g. core 0 at index 0).
   */
  perCorePercent: number[];
}

/**
 * Represents CPU clock frequency measurements in Hertz.
 */
export interface CpuFreqInfo {
  /**
   * Mean frequency across all active online cores in Hz.
   */
  avgHz: number;

  /**
   * Highest clock frequency recorded among active cores in Hz.
   */
  maxHz: number;

  /**
   * Individual frequency measurements for each core indexed by logical core ID.
   */
  perCoreHz: number[];
}

/**
 * Represents CPU temperature measurements and hardware sensor identification.
 */
export interface CpuTempInfo {
  /**
   * Temperature reading in degrees Celsius (°C).
   */
  tempCelsius: number;

  /**
   * Kernel driver or subsystem name (e.g. 'k10temp', 'coretemp', 'acpi').
   */
  sensorName: string;

  /**
   * Label descriptor associated with the reading (e.g. 'Tctl', 'Tccd1', 'Package id 0').
   */
  sensorLabel: string;
}

/**
 * Represents system physical memory (RAM) and swap space metrics in bytes.
 */
export interface MemoryInfo {
  /**
   * Total physical RAM installed in bytes.
   */
  totalBytes: number;

  /**
   * Estimated memory available for starting new applications without swapping, in bytes.
   */
  availableBytes: number;

  /**
   * Memory actively used by applications and kernel allocations in bytes.
   */
  usedBytes: number;

  /**
   * Memory utilization percentage relative to totalBytes, ranging from 0.0 to 100.0.
   */
  usedPercent: number;

  /**
   * Total swap partition/file capacity in bytes.
   */
  swapTotalBytes: number;

  /**
   * Unused swap space in bytes.
   */
  swapFreeBytes: number;

  /**
   * Actively consumed swap space in bytes.
   */
  swapUsedBytes: number;

  /**
   * Swap utilization percentage relative to swapTotalBytes, ranging from 0.0 to 100.0.
   */
  swapUsedPercent: number;
}

/**
 * Represents storage capacity and utilization metrics for a mounted filesystem.
 */
export interface DiskDriveInfo {
  /**
   * Filesystem mount point path (e.g. '/', '/home').
   */
  mountPath: string;

  /**
   * Total storage capacity in bytes.
   */
  totalBytes: number;

  /**
   * Storage space available to unprivileged processes in bytes.
   */
  freeBytes: number;

  /**
   * Storage space currently occupied in bytes.
   */
  usedBytes: number;

  /**
   * Percentage of storage space used, ranging from 0.0 to 100.0.
   */
  usedPercent: number;

  /**
   * Percentage of storage space free, ranging from 0.0 to 100.0.
   */
  freePercent: number;
}

/**
 * Represents battery charge state and status information.
 */
export interface BatteryInfo {
  /**
   * Remaining charge level expressed as an integer percentage from 0 to 100.
   */
  percent: number;

  /**
   * Power supply state reported by kernel (e.g. 'Charging', 'Discharging', 'Full').
   */
  status: string;
}
