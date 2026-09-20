# Project Roadmap & Implementation Milestones

## 1. Vision & Core Architectural Principles

Resource Monitor NG is designed as an ultra-lightweight, zero-overhead hardware telemetry monitor for the Visual Studio Code Status Bar.

* **Strict SLA Budget**: Target total CPU overhead must remain strictly below **0.5% of a single core**, with instantaneous sampling latency under **1 ms**.
* **Zero Child Process Spawning**: Invocations of external shell utilities (`top`, `htop`, `df`, `vm_stat`, `wmic`, `powershell`) are strictly prohibited to prevent process creation overhead, IPC lag, and CPU spikes.
* **In-Process Telemetry**:
  * **POSIX/Darwin**: Direct Mach kernel system calls, `IOKit` framework bindings, and POSIX `statfs`.
  * **POSIX/Linux**: In-process virtual filesystem parsing (`/proc`, `/sys`) with microsecond-range I/O and zero-allocation string scanning, evaluated empirically against native C++ bindings.
  * **Win32/Windows**: Direct Win32 API bindings (PDH, `GlobalMemoryStatusEx`, `GetSystemPowerStatus`, `GetDiskFreeSpaceExW`).
* **Decoupled Platform Architecture**: Telemetry collection is isolated behind the `PlatformProvider` abstraction (`src/types.ts`), allowing the UI status bar items, configuration system, and tooltip rendering to remain platform-agnostic while presenting a modular, platform-tailored view.

---

## 2. Phase 0: Foundation & Linux Genesis (v1.0.0 – v1.0.1) [COMPLETED]

The foundational phase established the core extension functionality, UI widgets, configuration toggles, and initial Linux telemetry engine.

- [x] **Initial Linux Telemetry Architecture**:
  - Implemented initial virtual filesystem readers for `/proc/stat` and `/proc/meminfo`.
  - Prototyped hardware thermal detection across `/sys/class/hwmon` and `/sys/class/thermal`.
  - Built battery status detection via `/sys/class/power_supply`.
- [x] **Multi-Item Status Bar UI Engine**:
  - Modular status bar items for CPU Usage, CPU Frequency, CPU Temperature, RAM Usage, Battery Level, and Primary Disk Utilization.
  - Priority ordering and alignment within the VS Code Status Bar (`vscode.StatusBarAlignment.Right`).
- [x] **Interactive Command & Configuration System**:
  - Granular toggles (`resmon.show.*`) for each metric.
  - Configurable update intervals and alert thresholds.
  - Interactive commands registered in `package.json`:
    - `resmon.refresh`: Force immediate telemetry refresh.
    - `resmon.toggleTooltipMode`: Switch between Live and Static tooltips.
    - `resmon.toggleCpuLayout`: Toggle CPU per-core layout (Table vs List).
    - `resmon.toggleLoadFormat`: Toggle system load format (Percent vs Value).
    - `resmon.toggleDiskMultiDisplay`: Toggle multi-disk display (All vs Most-Full).
- [x] **Rich Markdown Tooltip Layout**:
  - ASCII visual gauge bars for RAM, Swap, and Storage capacity.
  - Tabular layout for per-core CPU breakdown.
- [x] **Production Distribution**: Initial deployment to the Visual Studio Code Marketplace.

---

## 3. Phase 1: Apple Silicon Native Overhaul & Core Refactoring (v1.1.0) [COMPLETED]

Phase 1 restructured the codebase into a strict modular architecture, eliminated technical debt, decoupled storage tracking, and introduced an ultra-fast C++ native addon for Darwin on Apple Silicon.

- [x] **Architectural Modernization & Cleanup**:
  - Formulated the unified `PlatformProvider` interface (`src/types.ts`).
  - Implemented dynamic runtime factory resolution (`src/platform/factory.ts`).
  - Purged 5 legacy orphaned providers (`src/providers/` v1.0.1 dead code).
- [x] **Decoupled POSIX Disk Provider (`src/disk/disk_provider.ts`)**:
  - Replaced legacy filesystem readers with Node.js `fs.promises.statfs`.
  - Completely decoupled disk telemetry from VS Code runtime APIs for cross-platform POSIX execution.
- [x] **Native C++ Mach/IOKit Addon (`darwin_telemetry.node`)**:
  - Direct Mach kernel `host_processor_info` calls for instantaneous CPU core ticks.
  - Hardware topology detection via `sysctlbyname` (differentiating Apple Silicon P-Cores and E-Cores).
  - Normalized system load average calculated across available physical execution cores.
  - In-process Apple Silicon SMC/PMU thermal telemetry (monitoring 24 die sensors with peak detection).
  - Apple Smart Battery telemetry via IOKit (cycle count, actual capacity, design capacity, discharge rate, health %).
  - Mach virtual memory statistics (`host_statistics64`) capturing memory pressure, wired RAM, and compressed memory.
- [x] **Toolchain & Automated Test Suite**:
  - Zero-dependency Clang compilation script (`native/darwin/compile.sh`).
  - Native Apple Silicon smoke test (`test/smoke-darwin.mjs`).
  - Cross-platform end-to-end integration test (`test/integration.ts`).
  - Linux baseline smoke test (`test/smoke-linux.ts`).
- [x] **Ecosystem & Build Modernization**:
  - Modernized engine requirements: `engines.vscode: ^1.105.0`, `engines.node: >=20.0.0`.
  - Aligned development dependencies: `@types/node: ^22.0.0`, `@types/vscode: ~1.105.0`, `@vscode/vsce: ^3.9.0`.
  - Automated targeted packaging for `darwin-arm64`.

