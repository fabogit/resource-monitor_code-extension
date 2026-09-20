#include <node_api.h>
#include <mach/mach.h>
#include <mach/mach_host.h>
#include <mach/processor_info.h>
#include <sys/sysctl.h>
#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/ps/IOPowerSources.h>
#include <IOKit/ps/IOPSKeys.h>
#include <IOKit/IOKitLib.h>
#include <vector>
#include <string>
#include <cmath>
#include <cstring>

extern "C" {
  typedef struct __IOHIDEvent *IOHIDEventRef;
  typedef struct __IOHIDServiceClient *IOHIDServiceClientRef;
  typedef struct __IOHIDEventSystemClient *IOHIDEventSystemClientRef;

  #define IOHIDEventFieldBase(type) ((type) << 16)
  #define kIOHIDEventTypeTemperature 15

  IOHIDEventSystemClientRef IOHIDEventSystemClientCreate(CFAllocatorRef allocator);
  int IOHIDEventSystemClientSetMatching(IOHIDEventSystemClientRef client, CFDictionaryRef match);
  CFArrayRef IOHIDEventSystemClientCopyServices(IOHIDEventSystemClientRef client);
  CFTypeRef IOHIDServiceClientCopyProperty(IOHIDServiceClientRef service, CFStringRef key);
  IOHIDEventRef IOHIDServiceClientCopyEvent(IOHIDServiceClientRef service, int64_t type, int32_t options, int64_t matching);
  double IOHIDEventGetFloatValue(IOHIDEventRef event, int32_t field);
}

/**
 * Returns per-core cumulative CPU ticks using Mach host_processor_info.
 */
static napi_value GetCpuTicks(napi_env env, napi_callback_info info) {
  natural_t processor_count = 0;
  processor_info_array_t processor_info = nullptr;
  mach_msg_type_number_t processor_info_count = 0;

  kern_return_t kr = host_processor_info(
      mach_host_self(),
      PROCESSOR_CPU_LOAD_INFO,
      &processor_count,
      &processor_info,
      &processor_info_count
  );

  if (kr != KERN_SUCCESS || !processor_info) {
    napi_value null_val;
    napi_get_null(env, &null_val);
    return null_val;
  }

  processor_cpu_load_info_t cpu_load_info = (processor_cpu_load_info_t)processor_info;

  napi_value result_array;
  napi_create_array_with_length(env, processor_count, &result_array);

  for (natural_t i = 0; i < processor_count; ++i) {
    napi_value core_obj;
    napi_create_object(env, &core_obj);

    napi_value user_val, sys_val, idle_val, nice_val;
    napi_create_int64(env, cpu_load_info[i].cpu_ticks[CPU_STATE_USER], &user_val);
    napi_create_int64(env, cpu_load_info[i].cpu_ticks[CPU_STATE_SYSTEM], &sys_val);
    napi_create_int64(env, cpu_load_info[i].cpu_ticks[CPU_STATE_IDLE], &idle_val);
    napi_create_int64(env, cpu_load_info[i].cpu_ticks[CPU_STATE_NICE], &nice_val);

    napi_set_named_property(env, core_obj, "user", user_val);
    napi_set_named_property(env, core_obj, "system", sys_val);
    napi_set_named_property(env, core_obj, "idle", idle_val);
    napi_set_named_property(env, core_obj, "nice", nice_val);

    napi_set_element(env, result_array, i, core_obj);
  }

  vm_deallocate(mach_task_self(), (vm_address_t)processor_info, processor_info_count * sizeof(natural_t));
  return result_array;
}

/**
 * Returns CPU hardware topology (Performance vs Efficiency cores and model branding).
 */
