export type FreqUnit = 'GHz' | 'MHz' | 'KHz' | 'Hz';
export type MemUnit = 'GB' | 'MB' | 'KB' | 'B';
export type DiskSpaceFormat = 'PercentRemaining' | 'PercentUsed' | 'Remaining' | 'UsedOutOfTotal';

export interface CpuUsageInfo {
  overallPercent: number;
  perCorePercent: number[];
}

export interface CpuFreqInfo {
  avgHz: number;
  maxHz: number;
  perCoreHz: number[];
}

export interface CpuTempInfo {
  tempCelsius: number;
  sensorName: string;
  sensorLabel: string;
}

export interface MemoryInfo {
  totalBytes: number;
  availableBytes: number;
  usedBytes: number;
  usedPercent: number;
  swapTotalBytes: number;
  swapFreeBytes: number;
  swapUsedBytes: number;
  swapUsedPercent: number;
}

export interface DiskDriveInfo {
  mountPath: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
  freePercent: number;
}

export interface BatteryInfo {
  percent: number;
  status: string;
}
