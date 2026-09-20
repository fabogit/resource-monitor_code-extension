# Architectural Specification & Performance Design

## Overview

**Resource Monitor NG** is an ultra-lightweight, cross-platform (Linux & macOS Apple Silicon) extension for VS Code and Antigravity-IDE designed to replace legacy system monitoring extensions that rely on heavy subprocess spawning (e.g. `systeminformation` spawning `ps`, `df`, `free`, or `powermetrics`).

## Zero Subprocess Dual-Platform Architecture

Traditional Node.js system monitor extensions execute shell subprocesses every 1–2 seconds. On Linux and macOS, this causes constant process forks, context switches, thread pool starvation, and prevents CPU cores from entering deeper C-states (increasing power consumption and battery drain).

Resource Monitor NG enforces a strict **Zero-Subprocess Invariant** on all supported platforms:
- **Linux (`linux-x64`)**: Direct synchronous file descriptor reads from the virtual in-memory filesystems (`/proc` and `/sys`).
- **macOS Apple Silicon (`darwin-arm64`)**: Direct synchronous C/C++ kernel API calls via a standalone Node-API native addon (`darwin_telemetry.node`) compiled with Apple Clang, linking Mach, IOKit, and CoreFoundation.

```
┌────────────────────────────────────────────────────────────────────────┐
│                             Extension Host                             │
│                                                                        │
│   [CpuProvider]        [MemoryProvider]       [TempProvider]    ...    │
│         │                     │                      │                 │
│    ┌────┴─────────────────────┼──────────────────────┴────────────┐    │
│    │ Linux                    │ macOS Apple Silicon (darwin-arm64)│    │
│    ▼                          ▼                                   │    │
│  /proc & /sys            Mach kernel APIs (mach_host)             │    │
│  (in-memory VFS)         IOKit & IOHIDEventSystemClient           │    │
│                          AppleSmartBattery IOKit registry         │    │
└────┴──────────────────────────┴───────────────────────────────────┴────┘
```

### 1. CPU Load & Topology
- **Linux**: Reads `/proc/stat` delta counters across logical cores. Handles `iowait` as idle to avoid false I/O spikes.
- **Darwin (Apple Silicon)**: Calls `host_processor_info(PROCESSOR_CPU_LOAD_INFO)` via Mach host APIs to retrieve user, system, idle, and nice ticks per core.
  - **Cold-Start Pre-Sampling (Tick 0)**: Pre-samples CPU ticks during provider instantiation so that the first hover immediately displays valid per-core metrics rather than waiting for an arbitrary polling cycle.
  - **Asymmetric Topology**: Discovers Performance (P) and Efficiency (E) core clusters via `sysctlbyname("hw.perflevel0.logicalcpu")` and `sysctlbyname("hw.perflevel1.logicalcpu")`.

### 2. Clock Frequencies & System Load
- **Linux**: Dynamically discovers `/sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq`, gracefully skipping parked/offline cores (`ENOENT`).
- **Darwin (Apple Silicon - System Load Average)**: Hardware frequency scaling on Apple Silicon is handled autonomously by Apple power firmware and not accessible to unprivileged userspace. Resource Monitor NG maps this slot to **Normalized System Load Average**:
  $$\text{Normalized Load \%} = \frac{\text{Load}_{1\text{m}}}{\text{Total Hardware Cores}} \times 100$$
  Toggleable between normalized percentage (`34.4% L`) and POSIX queue depth (`3.44 L`).

### 3. Hardware Thermal Discovery
- **Linux (`/sys/class/hwmon/`)**: One-time startup heuristic scanning AMD `k10temp`/`zenpower`, Intel `coretemp`, and ACPI thermal zones.
- **Darwin Apple Silicon (`IOHIDEventSystemClient`)**: Unprivileged kernel HID event tap matching `PrimaryUsagePage = 0xff00` and `PrimaryUsage = 0x5`. Samples 24 on-die SoC sensors (reporting both average and peak die temperatures), NAND SSD controller temperature, and battery cell temperature without root permissions.