---

## 4. Phase 2: Linux Telemetry Modernization & Parity (v1.2.0) [IN PROGRESS]

Phase 2 focuses on bringing the Linux implementation up to the v1.1.0 architectural standard, establishing empirical performance baselines, and verifying telemetry directly on a native Linux workstation.

- [ ] **Phase 2.1: Native Linux Workstation Setup & Baseline Implementation**:
  - Transfer codebase to physical Linux testing environment.
  - Implement modernized `LinuxTelemetryProvider` complying strictly with `PlatformProvider`:
    - **CPU Utilization**: High-resolution delta tick sampling via `/proc/stat`.
    - **CPU Frequency**: Single-pass parsing of `/proc/cpuinfo` or batch query of `/sys/devices/system/cpu/`.
    - **Memory Telemetry**: Deep parsing of `/proc/meminfo` (`MemAvailable`, `MemFree`, `Buffers`, `Cached`, `SwapTotal`, `SwapFree`).
    - **Hardware Thermal Sensors**: Dynamic multi-driver scanning of `/sys/class/hwmon` (`coretemp`, `k10temp`, `zenpower`) with fallback handling.
    - **Battery Telemetry**: Adaptive power profiling via `/sys/class/power_supply` (with zero-overhead detection on desktop/server/VM nodes).
    - **Storage**: Multi-mount validation using the decoupled POSIX `DiskProvider`.
- [ ] **Phase 2.2: Empirical Benchmarking & Scientific Evaluation**:
  - Measure execution latency of the TypeScript VFS reader at $200\,\text{ms}$ polling intervals (`performance.now()`).
  - Profile V8 garbage collection overhead and heap allocation stability.
  - **Decision Gate**:
    - If TypeScript VFS parsing latency stays consistently under $250\,\mu\text{s}$ with negligible GC impact: retain the pure TypeScript engine for maximum cross-distribution compatibility (Ubuntu, Fedora, Arch, Debian, Alpine, x86_64, aarch64).
    - If latency or multi-core parsing on high-core workstations (e.g. 32+ cores) degrades performance: implement a dedicated native C++ addon (`native/linux/linux_telemetry.cc`) leveraging unbuffered `read()` into a stack buffer.
- [ ] **Phase 2.3: Multi-Platform Test Validation & Packaging**:
  - Execute `test:linux` and `test:integration` on live Linux kernel.
  - Configure GitHub Actions CI matrix build for `linux-x64` and `linux-arm64`.
  - Release v1.2.0.

---

## 5. Phase 3: Windows NT Architecture & Win32 Telemetry (v1.3.0) [PLANNED]

Phase 3 introduces native Windows support through direct Win32 API bindings, adhering to the modular UI strategy and pragmatic hardware constraints.

- [ ] **Architectural Blueprint & Toolchain**:
  - Implement `WindowsTelemetryProvider` implementing `PlatformProvider`.
  - Reject CLI/PowerShell/WMI script spawning to maintain the < 0.5% CPU SLA.
  - Design native C++ Win32 addon (`windows_telemetry.node`) compiled via MSVC.
- [ ] **Win32 Core Telemetry Implementations**:
  - **CPU Utilization**: Query per-core and aggregate CPU utilization using Performance Data Helper (PDH) or `GetSystemProcessorPerformanceInformation` via `ntdll.dll`.
  - **Memory Statistics**: Instantaneous RAM, pagefile, and commit charge querying via `GlobalMemoryStatusEx`.
  - **Battery Telemetry**: AC line status, discharge state, and percentage via `GetSystemPowerStatus`.
  - **Drive Storage**: Enumerate active logical drives and query storage via `GetDiskFreeSpaceExW`.
- [ ] **Thermal Telemetry Pragmatic Strategy**:
  - Analyze unprivileged user-space limitations: Windows does not provide standard user-space APIs for CPU core temperatures without Ring-0 kernel drivers.
  - Evaluate non-blocking fallback to `MSAcpi_ThermalZoneTemperature` (WMI) where supported by OEM BIOS; gracefully omit temperature item on unsupported systems without blocking execution.
- [ ] **Windows Packaging & Distribution**:
  - Build pipeline for `win32-x64` and `win32-arm64`.
  - Dedicated Windows integration tests.
  - Release v1.3.0.

---

## 6. Phase 4: Internationalization & Localization (v1.4.0) [NICE TO HAVE]

Phase 4 externalizes and translates user-facing strings once the underlying telemetry data models across Darwin, Linux, and Windows are fully consolidated.

- [ ] **Localization Infrastructure**:
  - Integrate VS Code official `vscode.l10n` API.
  - Extract all hardcoded strings from `src/extension.ts` into source bundle `l10n/bundle.core.json`.
  - Localize command titles, categories, and configuration settings in `package.nls.json`.
- [ ] **Translation Bundles**:
  - Italian (`bundle.core.it.json`).
  - German (`bundle.core.de.json`).
  - French (`bundle.core.fr.json`).
  - Spanish (`bundle.core.es.json`).
  - Japanese (`bundle.core.ja.json`).
  - Simplified Chinese (`bundle.core.zh-cn.json`).
- [ ] **Layout Resilience**:
  - Audit Markdown tooltip tables and ASCII progress bars to prevent visual wrapping or layout misalignment caused by variable-length translated strings.
  - Release v1.4.0.
