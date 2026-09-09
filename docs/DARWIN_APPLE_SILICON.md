# Darwin & Apple Silicon (M-Series) Architectural Blueprint

This document outlines the design, C/Mach/IOKit kernel APIs, toolchain setup, and step-by-step development guide for adding native macOS Apple Silicon (`darwin-arm64`) support to **Resource Monitor NG** on a MacBook Air M4.

---

## 1. Architectural Differences: Linux vs. Darwin (macOS)

| Subsystem | Linux Implementation | macOS / Darwin (XNU) Reality |
| :--- | :--- | :--- |
| **Telemetry Source** | Virtual pseudo-filesystems (`/proc`, `/sys`) | C-based Kernel APIs (`Mach`, `sysctl`, `IOKit`) |
| **Subprocess Cost** | Zero (pure synchronous `fs.readFileSync`) | Zero achievable **only** via compiled Node-API (N-API) C++ addon |
| **CPU Architecture** | Uniform SMP or x86 SMT cores | Asymmetric big.LITTLE (Performance P-Cores + Efficiency E-Cores) |
| **Clock Frequencies** | `/sys/devices/system/cpu/cpu*/cpufreq/` | **Hidden by Apple Silicon hardware power controller**. Inaccessible without `sudo powermetrics` |
| **Thermal Sensors** | `/sys/class/hwmon/` | **Proprietary Apple SMC / CoreAnalytics**. Inaccessible to unprivileged userspace without root |
| **Memory Metrics** | `/proc/meminfo` (single-pass line scan) | Mach `host_statistics64(HOST_VM_INFO64)` + `sysctl vm.swapusage` |
| **Battery Metrics** | `/sys/class/power_supply/BAT*` | `IOKit.framework` (`IOPowerSources.h`) |
| **Disk Space** | `node:fs/promises.statfs` | POSIX `statfs` (100% portable, works out of the box in Node.js) |

---

## 2. Kernel Telemetry Specifications (Darwin / XNU)

To maintain the **zero-subprocess** guarantee on macOS, all metrics must be queried directly via C bindings through **Node-API (N-API)** compiled for `darwin-arm64`.

### 2.1. CPU Utilization (Per-Core & Overall)
- **Framework / Header**: `<mach/mach_host.h>`, `<mach/processor_info.h>`
- **Mach Call**:
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
- **Data Structure**: `processor_cpu_load_info_t`
  - Ticks: `cpu_ticks[CPU_STATE_USER]`, `cpu_ticks[CPU_STATE_SYSTEM]`, `cpu_ticks[CPU_STATE_IDLE]`, `cpu_ticks[CPU_STATE_NICE]`.
- **Delta Calculation**:
  $$\text{Total} = \text{user} + \text{system} + \text{idle} + \text{nice}$$
  $$\text{Active} = \text{user} + \text{system} + \text{nice}$$
  $$\text{Usage \%} = \frac{\Delta \text{Active}}{\Delta \text{Total}} \times 100$$
- **Cleanup**: Must deallocate Mach virtual memory:
  ```c
  vm_deallocate(mach_task_self(), (vm_address_t)processor_info, processor_info_count * sizeof(natural_t));
  ```

### 2.2. Memory & Swap Statistics
- **Total Physical RAM**:
  ```c
  int mib[2] = { CTL_HW, HW_MEMSIZE };
  uint64_t total_ram = 0;
  size_t len = sizeof(total_ram);
  sysctl(mib, 2, &total_ram, &len, NULL, 0);
  ```
- **VM Page Allocation (Active, Wired, Compressed, Free)**:
  ```c
  vm_size_t page_size;
  host_page_size(mach_host_self(), &page_size);

  vm_statistics64_data_t vm_stat;
  mach_msg_type_number_t count = HOST_VM_INFO64_COUNT;
  host_statistics64(mach_host_self(), HOST_VM_INFO64, (host_info64_t)&vm_stat, &count);
  ```
  - **Used Bytes**: `(vm_stat.active_count + vm_stat.wire_count + vm_stat.compressor_page_count) * page_size`
  - **Available Bytes**: `(vm_stat.inactive_count + vm_stat.free_count) * page_size`
- **Swap Utilization**:
  ```c
  struct xsw_usage swap;
  size_t len = sizeof(swap);
  sysctlbyname("vm.swapusage", &swap, &len, NULL, 0);
  // swap.xsu_total, swap.xsu_used, swap.xsu_avail
  ```