### 4. Memory & Virtual Memory Subsystem
- **Linux (`/proc/meminfo`)**: Single-pass line scan extracting `MemTotal`, `MemAvailable`, `SwapTotal`, `SwapFree`.
- **Darwin (Mach 64-bit VM)**: Invokes `host_statistics64(HOST_VM_INFO64)` and `sysctl vm.swapusage`. Computes actively consumed RAM (`active + wired + compressed`) and available RAM (`inactive + free`), accurately capturing macOS memory compression dynamics.

### 5. Battery Telemetry & State Discovery
- **Linux**: Scans `/sys/class/power_supply/BAT*` for charge percentage, AC state, `charge_full_design`/`energy_full_design`, and `cycle_count`.
- **Darwin (`AppleSmartBattery` & `IOPowerSources`)**: Direct unprivileged IOKit registry queries extracting:
  - `DesignCapacity` (factory nominal capacity in mAh).
  - `AppleRawMaxCapacity` (current calibrated full charge capacity in mAh).
  - `AppleRawCurrentCapacity` (real-time remaining capacity in mAh).
  - `CycleCount` (completed hardware discharge cycles).
  - **Health %**: $\min(100.0, \frac{\text{AppleRawMaxCapacity}}{\text{DesignCapacity}} \times 100)$.
- **Desktop Auto-Disable**: On desktop workstations without battery hardware, the provider permanently disables itself at startup with zero subsequent runtime overhead.
- **Status Bar Iconography**: Dynamic iconography displaying `$(zap) %` when charging, `🔋 %` when discharging, and `$(plug) %` when connected to AC power at full capacity.

### 6. Storage & Multi-Disk Architecture
- Uses non-blocking asynchronous `statfs()` targeting active workspaces or user-configured mount points.
- **Multi-Disk Display Modes (`resmon.disk.multiDisplay`)**:
  - `'All'`: Displays compact percentages for all monitored filesystems on the status bar (e.g. `/ 24% | /data 55%`).
  - `'MostFull'`: Displays only the single filesystem with highest capacity utilization.
  - Quick-toggle via command `resmon.toggleDiskMultiDisplay`.
- **Smart Path Truncation (`truncatePath`)**: Intelligently truncates path strings by preserving directory boundaries and leaf folder names (e.g. `.../kind-newton` or `.../antigravity/kind-newton`) instead of blind character slicing, ensuring clear visual identification.

---

## Multi-Rate Polling & Tick Decimation

High-frequency telemetry (e.g. 200 ms) is valuable for observing short CPU load spikes and clock frequency scaling, but harmful if applied uniformly to slow-moving or I/O-intensive subsystems.

Resource Monitor NG uses a tick decimation strategy to split fast in-memory telemetry from slow subsystem queries:

```
                  ┌──────────────────────────────────────────────┐
                  │          Timer Tick (e.g. 200 ms)            │
                  └──────────────────────┬───────────────────────┘
                                         │
                 ┌───────────────────────┴───────────────────────┐
                 │                                               │
                 ▼                                               ▼
         [Fast Telemetry]                                 [Decimation Gate]
       Every Tick (200 ms)                         tickCount % decimationRatio === 0?
       - /proc/stat (CPU)                                        │
       - /proc/meminfo (RAM)                        Yes ─────────┴───────── No
       - cpufreq (Clocks)                            │                       │
       - hwmon (Temp)                                ▼                       ▼
                                              [Slow Telemetry]         [Reuse Cache]
                                              - BAT* (sysfs)           Skip I/O & sysfs
                                              - statfs (Disk)
```

$$\text{decimationRatio} = \max\left(1, \left\lceil \frac{1000}{\text{updateFrequencyMs}} \right\rceil\right)$$

- At `updateFrequencyMs = 200` ms, $\text{decimationRatio} = 5$. Disk and Battery sample once every $5 \times 200 = 1000$ ms. Intermediate ticks reuse the cached values with zero kernel context switches or VFS locks.
- Manual refresh (`resmon.refresh` command or widget click) immediately bypasses decimation, forcing a full sample of all subsystems and resetting the timer.

---

## UI Lifecycle & Hover Stabilization

