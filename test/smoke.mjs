import * as fs from 'node:fs';
import * as path from 'node:path';

// Minimal mock or direct import of the compiled providers
// Since dist/extension.js bundles extension.ts with 'vscode' as external,
// let's test the provider classes directly by compiling or importing them.
import { CpuProvider } from '../src/providers/cpu.js';
import { CpuFreqProvider } from '../src/providers/cpufreq.js';
import { CpuTempProvider } from '../src/providers/cputemp.js';
import { MemoryProvider } from '../src/providers/memory.js';
import { BatteryProvider } from '../src/providers/battery.js';

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  console.log('=== RESOURCE MONITOR NG - SMOKE TEST ===\n');

  const cpu = new CpuProvider();
  const freq = new CpuFreqProvider();
  const temp = new CpuTempProvider();
  const mem = new MemoryProvider();
  const bat = new BatteryProvider();

  console.log('Sampling tick 1...');
  cpu.sample();
  await sleep(1000);

  console.log('Sampling tick 2...');
  const cpuResult = cpu.sample();
  const freqResult = freq.sample();
  const tempResult = temp.sample();
  const memResult = mem.sample();
  const batResult = bat.sample();

  console.log('\n--- RESULTS ---');
  console.log('CPU Usage:', cpuResult ? `${cpuResult.overallPercent.toFixed(2)}% (Cores: ${cpuResult.perCorePercent.length})` : 'FAILED');
  console.log('CPU Frequency:', freqResult ? `Avg: ${(freqResult.avgHz / 1e9).toFixed(2)} GHz, Max: ${(freqResult.maxHz / 1e9).toFixed(2)} GHz` : 'FAILED');
  console.log('CPU Temperature:', tempResult ? `${tempResult.tempCelsius.toFixed(2)} °C [${tempResult.sensorName}: ${tempResult.sensorLabel}]` : 'FAILED');
  console.log('Memory:', memResult ? `Used: ${(memResult.usedBytes / 1024**3).toFixed(2)} GB / ${(memResult.totalBytes / 1024**3).toFixed(2)} GB (${memResult.usedPercent.toFixed(1)}%)` : 'FAILED');
  console.log('Battery:', bat.isAvailable ? (batResult ? `${batResult.percent}% (${batResult.status})` : 'READ FAILED') : 'Not present (Auto-disabled correctly)');

  if (!cpuResult || !freqResult || !tempResult || !memResult) {
    console.error('\nFAIL: Essential providers returned null!');
    process.exit(1);
  }

  console.log('\nSUCCESS: All active providers passed verification!');
}

run().catch((err) => {
  console.error('Smoke test crashed:', err);
  process.exit(1);
});
