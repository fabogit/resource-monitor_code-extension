import * as vscode from 'vscode';
import { getConfig, UNIT_DIVISORS } from './config.js';
import { BatteryProvider } from './providers/battery.js';
import { CpuProvider } from './providers/cpu.js';
import { CpuFreqProvider } from './providers/cpufreq.js';
import { CpuTempProvider } from './providers/cputemp.js';
import { DiskProvider } from './providers/disk.js';
import { MemoryProvider } from './providers/memory.js';
import type { BatteryInfo, DiskDriveInfo } from './types.js';

let updateTimer: NodeJS.Timeout | null = null;
let isUpdating = false;
let tickCounter = 0;
let cachedBattery: BatteryInfo | null = null;
let cachedDisks: DiskDriveInfo[] = [];

interface StatusBarWidgets {
  cpu: vscode.StatusBarItem;
  freq: vscode.StatusBarItem;
  temp: vscode.StatusBarItem;
  mem: vscode.StatusBarItem;
  battery: vscode.StatusBarItem;
  disk: vscode.StatusBarItem;
}

let widgets: StatusBarWidgets | null = null;
const visibleSet = new WeakSet<vscode.StatusBarItem>();

/**
 * Formats a raw byte count into a human-readable string with dynamic unit scaling (B, KB, MB, GB, TB).
 *
 * @param bytes - The size in bytes to format.
 * @param precision - Number of decimal places to include (default: 2).
 * @returns Formatted size string (e.g. '16.42 GB').
 */
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

/**
 * Pads a numeric string with Unicode Figure Spaces (U+2007) so it maintains fixed tabular width
 * in proportional UI fonts without collapsing or jittering when numbers shift between digits.
 *
 * @param str - The formatted number string (e.g. '8.45').
 * @param targetLength - Desired character count for the numeric part.
 * @returns String padded with figure spaces on the left.
 */
function padNum(str: string, targetLength: number): string {
  return str.padStart(targetLength, '\u2007');
}

/**
 * Updates a StatusBarItem's text, tooltip, and visibility idempotently.
 *
 * Utilizes content diffing to avoid redundant DOM mutations and prevents destroying
 * active HoverWidget popups in VS Code's Chromium UI thread.
 *
 * @param item - Target status bar item.
 * @param text - Display text including Codicons and fixed-width numbers.
 * @param tooltipMd - Markdown-formatted string for the hover tooltip, or null to leave current tooltip unchanged.
 * @param shouldShow - Whether the item should be rendered in the status bar.
 */
function updateWidget(
  item: vscode.StatusBarItem,
  text: string,
  tooltipMd: string | null,
  shouldShow: boolean
): void {
  if (!shouldShow) {
    if (visibleSet.has(item)) {
      item.hide();
      visibleSet.delete(item);
    }
    return;
  }

  if (item.text !== text) {
    item.text = text;
  }

  if (tooltipMd !== null) {
    const currentMd =
      item.tooltip instanceof vscode.MarkdownString
        ? item.tooltip.value
        : typeof item.tooltip === 'string'
        ? item.tooltip
        : '';

    if (currentMd !== tooltipMd) {
      const md = new vscode.MarkdownString(tooltipMd);
      md.isTrusted = true;
      item.tooltip = md;
    }
  }

  if (!visibleSet.has(item)) {
    item.show();
    visibleSet.add(item);
  }
}

/**
 * Generates the common Markdown footer for tooltips, reflecting the active display mode
 * and providing an interactive command link to toggle between Static and Live modes.
 *
 * @param mode - The currently active tooltip mode ('Static' | 'Live').
 * @returns Array of markdown lines for the tooltip footer.
 */
function getTooltipFooter(mode: 'Static' | 'Live'): string[] {
  const nextMode = mode === 'Static' ? 'Live' : 'Static';
  return [
    '---',
    `**Tooltip Mode**: \`${mode}\` ([Switch to ${nextMode}](command:resmon.toggleTooltipMode))`,
    mode === 'Static' ? '*Click widget to refresh details*' : '*Auto-refreshing in real time*',
  ];
}

/**
 * Creates individual StatusBarItem widgets with sequential priorities.
 *
 * @param context - Extension context for subscriptions.
 * @param alignment - Status bar alignment side (Left or Right).
 * @param basePriority - Base priority number for positioning.
 * @returns Object holding all 6 StatusBarItem instances.
 */
