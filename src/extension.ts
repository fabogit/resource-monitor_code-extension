import * as vscode from 'vscode';
import { getConfig, UNIT_DIVISORS } from './config.js';
import { BatteryProvider } from './providers/battery.js';
import { CpuProvider } from './providers/cpu.js';
import { CpuFreqProvider } from './providers/cpufreq.js';
import { CpuTempProvider } from './providers/cputemp.js';
import { DiskProvider } from './providers/disk.js';
import { MemoryProvider } from './providers/memory.js';

let updateTimer: NodeJS.Timeout | null = null;
let isUpdating = false;

function formatBytes(bytes: number, precision = 2): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let val = bytes;
  let unitIndex = 0;

  while (val >= 1024 && unitIndex < units.length - 1) {
    val /= 1024;
    unitIndex++;
  }

  return `${val.toFixed(precision)} ${units[unitIndex]}`;
}

export function activate(context: vscode.ExtensionContext): void {
  console.log('[Resource Monitor NG] Activated successfully');

  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  statusBarItem.command = 'resmon.refresh';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  const cpuProvider = new CpuProvider();
  const cpuFreqProvider = new CpuFreqProvider();
  const cpuTempProvider = new CpuTempProvider();
  const memoryProvider = new MemoryProvider();
  const diskProvider = new DiskProvider();
  const batteryProvider = new BatteryProvider();

  async function update(): Promise<void> {
    if (isUpdating) {
      return;
    }
    isUpdating = true;

    try {
      const config = getConfig();
      const statusParts: string[] = [];
      const tooltipLines: string[] = ['### Resource Monitor NG', ''];

      // 1. CPU Usage
      const cpuUsage = cpuProvider.sample();
      if (cpuUsage && config.showCpuUsage) {
        statusParts.push(`$(pulse) ${cpuUsage.overallPercent.toFixed(2)}%`);
      }

      // 2. CPU Frequency
      const cpuFreq = cpuFreqProvider.sample();
      if (cpuFreq && config.showCpuFreq) {
        const divisor = UNIT_DIVISORS[config.freqUnit] || UNIT_DIVISORS['GHz']!;
        const formattedFreq = `${(cpuFreq.avgHz / divisor).toFixed(2)} ${config.freqUnit}`;
        statusParts.push(`$(dashboard) ${formattedFreq}`);
      }

      // 3. CPU Temperature
      const cpuTemp = cpuTempProvider.sample();
      if (cpuTemp && config.showCpuTemp) {
        statusParts.push(`$(flame) ${cpuTemp.tempCelsius.toFixed(2)} C`);
      }

      // 4. Memory
      const mem = memoryProvider.sample();
      if (mem && config.showMem) {
        const divisor = UNIT_DIVISORS[config.memUnit] || UNIT_DIVISORS['GB']!;
        const used = (mem.usedBytes / divisor).toFixed(2);
        const total = (mem.totalBytes / divisor).toFixed(2);
        statusParts.push(`$(ellipsis) ${used}/${total} ${config.memUnit}`);
      }

      // 5. Battery (only if present)
      if (batteryProvider.isAvailable && config.showBattery) {
        const battery = batteryProvider.sample();
        if (battery) {
          statusParts.push(`$(plug) ${battery.percent}%`);
        }
      }

      // 6. Disk Space
      if (config.showDisk) {
        const disks = await diskProvider.sample(config.diskDrives);
        if (disks.length > 0) {
          const diskTexts = disks.map((d) => {
            switch (config.diskFormat) {
              case 'PercentRemaining':
                return `${d.mountPath} ${d.freePercent.toFixed(2)}% remaining`;
              case 'PercentUsed':
                return `${d.mountPath} ${d.usedPercent.toFixed(2)}% used`;
              case 'Remaining':
                return `${d.mountPath} ${formatBytes(d.freeBytes)} remaining`;
              case 'UsedOutOfTotal':
                return `${d.mountPath} ${formatBytes(d.usedBytes)}/${formatBytes(d.totalBytes)} used`;
            }
          });
          statusParts.push(`$(database) ${diskTexts.join(', ')}`);
        }
      }

      // Update status bar item text with 4-space delimiter
      statusBarItem.text = statusParts.join('    ');

      // Build Tooltip Markdown Breakdown
      if (cpuUsage) {
        tooltipLines.push(`**CPU Load**: ${cpuUsage.overallPercent.toFixed(2)}%`);
        if (cpuFreq) {
          const divisor = UNIT_DIVISORS[config.freqUnit] || UNIT_DIVISORS['GHz']!;
          tooltipLines.push(
            `**CPU Clock**: ${(cpuFreq.avgHz / divisor).toFixed(2)} ${config.freqUnit} (Max: ${(cpuFreq.maxHz / divisor).toFixed(2)} ${config.freqUnit})`
          );
        }
        if (cpuUsage.perCorePercent.length > 0) {
          const coreDetails = cpuUsage.perCorePercent
            .map((pct, idx) => {
              const freq = cpuFreq?.perCoreHz[idx];
              const freqStr = freq ? ` @ ${(freq / 1_000_000_000).toFixed(2)} GHz` : '';
              return `Core ${idx}: ${pct.toFixed(1)}%${freqStr}`;
            })
            .join(' | ');
          tooltipLines.push(`*Cores*: ${coreDetails}`);
        }
        tooltipLines.push('');
      }

      if (cpuTemp) {
        tooltipLines.push(`**Temperature**: ${cpuTemp.tempCelsius.toFixed(2)} °C (*${cpuTemp.sensorName} [${cpuTemp.sensorLabel}]*)`, '');
      }

      if (mem) {
        tooltipLines.push(
          `**Memory**: ${formatBytes(mem.usedBytes)} / ${formatBytes(mem.totalBytes)} (${mem.usedPercent.toFixed(1)}%)`,
          `**Swap**: ${formatBytes(mem.swapUsedBytes)} / ${formatBytes(mem.swapTotalBytes)} (${mem.swapUsedPercent.toFixed(1)}%)`,
          ''
        );
      }

      if (batteryProvider.isAvailable) {
        const battery = batteryProvider.sample();
        if (battery) {
          tooltipLines.push(`**Battery**: ${battery.percent}% (${battery.status})`, '');
        }
      }

      const disks = await diskProvider.sample(config.diskDrives);
      if (disks.length > 0) {
        tooltipLines.push('**Disks**:');
        for (const d of disks) {
          tooltipLines.push(
            `- \`${d.mountPath}\`: ${formatBytes(d.usedBytes)} used of ${formatBytes(d.totalBytes)} (${d.freePercent.toFixed(1)}% free)`
          );
        }
        tooltipLines.push('');
      }

      tooltipLines.push('---', '*Click to refresh stats*');

      const markdown = new vscode.MarkdownString(tooltipLines.join('\n'));
      markdown.isTrusted = true;
      statusBarItem.tooltip = markdown;
    } catch {
      // Keep previous display on transient sampling error
    } finally {
      isUpdating = false;
    }
  }

  function scheduleNext(): void {
    const config = getConfig();
    if (updateTimer) {
      clearTimeout(updateTimer);
    }
    updateTimer = setTimeout(async () => {
      await update();
      scheduleNext();
    }, config.updateFrequencyMs);
    updateTimer.unref();
  }

  // Register command
  context.subscriptions.push(
    vscode.commands.registerCommand('resmon.refresh', async () => {
      await update();
    })
  );

  // Configuration change listener
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('resmon')) {
        void update();
        scheduleNext();
      }
    })
  );

  // Initial update and start scheduling
  void update();
  scheduleNext();
}

export function deactivate(): void {
  if (updateTimer) {
    clearTimeout(updateTimer);
    updateTimer = null;
  }
}