### 2.3. Battery & Power Supply
- **Framework / Header**: `<IOKit/ps/IOPowerSources.h>`, `<IOKit/ps/IOPSKeys.h>`
- **Linker Flags**: `-framework IOKit -framework CoreFoundation`
- **API Call**:
  ```c
  CFTypeRef info = IOPSCopyPowerSourcesInfo();
  CFArrayRef list = IOPSCopyPowerSourcesList(info);
  CFDictionaryRef desc = IOPSGetPowerSourceDescription(info, CFArrayGetValueAtIndex(list, 0));

  CFNumberRef capNum = (CFNumberRef)CFDictionaryGetValue(desc, CFSTR(kIOPSCurrentCapacityKey));
  CFStringRef stateStr = (CFStringRef)CFDictionaryGetValue(desc, CFSTR(kIOPSPowerSourceStateKey));
  ```

### 2.4. Limitations on Apple Silicon (M4 / M-Series)
- **Dynamic Clock Speeds**: Apple Silicon manages frequency scaling autonomously in hardware. Dynamic per-core GHz metrics cannot be read by unprivileged applications. The provider should report nominal base frequency or graceful `N/A`.
- **Hardware Thermals**: Unprivileged applications cannot read M4 thermal zones. The provider should auto-disable or display a notification that root entitlements are required by macOS.

---

## 3. Recommended Project Layout for macOS Node-API

```
resource-monitor/
├── src/
│   ├── extension.ts               # Platform-agnostic status bar & lifecycle
│   ├── config.ts
│   ├── types.ts
│   └── providers/
│       ├── factory.ts             # Instantiates Linux vs. Darwin providers
│       ├── linux/                 # Existing /proc and /sys synchronous providers
│       │   ├── cpu.ts
│       │   ├── cpufreq.ts
│       │   ├── cputemp.ts
│       │   ├── memory.ts
│       │   └── battery.ts
│       ├── darwin/                # macOS N-API Native Bridge
│       │   └── darwin_provider.ts # Calls native/darwin addon
│       └── disk.ts                # Portable Node.js statfs
├── native/
│   └── darwin/
│       ├── binding.gyp            # node-gyp build config linking IOKit & Mach
│       └── src/
│           ├── addon.cc           # N-API module entry point
│           ├── cpu.cc             # host_processor_info wrapper
│           ├── memory.cc          # host_statistics64 wrapper
│           └── battery.cc         # IOPowerSources wrapper
└── package.json
```

---

## 4. Development Guide on MacBook Air M4

### Step 1: Install macOS Development Prerequisites
Open Terminal on your MacBook Air M4:
```bash
# 1. Install Apple Xcode Command Line Tools (provides Clang, Mach & IOKit SDK headers)
xcode-select --install

# 2. Install Node.js (v20+ or v22 LTS) and pnpm (via Homebrew or fnm)
brew install node pnpm
# or using fnm:
# fnm install 22 && fnm use 22 && corepack enable
```

### Step 2: Clone and Checkout the `develop` Branch
```bash
git clone git@github.com:fabogit/resource-monitor_code-extension.git
cd resource-monitor_code-extension
git checkout develop
pnpm install
```

### Step 3: Configure `node-gyp` & `node-addon-api`
1. Install development dependencies:
   ```bash
   pnpm add -D node-addon-api node-gyp
   ```
2. Create `native/darwin/binding.gyp`:
   ```python
   {
     "targets": [
       {
         "target_name": "darwin_telemetry",
         "sources": [ "src/addon.cc" ],
         "include_dirs": [
           "<!@(node -p \"require('node-addon-api').include\")"
         ],
         "dependencies": [
           "<!(node -p \"require('node-addon-api').gyp\")"
         ],
         "conditions": [
           ['OS=="mac"', {
             "link_settings": {
               "libraries": [
                 "-framework CoreFoundation",
                 "-framework IOKit"
               ]
             },
             "xcode_settings": {
               "MACOSX_DEPLOYMENT_TARGET": "11.0",
               "CLANG_CXX_LIBRARY": "libc++",
               "GCC_ENABLE_CPP_EXCEPTIONS": "YES"
             }
           }]
         ]
       }
     ]
   }
   ```
3. Compile native binary for Apple Silicon:
   ```bash
   npx node-gyp rebuild --directory=native/darwin
   ```

### Step 4: Verification & Testing on M4
Create a test script `test-darwin.mjs`:
```js
import telemetry from './native/darwin/build/Release/darwin_telemetry.node';
console.log('M4 CPU Load:', telemetry.getCpuUsage());
console.log('M4 Memory:', telemetry.getMemoryInfo());
console.log('M4 Battery:', telemetry.getBatteryInfo());
```
Run:
```bash
node test-darwin.mjs
```

---

## 5. Platform-Specific VSIX Packaging

When distributing extensions with native binaries, package using platform targets:

```bash
# For Apple Silicon Mac:
pnpm exec vsce package --target darwin-arm64

# For Linux x64:
pnpm exec vsce package --target linux-x64
```

The GitHub Actions workflow in `.github/workflows/release.yml` will be expanded to a build matrix to build both binaries in parallel.