static napi_value GetCpuTopology(napi_env env, napi_callback_info info) {
  napi_value obj;
  napi_create_object(env, &obj);

  char brand[128] = "Apple Silicon";
  size_t brand_len = sizeof(brand);
  sysctlbyname("machdep.cpu.brand_string", brand, &brand_len, nullptr, 0);

  int ncpu = 0;
  size_t ncpu_len = sizeof(ncpu);
  sysctlbyname("hw.ncpu", &ncpu, &ncpu_len, nullptr, 0);

  int p_cores = 0;
  size_t p_len = sizeof(p_cores);
  sysctlbyname("hw.perflevel0.logicalcpu", &p_cores, &p_len, nullptr, 0);

  int e_cores = 0;
  size_t e_len = sizeof(e_cores);
  sysctlbyname("hw.perflevel1.logicalcpu", &e_cores, &e_len, nullptr, 0);

  napi_value brand_val, ncpu_val, p_val, e_val;
  napi_create_string_utf8(env, brand, NAPI_AUTO_LENGTH, &brand_val);
  napi_create_int32(env, ncpu, &ncpu_val);
  napi_create_int32(env, p_cores, &p_val);
  napi_create_int32(env, e_cores, &e_val);

  napi_set_named_property(env, obj, "model", brand_val);
  napi_set_named_property(env, obj, "totalCores", ncpu_val);
  napi_set_named_property(env, obj, "pCores", p_val);
  napi_set_named_property(env, obj, "eCores", e_val);

  return obj;
}

/**
 * Returns detailed memory statistics (Active, Wired, Compressed, Inactive, Free, Swap, and Memory Pressure).
 */
static napi_value GetMemoryStats(napi_env env, napi_callback_info info) {
  napi_value obj;
  napi_create_object(env, &obj);

  int mib[2] = { CTL_HW, HW_MEMSIZE };
  uint64_t total_ram = 0;
  size_t ram_len = sizeof(total_ram);
  sysctl(mib, 2, &total_ram, &ram_len, nullptr, 0);

  vm_size_t page_size = 0;
  host_page_size(mach_host_self(), &page_size);

  vm_statistics64_data_t vm_stat;
  mach_msg_type_number_t count = HOST_VM_INFO64_COUNT;
  kern_return_t kr = host_statistics64(mach_host_self(), HOST_VM_INFO64, (host_info64_t)&vm_stat, &count);

  if (kr != KERN_SUCCESS) {
    napi_value null_val;
    napi_get_null(env, &null_val);
    return null_val;
  }

  uint64_t active = (uint64_t)vm_stat.active_count * page_size;
  uint64_t wire = (uint64_t)vm_stat.wire_count * page_size;
  uint64_t compressed = (uint64_t)vm_stat.compressor_page_count * page_size;
  uint64_t inactive = (uint64_t)vm_stat.inactive_count * page_size;
  uint64_t free = (uint64_t)vm_stat.free_count * page_size;

  uint64_t used = active + wire + compressed;
  uint64_t available = inactive + free;

  // Swap usage
  struct xsw_usage swap;
  size_t swap_len = sizeof(swap);
  uint64_t swap_total = 0;
  uint64_t swap_used = 0;
  uint64_t swap_free = 0;

  if (sysctlbyname("vm.swapusage", &swap, &swap_len, nullptr, 0) == 0) {
    swap_total = swap.xsu_total;
    swap_used = swap.xsu_used;
    swap_free = swap.xsu_avail;
  }

  // Memory pressure (0..100)
  int memory_pressure = 0;
  size_t mp_len = sizeof(memory_pressure);
  sysctlbyname("vm.memory_pressure", &memory_pressure, &mp_len, nullptr, 0);

  napi_value total_val, used_val, avail_val, active_val, wire_val, comp_val, inact_val, free_val;
  napi_value sw_total_val, sw_used_val, sw_free_val, mp_val;

  napi_create_int64(env, total_ram, &total_val);
  napi_create_int64(env, used, &used_val);
  napi_create_int64(env, available, &avail_val);
  napi_create_int64(env, active, &active_val);
  napi_create_int64(env, wire, &wire_val);
  napi_create_int64(env, compressed, &comp_val);
  napi_create_int64(env, inactive, &inact_val);
  napi_create_int64(env, free, &free_val);

  napi_create_int64(env, swap_total, &sw_total_val);
  napi_create_int64(env, swap_used, &sw_used_val);
  napi_create_int64(env, swap_free, &sw_free_val);
  napi_create_int32(env, memory_pressure, &mp_val);

  napi_set_named_property(env, obj, "totalBytes", total_val);
  napi_set_named_property(env, obj, "usedBytes", used_val);
  napi_set_named_property(env, obj, "availableBytes", avail_val);
  napi_set_named_property(env, obj, "activeBytes", active_val);
  napi_set_named_property(env, obj, "wiredBytes", wire_val);
  napi_set_named_property(env, obj, "compressedBytes", comp_val);
  napi_set_named_property(env, obj, "inactiveBytes", inact_val);
  napi_set_named_property(env, obj, "freeBytes", free_val);

  napi_set_named_property(env, obj, "swapTotalBytes", sw_total_val);
  napi_set_named_property(env, obj, "swapUsedBytes", sw_used_val);
  napi_set_named_property(env, obj, "swapFreeBytes", sw_free_val);
  napi_set_named_property(env, obj, "pressurePercent", mp_val);

  return obj;
}