In VS Code (Electron/Chromium), mutating properties on a `vscode.StatusBarItem` sends IPC messages that invalidate the renderer DOM node. Unconditional reassignments or redundant `item.show()` invocations destroy active `HoverWidget` popups, causing noticeable flickering or sudden closing while hovering.

Resource Monitor NG enforces two UI stability invariants:

1. **Content Diffing**:
   - `item.text` is written only if `item.text !== nextText`.
   - `item.tooltip` is written only if `(item.tooltip as vscode.MarkdownString)?.value !== nextMarkdown`.
2. **Idempotent Show/Hide**:
   - `item.show()` is invoked strictly upon creation or when transitioning from hidden to visible. It is never called unconditionally during regular polling ticks.
3. **Fixed-Width Figure Space (`\u2007`)**:
   - Numeric percentages and values are padded with Unicode Figure Space (U+2007), which has the exact width of a digit in tabular numbers. This completely prevents horizontal status bar jitter as values fluctuate between single, double, and triple digits.
4. **Dual Tooltip Modes (`Static` vs `Live`)**:
   - **`Static` (Default)**: Status bar labels stream live telemetry at high frequency, while rich tooltips remain completely frozen during hover to eliminate Chromium DOM re-rendering flashes. Tooltip details update on manual click or `resmon.refresh`.
   - **`Live`**: Tooltips update continuously on every timer tick in real-time, following raw telemetry changes.
   - Switchable dynamically via `resmon.toggleTooltipMode` or through command URI links inside the tooltip Markdown footer.
5. **Unified Monospace ASCII Table Engine (`renderDynamicAsciiTable`)**:
   - Standard GitHub-Flavored Markdown tables rendered in VS Code hover popups rely on proportional system fonts and browser table layout algorithms, frequently causing misaligned columns, awkward line wraps, or excessive horizontal expansion.
   - Resource Monitor NG replaces all HTML/Markdown tables with a 100% deterministic ASCII box-drawing engine (`┌─┬─┐`, `│ │ │`, `├─┼─┤`, `└─┴─┘`) rendered inside fenced `text` blocks.
   - Dynamically calculates maximum column widths, enforces numeric right-alignment and textual left-alignment, and ensures pixel-perfect column alignment across all VS Code themes.
   - Standardized across all 6 subsystems: CPU per-core breakdown, System Load / Frequency, Thermal die matrix, Memory & Swap breakdown, Storage filesystems, and Battery health & capacity.
6. **Deterministic Tooltip Footer Formatting**:
   - In VS Code hover tooltips (Chromium CommonMark implementation), single line breaks within paragraphs are collapsed into a continuous single line, causing wide tooltips when command links are placed on successive lines.
   - Footers are strictly formatted as Markdown lists (`- **Field**: [Action](command:...)`), guaranteeing clean vertical line separation and preserving compact tooltip widths.
7. **Modern Activation Lifecycle (`onStartupFinished`)**:
   - Replaced legacy global wildcard (`"*"`) activation with `"onStartupFinished"`.
   - Prevents the extension from contending with critical VS Code startup tasks (language server initialization, workspace scanning), achieving zero impact on editor launch time.

---

## Benchmarks & Runtime Footprint

| Metric | Legacy (`systeminformation`) | Resource Monitor NG (Linux) | Resource Monitor NG (Darwin Apple Silicon) |
| :--- | :--- | :--- | :--- |
| **Subprocesses spawned / tick** | 3 to 6 (`df`, `ps`, `free`) | **0** | **0** |
| **Telemetry mechanism** | Shell commands | `/proc` & `/sys` VFS | Mach / IOKit / IOHID Node-API |
| **Execution time / tick** | 60 – 120 ms | **< 0.1 ms** | **< 0.15 ms** |
| **Extension Host CPU usage** | ~1.5% – 3.0% | **< 0.05%** | **< 0.05%** |
| **Runtime dependencies** | Multi-MB `node_modules` | **Zero** | **Zero** |
| **Production bundle size** | ~1.2 MB | **27.9 KB** (JS bundle) | **27.9 KB** JS + **17.8 KB** native `.node` |