function createWidgets(
  context: vscode.ExtensionContext,
  alignment: 'Left' | 'Right',
  basePriority: number
): StatusBarWidgets {
  const align = alignment === 'Right' ? vscode.StatusBarAlignment.Right : vscode.StatusBarAlignment.Left;
  // In Left alignment, higher priority sits further to the left.
  // In Right alignment, higher priority sits further to the right.
  const isLeft = alignment === 'Left';

  const w: StatusBarWidgets = {
    cpu: vscode.window.createStatusBarItem(align, isLeft ? basePriority : basePriority + 5),
    freq: vscode.window.createStatusBarItem(align, isLeft ? basePriority - 1 : basePriority + 4),
    temp: vscode.window.createStatusBarItem(align, isLeft ? basePriority - 2 : basePriority + 3),
    mem: vscode.window.createStatusBarItem(align, isLeft ? basePriority - 3 : basePriority + 2),
    battery: vscode.window.createStatusBarItem(align, isLeft ? basePriority - 4 : basePriority + 1),
    disk: vscode.window.createStatusBarItem(align, isLeft ? basePriority - 5 : basePriority),
  };

  for (const item of Object.values(w)) {
    item.command = 'resmon.refresh';
    context.subscriptions.push(item);
  }

  return w;
}

/**
 * Extension entry point invoked by VS Code when the extension is activated.
 *
 * Initializes independent Status Bar widgets for each resource component with focused tooltips,
 * registers commands and configuration listeners, and starts the polling loop.
 *
 * @param context - Extension runtime context provided by VS Code.
 */