/**
 * Returns battery metrics using IOKit IOPowerSources including estimated time to empty / full.
 */
static napi_value GetBatteryStats(napi_env env, napi_callback_info info) {
  napi_value obj;
  napi_create_object(env, &obj);

  CFTypeRef blob = IOPSCopyPowerSourcesInfo();
  if (!blob) {
    napi_value false_val;
    napi_get_boolean(env, false, &false_val);
    napi_set_named_property(env, obj, "isAvailable", false_val);
    return obj;
  }

  CFArrayRef sources = IOPSCopyPowerSourcesList(blob);
  if (!sources || CFArrayGetCount(sources) == 0) {
    if (sources) CFRelease(sources);
    CFRelease(blob);

    napi_value false_val;
    napi_get_boolean(env, false, &false_val);
    napi_set_named_property(env, obj, "isAvailable", false_val);
    return obj;
  }

  CFDictionaryRef desc = IOPSGetPowerSourceDescription(blob, CFArrayGetValueAtIndex(sources, 0));
  if (!desc) {
    CFRelease(sources);
    CFRelease(blob);

    napi_value false_val;
    napi_get_boolean(env, false, &false_val);
    napi_set_named_property(env, obj, "isAvailable", false_val);
    return obj;
  }

  CFNumberRef cap_num = (CFNumberRef)CFDictionaryGetValue(desc, CFSTR(kIOPSCurrentCapacityKey));
  CFStringRef state_str = (CFStringRef)CFDictionaryGetValue(desc, CFSTR(kIOPSPowerSourceStateKey));
  CFBooleanRef is_charging_ref = (CFBooleanRef)CFDictionaryGetValue(desc, CFSTR(kIOPSIsChargingKey));
  CFNumberRef time_empty_num = (CFNumberRef)CFDictionaryGetValue(desc, CFSTR(kIOPSTimeToEmptyKey));
  CFNumberRef time_full_num = (CFNumberRef)CFDictionaryGetValue(desc, CFSTR(kIOPSTimeToFullChargeKey));

  int capacity = 0;
  if (cap_num) {
    CFNumberGetValue(cap_num, kCFNumberIntType, &capacity);
  }

  bool is_charging = (is_charging_ref && CFBooleanGetValue(is_charging_ref));
  int time_remaining = -1;
  if (is_charging && time_full_num) {
    CFNumberGetValue(time_full_num, kCFNumberIntType, &time_remaining);
  } else if (!is_charging && time_empty_num) {
    CFNumberGetValue(time_empty_num, kCFNumberIntType, &time_remaining);
  }

  char state_buf[64] = "Discharging";
  if (is_charging) {
    snprintf(state_buf, sizeof(state_buf), "Charging");
  } else if (state_str) {
    if (CFStringCompare(state_str, CFSTR(kIOPSACPowerValue), 0) == kCFCompareEqualTo) {
      snprintf(state_buf, sizeof(state_buf), capacity >= 100 ? "Full" : "AC Connected");
    } else {
      snprintf(state_buf, sizeof(state_buf), "Discharging");
    }
  }

  CFRelease(sources);
  CFRelease(blob);

  // Query AppleSmartBattery for raw mAh capacity, design capacity, cycles, and health
  int design_capacity = 0;
  int raw_max_capacity = 0;
  int raw_current_capacity = 0;
  int cycle_count = -1;
  double health_percent = -1.0;

  io_service_t smart_battery = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("AppleSmartBattery"));
  if (smart_battery) {
    CFMutableDictionaryRef battery_props = NULL;
    if (IORegistryEntryCreateCFProperties(smart_battery, &battery_props, kCFAllocatorDefault, 0) == KERN_SUCCESS && battery_props) {
      CFNumberRef design_cap_ref = (CFNumberRef)CFDictionaryGetValue(battery_props, CFSTR("DesignCapacity"));
      CFNumberRef max_cap_ref = (CFNumberRef)CFDictionaryGetValue(battery_props, CFSTR("AppleRawMaxCapacity"));
      if (!max_cap_ref) {
        max_cap_ref = (CFNumberRef)CFDictionaryGetValue(battery_props, CFSTR("NominalChargeCapacity"));
      }
      CFNumberRef cur_cap_ref = (CFNumberRef)CFDictionaryGetValue(battery_props, CFSTR("AppleRawCurrentCapacity"));
      CFNumberRef cycle_ref = (CFNumberRef)CFDictionaryGetValue(battery_props, CFSTR("CycleCount"));

      if (design_cap_ref) CFNumberGetValue(design_cap_ref, kCFNumberIntType, &design_capacity);
      if (max_cap_ref) CFNumberGetValue(max_cap_ref, kCFNumberIntType, &raw_max_capacity);
      if (cur_cap_ref) CFNumberGetValue(cur_cap_ref, kCFNumberIntType, &raw_current_capacity);
      if (cycle_ref) CFNumberGetValue(cycle_ref, kCFNumberIntType, &cycle_count);

      if (design_capacity > 0 && raw_max_capacity > 0) {
        health_percent = ((double)raw_max_capacity / (double)design_capacity) * 100.0;
        if (health_percent > 100.0) {
          health_percent = 100.0;
        }
      }

      CFRelease(battery_props);
    }
    IOObjectRelease(smart_battery);
  }

  napi_value true_val, cap_val, state_val, time_val, is_chg_val;
  napi_get_boolean(env, true, &true_val);
  napi_create_int32(env, capacity, &cap_val);
  napi_create_string_utf8(env, state_buf, NAPI_AUTO_LENGTH, &state_val);
  napi_create_int32(env, time_remaining, &time_val);
  napi_get_boolean(env, is_charging, &is_chg_val);

  napi_set_named_property(env, obj, "isAvailable", true_val);
  napi_set_named_property(env, obj, "percent", cap_val);
  napi_set_named_property(env, obj, "status", state_val);
  napi_set_named_property(env, obj, "timeRemainingMinutes", time_val);
  napi_set_named_property(env, obj, "isCharging", is_chg_val);

  if (design_capacity > 0) {
    napi_value design_val;
    napi_create_int32(env, design_capacity, &design_val);
    napi_set_named_property(env, obj, "designCapacity", design_val);
  }
  if (raw_max_capacity > 0) {
    napi_value max_val;
    napi_create_int32(env, raw_max_capacity, &max_val);
    napi_set_named_property(env, obj, "maxCapacity", max_val);
  }
  if (raw_current_capacity > 0) {
    napi_value cur_val;
    napi_create_int32(env, raw_current_capacity, &cur_val);
    napi_set_named_property(env, obj, "currentCapacity", cur_val);
  }
  if (cycle_count >= 0) {
    napi_value cycle_val;
    napi_create_int32(env, cycle_count, &cycle_val);
    napi_set_named_property(env, obj, "cycleCount", cycle_val);
  }
  if (health_percent >= 0.0) {
    napi_value health_val;
    napi_create_double(env, health_percent, &health_val);
    napi_set_named_property(env, obj, "healthPercent", health_val);
  }
  napi_value unit_val;
  napi_create_string_utf8(env, "mAh", NAPI_AUTO_LENGTH, &unit_val);
  napi_set_named_property(env, obj, "capacityUnit", unit_val);

  return obj;
}

