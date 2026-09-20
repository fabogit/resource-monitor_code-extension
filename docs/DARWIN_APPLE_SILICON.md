# Darwin & Apple Silicon (M-Series) Technical Specification & Implementation Architecture

This document formalizes the production architecture, C/Mach/IOKit kernel APIs, Clang toolchain, and verification methodology implemented for native macOS Apple Silicon (`darwin-arm64`) support in **Resource Monitor NG v1.1.0** on Apple M-Series hardware (M1, M2, M3, M4).

---

## 1. Architectural Comparison: Linux vs. Darwin (macOS)

| Subsystem | Linux Implementation | macOS / Darwin (XNU) Implementation |
| :--- | :--- | :--- |
| **Telemetry Source** | Virtual pseudo-filesystems (`/proc`, `/sys`) | C-based Kernel APIs (`Mach`, `sysctl`, `IOKit`, `IOHID`) |
| **Subprocess Cost** | Zero (pure synchronous `fs.readFileSync`) | Zero (pure synchronous Node-API C++ addon `darwin_telemetry.node`) |
| **CPU Architecture** | Uniform SMP or x86 SMT cores | Asymmetric big.LITTLE (Performance P-Cores + Efficiency E-Cores) |
| **Clock Frequencies** | `/sys/devices/system/cpu/cpu*/cpufreq/` | Normalized System Load Capacity % across hardware cores |
| **Thermal Sensors** | `/sys/class/hwmon/` | **Unprivileged `IOHIDEventSystemClient`**: 24 SoC die sensors, NAND SSD & battery |
| **Memory Metrics** | `/proc/meminfo` (single-pass line scan) | Mach `host_statistics64(HOST_VM_INFO64)` + `sysctl vm.swapusage` |
| **Battery Metrics** | `/sys/class/power_supply/BAT*` | `IOKit.framework` (`IOPowerSources` + `AppleSmartBattery` health & cycles) |
| **Disk Space** | `node:fs/promises.statfs` | POSIX `statfs` (100% portable across Linux & Darwin) |

---

## 2. Kernel Telemetry Specifications (Darwin / XNU)

To maintain the strict **zero-subprocess** guarantee on macOS, all metrics are queried directly via C++ bindings through a standalone Node-API (N-API) addon compiled for `darwin-arm64`.

### 2.1. CPU Utilization & Core Topology
* **Framework / Header**: `<mach/mach_host.h>`, `<mach/processor_info.h>`, `<sys/sysctl.h>`
* **Topology Discovery**:
  * P-Cores: queried via `sysctlbyname("hw.perflevel0.logicalcpu", ...)`
  * E-Cores: queried via `sysctlbyname("hw.perflevel1.logicalcpu", ...)`
  * Total Cores: `sysctlbyname("hw.logicalcpu", ...)`
  * Chip Model: `sysctlbyname("machdep.cpu.brand_string", ...)` (e.g. `'Apple M4'`)
* **Mach Call**:
  ```c
  natural_t processor_count = 0;
  processor_info_array_t processor_info;
  mach_msg_type_number_t processor_info_count;

  kern_return_t kr = host_processor_info(
      mach_host_self(),
      PROCESSOR_CPU_LOAD_INFO,
      &processor_count,
      &processor_info,
      &processor_info_count
  );
  ```
* **Delta Calculation**:
  $$\Delta \text{Total}_i = \Delta \text{user}_i + \Delta \text{system}_i + \Delta \text{idle}_i + \Delta \text{nice}_i$$
  $$\Delta \text{Active}_i = \Delta \text{user}_i + \Delta \text{system}_i + \Delta \text{nice}_i$$
  $$\text{Usage \%}_i = \frac{\Delta \text{Active}_i}{\Delta \text{Total}_i} \times 100$$
* **Deallocation**: Mach shared memory is promptly freed via `vm_deallocate(mach_task_self(), ...)`.

### 2.2. Memory & Swap Statistics
* **Physical RAM**: Queried via `sysctl({ CTL_HW, HW_MEMSIZE })`.
* **VM Page Breakdown**:
  ```c
  vm_statistics64_data_t vm_stat;
  mach_msg_type_number_t count = HOST_VM_INFO64_COUNT;
  host_statistics64(mach_host_self(), HOST_VM_INFO64, (host_info64_t)&vm_stat, &count);
  ```
  * **Used RAM**: `(vm_stat.active_count + vm_stat.wire_count + vm_stat.compressor_page_count) * page_size`
  * **Available RAM**: `(vm_stat.inactive_count + vm_stat.free_count) * page_size`
  * **Compressed Pages**: `vm_stat.compressor_page_count * page_size`
* **Swap Space**: Queried via `sysctlbyname("vm.swapusage", &swap, &len, NULL, 0)`.

