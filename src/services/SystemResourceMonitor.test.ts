import test from "node:test";
import assert from "node:assert/strict";
import { SystemResourceMonitor } from "./SystemResourceMonitor";

function sample(overrides: Record<string, unknown> = {}) {
  return {
    cpu: { percent: 90 },
    ram: { percent: 95, used: "15GB", total: "16GB" },
    disk: { available: true, percent: 50, used: "50GB", total: "100GB", mountpoint: "/" },
    battery: { available: true, percent: 50, power_plugged: false },
    processes: [],
    ...overrides,
  };
}

test("system monitor alerts only after repeated high CPU and memory samples", () => {
  const monitor = new SystemResourceMonitor();
  assert.deepEqual(monitor.evaluate(sample(), 1_000).alerts, []);
  const second = monitor.evaluate(sample(), 2_000).alerts;
  assert.deepEqual(second.map((alert) => alert.kind).sort(), ["cpu_high", "memory_high"]);
  assert.equal(monitor.evaluate(sample(), 3_000).alerts.length, 0, "an active warning is not repeated every poll");
  monitor.evaluate(sample({ cpu: { percent: 70 }, ram: { percent: 80 } }), 4_000);
  assert.deepEqual(monitor.evaluate(sample(), 5_000).alerts, []);
  const recovered = monitor.evaluate(sample(), 6_000).alerts;
  assert.deepEqual(recovered.map((alert) => alert.kind).sort(), ["cpu_high", "memory_high"]);
});

test("system monitor detects critically full disks after repeated samples", () => {
  const monitor = new SystemResourceMonitor();
  const fullDisk = sample({ cpu: { percent: 10 }, ram: { percent: 20 }, disk: { available: true, percent: 98 } });
  assert.deepEqual(monitor.evaluate(fullDisk, 1_000).alerts, []);
  const alert = monitor.evaluate(fullDisk, 2_000).alerts[0];
  assert.equal(alert?.kind, "disk_high");
  assert.equal(alert?.severity, "CRITICAL");
});

test("system monitor reports low battery once and rearms after charging or recovery", () => {
  const monitor = new SystemResourceMonitor();
  const lowBattery = sample({ cpu: { percent: 10 }, ram: { percent: 20 }, battery: { available: true, percent: 15, power_plugged: false } });
  assert.equal(monitor.evaluate(lowBattery, 1_000).alerts[0]?.kind, "battery_low");
  assert.equal(monitor.evaluate(lowBattery, 2_000).alerts.length, 0);
  monitor.evaluate(sample({ cpu: { percent: 10 }, ram: { percent: 20 }, battery: { available: true, percent: 15, power_plugged: true } }), 3_000);
  assert.equal(monitor.evaluate(lowBattery, 4_000).alerts[0]?.kind, "battery_low");
});

test("system monitor flags a sustained high-use process but never labels protected apps as closeable", () => {
  const monitor = new SystemResourceMonitor();
  const process = { pid: 42, name: "ExampleApp", cpu_percent: 65, memory_percent: 10, protected: false };
  const input = sample({ cpu: { percent: 10 }, ram: { percent: 20 }, processes: [process] });
  assert.equal(monitor.evaluate(input, 1_000).alerts.length, 0);
  const second = monitor.evaluate(input, 2_000);
  assert.equal(second.alerts[0]?.kind, "process_high");
  assert.equal(second.snapshot.processes[0].highUsage, true);
  assert.equal(second.snapshot.processes[0].protected, false);

  const protectedMonitor = new SystemResourceMonitor();
  const protectedInput = sample({
    cpu: { percent: 10 },
    ram: { percent: 20 },
    processes: [{ ...process, name: "SARA service", protected: true }],
  });
  protectedMonitor.evaluate(protectedInput, 1_000);
  const protectedResult = protectedMonitor.evaluate(protectedInput, 2_000);
  assert.equal(protectedResult.snapshot.processes[0].protected, true);
  assert.equal(protectedResult.snapshot.processes[0].highUsage, true);
});

test("missing battery and disk telemetry does not produce false alerts", () => {
  const monitor = new SystemResourceMonitor();
  const result = monitor.evaluate(sample({ battery: { available: false, percent: null, power_plugged: null }, disk: { available: false, percent: null } }), 1_000);
  assert.equal(result.snapshot.battery.available, false);
  assert.equal(result.snapshot.battery.percent, null);
  assert.equal(result.snapshot.disk.available, false);
  assert.equal(result.snapshot.disk.percent, null);
  assert.equal(result.alerts.some((alert) => alert.kind === "battery_low" || alert.kind === "disk_high"), false);
});
