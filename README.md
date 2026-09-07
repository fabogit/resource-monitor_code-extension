# Resource Monitor NG (Next-Generation)

Ultra-fast, zero-subprocess, lightweight resource monitor for VS Code and Antigravity-IDE status bar on Linux.

![Resource Monitor](images/icon.png)

## Features

- **CPU Usage (`$(pulse)`)**: Instant overall and per-core utilization parsed directly from `/proc/stat`.
- **CPU Frequency (`$(dashboard)`)**: Dynamic clock speeds read directly from `/sys/devices/system/cpu/cpu*/cpufreq/scaling_cur_freq`, gracefully skipping offline/parked cores.
- **CPU Temperature (`$(flame)`)**: Native discovery for AMD Ryzen/Threadripper (`k10temp`, `zenpower`) with fallback to Intel (`coretemp`) and ACPI zones.
- **Memory & Swap (`$(ellipsis)`)**: Live physical RAM and swap statistics parsed from `/proc/meminfo`.
- **Battery (`$(plug)`)**: Native discovery of `/sys/class/power_supply/BAT*`. Automatically and completely disables itself on desktop systems with zero polling overhead.
- **Disk Space (`$(database)`)**: Non-blocking `statfs` monitoring of workspace partition or configured drives.
- **Rich Markdown Tooltip**: Hovering over the status bar item displays full per-core breakdowns, sensor names, and detailed swap and partition metrics.
- **Zero Process Spawning**: No `df`, `ps`, or `free` shell commands. Zero `node_modules` runtime dependencies.

## Installation

### Method 1: Install from VSIX via GUI (Recommended)
This method ensures the extension is installed into your currently active VS Code profile:
1. Open VS Code or Antigravity-IDE.
2. Open the Extensions sidebar (`Ctrl+Shift+X`).
3. Click the **`...`** (Views and More Actions) menu in the upper-right corner of the Extensions panel.
4. Select **Install from VSIX...**.
5. Browse and select `resource-monitor-ng-1.0.0.vsix`.
6. Reload the window (`Ctrl+Shift+P` -> `Developer: Reload Window`) if prompted.

### Method 2: Command Line Installation

Install to the default profile:
```bash
code --install-extension resource-monitor-ng-1.0.0.vsix
```

Install to a specific custom profile:
```bash
code --profile "<Profile Name>" --install-extension resource-monitor-ng-1.0.0.vsix
```

For Antigravity-IDE:
```bash
antigravity --install-extension resource-monitor-ng-1.0.0.vsix
```

## Configuration Settings

Configure these settings in your VS Code / Antigravity-IDE `settings.json`:

| Setting | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `resmon.show.cpuusage` | `boolean` | `true` | Toggle CPU usage percentage |
| `resmon.show.cpufreq` | `boolean` | `true` | Toggle CPU clock frequency |
| `resmon.show.cputemp` | `boolean` | `true` | Toggle CPU temperature |
| `resmon.show.mem` | `boolean` | `true` | Toggle memory consumption |
| `resmon.show.battery` | `boolean` | `true` | Toggle battery percentage (auto-hidden on desktops) |
| `resmon.show.disk` | `boolean` | `false` | Toggle disk space information |
| `resmon.updatefrequencyms`| `number` | `2000` | Update frequency in milliseconds (min: 200) |
| `resmon.freq.unit` | `string` | `"GHz"` | Unit for CPU frequency (`GHz`, `MHz`, `KHz`, `Hz`) |
| `resmon.mem.unit` | `string` | `"GB"` | Unit for memory display (`GB`, `MB`, `KB`, `B`) |
| `resmon.disk.format` | `string` | `"PercentRemaining"` | Disk display format |
| `resmon.disk.drives` | `string[]`| `[]` | Custom mount paths to monitor |

## Build & Packaging

Build the minified bundle:
```bash
pnpm run build
```

Run type checking:
```bash
pnpm run typecheck
```

Package `.vsix`:
```bash
pnpm run package
```