### 2.3. Battery Health, Nominal Capacity & Power State
* **Framework / Headers**: `<IOKit/ps/IOPowerSources.h>`, `<IOKit/ps/IOPSKeys.h>`, `<IOKit/IOKitLib.h>`
* **State & Time Remaining**: `IOPSGetPowerSourceDescription` provides real-time charging status (`Charging`, `Discharging`, `AC Connected`, `Full`) and minutes remaining to empty/full.
* **Health & Capacity (Kernel Registry)**:
  Directly reads `AppleSmartBattery` from the IOKit registry without root privileges:
  * `DesignCapacity`: Factory nominal capacity in `mAh` (e.g. 4629 mAh).
  * `AppleRawMaxCapacity`: Current calibrated maximum capacity in `mAh` (e.g. 4506 mAh).
  * `AppleRawCurrentCapacity`: Real-time residual charge in `mAh` (e.g. 2929 mAh).
  * `CycleCount`: Completed hardware discharge cycles (e.g. 136).
  * **Health % Formula**:
    $$\text{Health \%} = \min\left(100.0, \frac{\text{AppleRawMaxCapacity}}{\text{DesignCapacity}} \times 100\right)$$

### 2.4. Unprivileged Thermal Telemetry (`IOHIDEventSystemClient`)
* **Framework**: `IOKit.framework` (HID Event System).
* **Mechanism**: Registers an `IOHIDEventSystemClient` with matching dictionary `PrimaryUsagePage = 0xff00` (Apple vendor-defined) and `PrimaryUsage = 0x5` (Thermal sensor).
* **Zero Privileges**: Operates entirely in unprivileged userspace (no `sudo`, no `powermetrics` process spawning).
* **Metrics Read**:
  * 24 SoC die thermal sensors (SoC Die Average, SoC Die Peak).
  * NAND Flash SSD thermal sensor.
  * Battery cell temperature sensor.

---

## 3. Production Architecture & Layout

```
resource-monitor/
├── src/
│   ├── extension.ts               # Status bar widgets, polling loop, ASCII table rendering
│   ├── config.ts                  # ResMonConfig, settings parsing
│   ├── types.ts                   # BatteryInfo, CpuUsageInfo, MemoryInfo, etc.
│   ├── platform/
│   │   ├── factory.ts             # Instantiates Linux vs. Darwin providers dynamically
│   │   ├── interface.ts           # Universal TelemetryPlatformProvider interface
│   │   ├── linux/                 # Zero-subprocess /proc and /sys synchronous providers
│   │   └── darwin/                # macOS N-API Native Bridge
│   │       ├── native_loader.ts   # Dynamic N-API loader with candidate path search
│   │       └── darwin_provider.ts # TelemetryPlatformProvider implementation
│   └── disk/
│       └── disk_provider.ts       # Pure POSIX statfs provider (zero VS Code coupling)
├── native/
│   └── darwin/
│       ├── compile.sh             # Direct Clang compilation script
│       └── src/
│           └── addon.cc           # Standalone N-API module linking IOKit, Mach, CoreFoundation
└── package.json
```

---

## 4. Native C++ Addon Build Pipeline

The native module [`native/darwin/src/addon.cc`](../native/darwin/src/addon.cc) is compiled directly with Apple Clang, avoiding heavy `node-gyp` runtime and packaging dependencies:

```bash
# Compile native darwin_telemetry.node using Clang
pnpm run compile:native
# (or bash native/darwin/compile.sh)
```

Compilation details:
* Uses Apple Clang targeting Apple Silicon `arm64`.
* Flags: `-O3 -Wall -shared -undefined dynamic_lookup -fPIC`.
* Links: `-framework CoreFoundation -framework IOKit`.
* Outputs directly to `dist/native/darwin_telemetry.node` (52.9 KB).

---

## 5. Verification & Testing on Apple Silicon

1. **Native Telemetry Smoke Test**:
   ```bash
   pnpm run test:darwin
   ```
   Validates P/E core topology, Mach tick deltas, Mach 64-bit VM page stats, IOKit `AppleSmartBattery` health/nominal capacity, and IOHID die temperatures with strict runtime assertions.

2. **Cross-Platform Integration Test**:
   ```bash
   pnpm run test:integration
   ```
   Exercises `createPlatformProvider()` on Darwin, validating cold-start Tick 0 instantaneous sampling, system load average calculations, dynamic multi-rate decimation, and non-blocking `statfs` filesystem checks.

---

## 6. Platform-Specific VSIX Packaging

Platform-specific VSIX packages are built using VS Code's official target architecture flag:

```bash
# Package for Apple Silicon Mac (compiles and bundles darwin_telemetry.node binary):
pnpm run package:darwin-arm64
```

Output:
* `resource-monitor-ng-darwin-arm64-1.1.0.vsix` (39.6 KB, 0 warnings, verified production artifact).

---

## 7. UI Presentation & Tooltip Engineering

* **100% Monospace ASCII Box-Drawing Tables**:
  Replaces proportional Markdown tables with deterministic monospace tables (`┌─┬─┐`, `│ │ │`, `├─┼─┤`, `└─┴─┘`) in hover popups across all 6 widgets (CPU, System Load, Thermals, Memory, Storage, Battery).
* **Cold-Start (Tick 0) Synchronization**:
  Pre-samples Mach processor ticks in the `DarwinTelemetryProvider` constructor, ensuring that hover popups display valid core percentages and hardware topologies on first hover without waiting for an interval tick.
* **Semantic Battery Iconography**:
  Dynamically maps power state to `$(zap) %` (actively charging), `🔋 %` (discharging on battery), and `$(plug) %` (connected to AC power at full capacity).
* **Deterministic Tooltip Footers**:
  Formats footer settings and toggle links as Markdown list items (`- **Key**: [Action](command:...)`), eliminating horizontal hover widget ballooning caused by CommonMark line collapse.