export function activate(context: vscode.ExtensionContext): void {
  console.log('[Resource Monitor NG] Activated successfully');

  let currentConfig = getConfig();
  widgets = createWidgets(context, currentConfig.alignment, currentConfig.priority);

  const cpuProvider = new CpuProvider();
  const cpuFreqProvider = new CpuFreqProvider();
  const cpuTempProvider = new CpuTempProvider();
  const memoryProvider = new MemoryProvider();
  const diskProvider = new DiskProvider();
  const batteryProvider = new BatteryProvider();

  /**
   * Executes a polling tick across active resource providers and updates individual widgets.
   *
   * Fast in-memory telemetry (CPU, Freq, Temp, RAM) is polled on every tick.
   * Slow or I/O-intensive telemetry (Battery, Disk) is decimated if updateFrequencyMs < 1000.
   * Tooltip Markdown content is refreshed on every tick in 'Live' mode, or on-demand when forceAll is true in 'Static' mode.
   *
   * @param forceAll - When true, bypasses tick decimation and forces all providers and tooltips to refresh.
   */
  async function update(forceAll = false): Promise<void> {
    if (isUpdating || !widgets) {
      return;
    }
    isUpdating = true;

    try {
      const config = getConfig();
      const updateTooltips = forceAll || config.tooltipMode === 'Live';

      // Multi-rate polling decimation for slow-moving metrics (Battery and Disk)
      const decimationRatio = Math.max(1, Math.ceil(1000 / config.updateFrequencyMs));
      const shouldSampleSlow = forceAll || (tickCounter % decimationRatio === 0);
      tickCounter = (tickCounter + 1) % 1_000_000;

      // 1. CPU Usage
      const cpuUsage = cpuProvider.sample();
      const cpuFreq = cpuFreqProvider.sample();

      if (cpuUsage && config.showCpuUsage) {
        const cpuStr = padNum(cpuUsage.overallPercent.toFixed(2), 5);
        let cpuMd: string | null = null;
        if (updateTooltips) {
          const lines = [
            '### CPU Utilization',
            `**Overall Load**: ${cpuUsage.overallPercent.toFixed(2)}%`,
          ];
          if (cpuUsage.perCorePercent.length > 0) {
            lines.push('---', '*Per-Core Utilization:*');
            const coreLines = cpuUsage.perCorePercent.map((pct, idx) => {
              const freq = cpuFreq?.perCoreHz[idx];
              const freqStr = freq ? ` @ ${(freq / 1_000_000_000).toFixed(2)} GHz` : '';
              return `- **Core ${idx}**: ${pct.toFixed(1)}%${freqStr}`;
            });
            lines.push(...coreLines);
          }
          lines.push(...getTooltipFooter(config.tooltipMode));
          cpuMd = lines.join('\n');
        }
        updateWidget(widgets.cpu, `$(pulse) ${cpuStr}%`, cpuMd, true);
      } else {
        updateWidget(widgets.cpu, '', '', false);
      }

      // 2. CPU Frequency
      if (cpuFreq && config.showCpuFreq) {
        const divisor = UNIT_DIVISORS[config.freqUnit] || UNIT_DIVISORS['GHz']!;
        const freqStr = padNum((cpuFreq.avgHz / divisor).toFixed(2), config.freqUnit === 'MHz' ? 7 : 4);
        let freqMd: string | null = null;
        if (updateTooltips) {
          const lines = [
            '### CPU Clock Frequency',
            `**Average Clock**: ${(cpuFreq.avgHz / divisor).toFixed(2)} ${config.freqUnit}`,
            `**Peak Clock**: ${(cpuFreq.maxHz / divisor).toFixed(2)} ${config.freqUnit}`,
          ];
          if (cpuFreq.perCoreHz.length > 0) {
            lines.push('---', '*Core Clock Speeds:*');
            const coreFreqs = cpuFreq.perCoreHz.map((hz, idx) => {
              return `- **Core ${idx}**: ${(hz / divisor).toFixed(2)} ${config.freqUnit}`;
            });
            lines.push(...coreFreqs);
          }
          lines.push(...getTooltipFooter(config.tooltipMode));
          freqMd = lines.join('\n');
        }
        updateWidget(widgets.freq, `$(dashboard) ${freqStr} ${config.freqUnit}`, freqMd, true);
      } else {
        updateWidget(widgets.freq, '', '', false);
      }

      // 3. CPU Temperature
      const cpuTemp = cpuTempProvider.sample();
      if (cpuTemp && config.showCpuTemp) {
        const tempStr = padNum(cpuTemp.tempCelsius.toFixed(2), 5);
        let tempMd: string | null = null;
        if (updateTooltips) {
          tempMd = [
            '### CPU Temperature',
            `**Temperature**: ${cpuTemp.tempCelsius.toFixed(2)} °C`,
            `**Hardware Driver**: \`${cpuTemp.sensorName}\``,
            `**Sensor Label**: \`${cpuTemp.sensorLabel}\``,
            ...getTooltipFooter(config.tooltipMode),
          ].join('\n');
        }
        updateWidget(widgets.temp, `$(flame) ${tempStr} C`, tempMd, true);
      } else {
        updateWidget(widgets.temp, '', '', false);
      }

      // 4. Memory
      const mem = memoryProvider.sample();
      if (mem && config.showMem) {
        const divisor = UNIT_DIVISORS[config.memUnit] || UNIT_DIVISORS['GB']!;
        const usedStr = padNum((mem.usedBytes / divisor).toFixed(2), 5);
        const totalStr = padNum((mem.totalBytes / divisor).toFixed(2), 5);
        let memMd: string | null = null;
        if (updateTooltips) {
          memMd = [
            '### Memory & Swap',
            `**Physical RAM**: ${formatBytes(mem.usedBytes)} / ${formatBytes(mem.totalBytes)} (${mem.usedPercent.toFixed(1)}% used)`,
            `**Available Memory**: ${formatBytes(mem.availableBytes)}`,
            '',
            `**Swap Space**: ${formatBytes(mem.swapUsedBytes)} / ${formatBytes(mem.swapTotalBytes)} (${mem.swapUsedPercent.toFixed(1)}% used)`,
            `**Free Swap**: ${formatBytes(mem.swapFreeBytes)}`,
            ...getTooltipFooter(config.tooltipMode),
          ].join('\n');
        }
        updateWidget(widgets.mem, `$(ellipsis) ${usedStr}/${totalStr} ${config.memUnit}`, memMd, true);
      } else {
        updateWidget(widgets.mem, '', '', false);
      }

      // 5. Battery (only if present on host, with tick decimation)
      if (batteryProvider.isAvailable && config.showBattery) {
        if (shouldSampleSlow || cachedBattery === null) {
          cachedBattery = batteryProvider.sample();
        }
        if (cachedBattery) {
          const batStr = padNum(String(cachedBattery.percent), 3);
          let batMd: string | null = null;
          if (updateTooltips) {
            batMd = [
              '### Battery Status',
              `**Remaining Charge**: ${cachedBattery.percent}%`,
              `**Power State**: ${cachedBattery.status}`,
              ...getTooltipFooter(config.tooltipMode),
            ].join('\n');
          }
          updateWidget(widgets.battery, `$(plug) ${batStr}%`, batMd, true);
        } else {
          updateWidget(widgets.battery, '', '', false);
        }
      } else {
        updateWidget(widgets.battery, '', '', false);
      }

      // 6. Disk Space (asynchronous statfs with tick decimation)
      if (config.showDisk) {
        if (shouldSampleSlow || cachedDisks.length === 0) {
          cachedDisks = await diskProvider.sample(config.diskDrives);
        }
        if (cachedDisks.length > 0) {
          const diskTexts = cachedDisks.map((d) => {
            switch (config.diskFormat) {
              case 'PercentRemaining':
                return `${d.mountPath} ${padNum(d.freePercent.toFixed(2), 5)}% remaining`;
              case 'PercentUsed':
                return `${d.mountPath} ${padNum(d.usedPercent.toFixed(2), 5)}% used`;
              case 'Remaining':
                return `${d.mountPath} ${formatBytes(d.freeBytes)} remaining`;
              case 'UsedOutOfTotal':
                return `${d.mountPath} ${formatBytes(d.usedBytes)}/${formatBytes(d.totalBytes)} used`;
            }
          });
          let diskMd: string | null = null;
          if (updateTooltips) {
            const lines = ['### Storage Utilization'];
            for (const d of cachedDisks) {
              lines.push(
                `- **\`${d.mountPath}\`**: ${formatBytes(d.usedBytes)} used of ${formatBytes(d.totalBytes)} (${d.freePercent.toFixed(1)}% free remaining)`
              );
            }
            lines.push(...getTooltipFooter(config.tooltipMode));
            diskMd = lines.join('\n');
          }
          updateWidget(widgets.disk, `$(database) ${diskTexts.join(', ')}`, diskMd, true);
        } else {
          updateWidget(widgets.disk, '', '', false);
        }
      } else {
        updateWidget(widgets.disk, '', '', false);
      }
    } catch {
      // Retain previous display state on transient read errors
    } finally {
      isUpdating = false;
    }
  }

  /**
   * Schedules the subsequent update tick using an unreferenced timer.
   */
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

  // Register refresh command
  context.subscriptions.push(
    vscode.commands.registerCommand('resmon.refresh', async () => {
      tickCounter = 0;
      await update(true);
      scheduleNext();
    })
  );

  // Register toggle tooltip mode command
  context.subscriptions.push(
    vscode.commands.registerCommand('resmon.toggleTooltipMode', async () => {
      const current = getConfig().tooltipMode;
      const next = current === 'Static' ? 'Live' : 'Static';
      const configuration = vscode.workspace.getConfiguration('resmon');
      await configuration.update('tooltip.mode', next, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Resource Monitor: Tooltip mode set to ${next}`);
    })
  );

  // Configuration change listener
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('resmon')) {
        const newConfig = getConfig();
        if (
          newConfig.priority !== currentConfig.priority ||
          newConfig.alignment !== currentConfig.alignment
        ) {
          // Dispose and recreate widgets if layout alignment or base priority changed
          if (widgets) {
            for (const item of Object.values(widgets)) {
              item.dispose();
            }
          }
          currentConfig = newConfig;
          widgets = createWidgets(context, currentConfig.alignment, currentConfig.priority);
        }

        cachedBattery = null;
        cachedDisks = [];
        tickCounter = 0;
        void update(true);
        scheduleNext();
      }
    })
  );

  // Initial update and scheduling
  void update(true);
  scheduleNext();
}

/**
 * Cleans up extension resources and timer handles when the extension is deactivated.
 */
export function deactivate(): void {
  if (updateTimer) {
    clearTimeout(updateTimer);
    updateTimer = null;
  }
  if (widgets) {
    for (const item of Object.values(widgets)) {
      item.dispose();
    }
    widgets = null;
  }
  cachedBattery = null;
  cachedDisks = [];
  tickCounter = 0;
}
