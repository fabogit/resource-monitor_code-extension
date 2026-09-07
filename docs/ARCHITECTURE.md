# Architectural Specification & Performance Design

## Overview

**Resource Monitor NG** is an ultra-lightweight Linux-native extension for VS Code and Antigravity-IDE designed to replace legacy system monitoring extensions that rely on heavy subprocess spawning (e.g. `systeminformation` spawning `ps`, `df`, `free`).

## Zero Subprocess Architecture

Traditional Node.js system monitor extensions execute shell subprocesses every 1–2 seconds. On Linux, this causes constant process forks, context switches, thread pool starvation, and prevents CPU cores from entering deeper C-states (increasing power consumption).

Resource Monitor NG reads directly from the Linux in-memory virtual pseudo-filesystems (`/proc` and `/sys`) using synchronous file descriptors:

```
┌────────────────────────────────────────────────────────┐
│                      Extension Host                    │
│                                                        │
│   [CpuProvider]        [MemoryProvider]  [CpuTempProvider]
│         │                     │                 │
│         ▼                     ▼                 ▼
│     /proc/stat          /proc/meminfo    /sys/class/hwmon/
│  (in-memory RAM)      (in-memory RAM)    (in-memory RAM)
└────────────────────────────────────────────────────────┘
```

### 1. CPU Load Metrics (`/proc/stat`)
- **Direct read**: Reads the first line of `/proc/stat` (`cpu  user nice system idle iowait irq softirq steal guest guest_nice`).
- **Delta calculation**:
  $$\text{Total} = \text{user} + \text{nice} + \text{system} + \text{idle} + \text{iowait} + \text{irq} + \text{softirq} + \text{steal}$$
  $$\text{IdleTotal} = \text{idle} + \text{iowait}$$
  $$\text{Usage \%} = \frac{\Delta \text{Total} - \Delta \text{IdleTotal}}{\Delta \text{Total}} \times 100$$
- **Edge cases handled**:
  - `iowait` is counted as idle to avoid false 100% CPU spikes during heavy disk I/O.
  - $\Delta \text{Total} \le 0$ protects against division-by-zero or clock skew.
  - Per-core lines (`cpu0`, `cpu1`, ...) are parsed to power detailed hover tooltip breakdowns.

### 2. Dynamic Frequency Scaling (`/sys/devices/system/cpu/`)
- Dynamic core discovery parses `/sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq`.
- **Core hotplug & parking resilience**: Offline or sleeping cores (which yield `ENOENT` on read) are skipped dynamically without crashing the polling cycle.
- Calculates overall average and peak clock frequency across currently online cores.

### 3. Hardware Thermal Discovery (`/sys/class/hwmon/`)
Thermal sensors in Linux vary significantly across motherboards and kernel revisions. Hardcoding hwmon paths (e.g. `hwmon1`) leads to broken sensors on laptops or secondary platforms.

Resource Monitor NG implements a one-time startup heuristic:
1. **AMD Zen/Ryzen priority**: Scans `/sys/class/hwmon/hwmon*/name` looking for `k10temp` or `zenpower`.
2. **Intel Core priority**: Scans for `coretemp`.
3. **Fallback**: Scans for generic ACPI thermal zones (`/sys/class/thermal/thermal_zone0/temp`).
4. **Input target**: Maps to `temp1_input` (`Tctl` / Package ID) or `temp3_input` (`Tccd1`), reading labels dynamically.

### 4. Memory & Swap (`/proc/meminfo`)
- Single-pass line scan extracts `MemTotal`, `MemAvailable`, `SwapTotal`, `SwapFree`.
- Used memory is calculated as $\text{MemTotal} - \text{MemAvailable}$ (respecting Linux kernel 3.14+ buffer/cache availability estimation).

### 5. Battery Power Supply (`/sys/class/power_supply/`)
- Scans `/sys/class/power_supply/` for any `BAT*` device (e.g. `BAT0`, `BAT1`).
- **Desktop Auto-Disable**: If no battery device is found at startup, the provider disables itself permanently with **zero runtime overhead**.
- Handles multi-battery configurations and dynamic AC state changes (`Discharging`, `Charging`, `Full`).

### 6. Storage (`node:fs/promises.statfs`)
- Unlike `/proc` (which is virtual RAM), physical disk queries can block on slower rotational disks or network shares (NFS/SMB).
- Resource Monitor NG uses asynchronous `statfs()` targeting either the active workspace root or user-configured drive paths.

---

## Benchmarks & Runtime Footprint

| Metric | Legacy (`systeminformation`) | Resource Monitor NG |
| :--- | :--- | :--- |
| **Subprocesses spawned / tick** | 3 to 6 (`df`, `ps`, `free`) | **0** |
| **Execution time / tick** | 60 – 120 ms | **< 0.1 ms** |
| **Extension Host CPU usage** | ~1.5% – 3.0% | **< 0.05%** |
| **Runtime dependencies** | Multi-MB `node_modules` | **Zero** |
| **Production bundle size** | ~1.2 MB | **9.4 KB** |