/**
 * Reads silicon die temperatures, peak die sensor, NAND SSD, and battery temperature using IOHIDEventSystemClient.
 */
static napi_value GetDieTemperature(napi_env env, napi_callback_info info) {
  IOHIDEventSystemClientRef client = IOHIDEventSystemClientCreate(kCFAllocatorDefault);
  if (!client) {
    napi_value null_val;
    napi_get_null(env, &null_val);
    return null_val;
  }

  int page = 0xff00;
  int usage = 5; // AppleVendorTemperatureSensor
  CFNumberRef page_num = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &page);
  CFNumberRef usage_num = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &usage);

  const void *keys[2] = { CFSTR("PrimaryUsagePage"), CFSTR("PrimaryUsage") };
  const void *values[2] = { page_num, usage_num };
  CFDictionaryRef match = CFDictionaryCreate(kCFAllocatorDefault, keys, values, 2, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  IOHIDEventSystemClientSetMatching(client, match);

  CFArrayRef services = IOHIDEventSystemClientCopyServices(client);
  if (!services) {
    CFRelease(match);
    CFRelease(page_num);
    CFRelease(usage_num);
    CFRelease(client);
    napi_value null_val;
    napi_get_null(env, &null_val);
    return null_val;
  }

  CFIndex count = CFArrayGetCount(services);
  double sum_tdie = 0.0;
  double max_tdie = 0.0;
  char max_sensor_name[64] = "tdie";
  int tdie_count = 0;
  double nand_temp = -100.0;
  double battery_temp = -100.0;

  for (CFIndex i = 0; i < count; ++i) {
    IOHIDServiceClientRef service = (IOHIDServiceClientRef)CFArrayGetValueAtIndex(services, i);
    CFStringRef product = (CFStringRef)IOHIDServiceClientCopyProperty(service, CFSTR("Product"));
    if (!product) continue;

    char name[128] = {0};
    CFStringGetCString(product, name, sizeof(name), kCFStringEncodingUTF8);
    CFRelease(product);

    if (strstr(name, "tdie") != nullptr) {
      IOHIDEventRef event = IOHIDServiceClientCopyEvent(service, kIOHIDEventTypeTemperature, 0, 0);
      if (event) {
        double temp = IOHIDEventGetFloatValue(event, IOHIDEventFieldBase(kIOHIDEventTypeTemperature));
        if (temp > 0.0 && temp < 130.0) {
          sum_tdie += temp;
          if (temp > max_tdie) {
            max_tdie = temp;
            snprintf(max_sensor_name, sizeof(max_sensor_name), "%s", name);
          }
          tdie_count++;
        }
        CFRelease(event);
      }
    } else if (nand_temp < 0.0 && (strstr(name, "NAND") != nullptr || strstr(name, "nand") != nullptr)) {
      IOHIDEventRef event = IOHIDServiceClientCopyEvent(service, kIOHIDEventTypeTemperature, 0, 0);
      if (event) {
        double temp = IOHIDEventGetFloatValue(event, IOHIDEventFieldBase(kIOHIDEventTypeTemperature));
        if (temp > 0.0 && temp < 130.0) {
          nand_temp = temp;
        }
        CFRelease(event);
      }
    } else if (battery_temp < 0.0 && (strstr(name, "gas gauge") != nullptr || strstr(name, "battery") != nullptr)) {
      IOHIDEventRef event = IOHIDServiceClientCopyEvent(service, kIOHIDEventTypeTemperature, 0, 0);
      if (event) {
        double temp = IOHIDEventGetFloatValue(event, IOHIDEventFieldBase(kIOHIDEventTypeTemperature));
        if (temp > 0.0 && temp < 130.0) {
          battery_temp = temp;
        }
        CFRelease(event);
      }
    }
  }

  CFRelease(services);
  CFRelease(match);
  CFRelease(page_num);
  CFRelease(usage_num);
  CFRelease(client);

  if (tdie_count == 0) {
    napi_value null_val;
    napi_get_null(env, &null_val);
    return null_val;
  }

  double avg_temp = sum_tdie / tdie_count;

  napi_value obj;
  napi_create_object(env, &obj);

  napi_value avg_val, max_val, max_sensor_val, count_val;
  napi_create_double(env, avg_temp, &avg_val);
  napi_create_double(env, max_tdie, &max_val);
  napi_create_string_utf8(env, max_sensor_name, NAPI_AUTO_LENGTH, &max_sensor_val);
  napi_create_int32(env, tdie_count, &count_val);

  napi_set_named_property(env, obj, "tempCelsius", avg_val);
  napi_set_named_property(env, obj, "peakCelsius", max_val);
  napi_set_named_property(env, obj, "peakSensor", max_sensor_val);
  napi_set_named_property(env, obj, "dieCount", count_val);

  napi_value name_val, label_val;
  napi_create_string_utf8(env, "Apple Silicon Die", NAPI_AUTO_LENGTH, &name_val);
  char label_buf[64];
  snprintf(label_buf, sizeof(label_buf), "%d sensors (max %.1f C)", tdie_count, max_tdie);
  napi_create_string_utf8(env, label_buf, NAPI_AUTO_LENGTH, &label_val);
  napi_set_named_property(env, obj, "sensorName", name_val);
  napi_set_named_property(env, obj, "sensorLabel", label_val);

  if (nand_temp > 0.0) {
    napi_value nand_val;
    napi_create_double(env, nand_temp, &nand_val);
    napi_set_named_property(env, obj, "nandCelsius", nand_val);
  }

  if (battery_temp > 0.0) {
    napi_value batt_val;
    napi_create_double(env, battery_temp, &batt_val);
    napi_set_named_property(env, obj, "batteryCelsius", batt_val);
  }

  return obj;
}

NAPI_MODULE_INIT() {
  napi_value fn_cpu, fn_topo, fn_mem, fn_batt, fn_temp;

  napi_create_function(env, "getCpuTicks", NAPI_AUTO_LENGTH, GetCpuTicks, nullptr, &fn_cpu);
  napi_set_named_property(env, exports, "getCpuTicks", fn_cpu);

  napi_create_function(env, "getCpuTopology", NAPI_AUTO_LENGTH, GetCpuTopology, nullptr, &fn_topo);
  napi_set_named_property(env, exports, "getCpuTopology", fn_topo);

  napi_create_function(env, "getMemoryStats", NAPI_AUTO_LENGTH, GetMemoryStats, nullptr, &fn_mem);
  napi_set_named_property(env, exports, "getMemoryStats", fn_mem);

  napi_create_function(env, "getBatteryStats", NAPI_AUTO_LENGTH, GetBatteryStats, nullptr, &fn_batt);
  napi_set_named_property(env, exports, "getBatteryStats", fn_batt);

  napi_create_function(env, "getDieTemperature", NAPI_AUTO_LENGTH, GetDieTemperature, nullptr, &fn_temp);
  napi_set_named_property(env, exports, "getDieTemperature", fn_temp);

  return exports;
}
