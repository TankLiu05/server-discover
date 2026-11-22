"""Linux host metrics and NVIDIA GPU sampling."""

import csv
import io
import shutil
import subprocess
import time

import psutil


def gpu_metrics():
    binary = shutil.which("nvidia-smi")
    if not binary:
        return {"available": False, "error": "未找到 nvidia-smi；请检查 NVIDIA 驱动", "devices": []}
    try:
        result = subprocess.run(
            [binary, "--query-gpu=index,name,utilization.gpu,memory.total,memory.used,temperature.gpu",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=8, check=True,
        )
        devices = []
        for row in csv.reader(io.StringIO(result.stdout)):
            if len(row) != 6:
                continue
            index, name, utilization, total, used, temperature = (v.strip() for v in row)
            total_mb, used_mb = float(total), float(used)
            devices.append({
                "index": int(index), "name": name,
                "utilization_percent": float(utilization),
                "memory_total_mb": total_mb, "memory_used_mb": used_mb,
                "memory_percent": round(used_mb / total_mb * 100, 2) if total_mb else 0,
                "temperature_c": float(temperature) if temperature not in ("N/A", "[N/A]") else None,
            })
        return {"available": bool(devices), "devices": devices, "error": None if devices else "未检测到 NVIDIA GPU"}
    except (subprocess.SubprocessError, ValueError, OSError) as exc:
        return {"available": False, "devices": [], "error": str(exc)[:300]}


def host_metrics():
    memory = psutil.virtual_memory()
    swap = psutil.swap_memory()
    disk = psutil.disk_usage("/")
    return {
        "timestamp": time.time(),
        "cpu_percent": psutil.cpu_percent(interval=0.1),
        "memory_percent": memory.percent,
        "memory_used_gb": round(memory.used / 1024 ** 3, 2),
        "memory_available_gb": round(memory.available / 1024 ** 3, 2),
        "memory_total_gb": round(memory.total / 1024 ** 3, 2),
        "swap_percent": swap.percent,
        "swap_used_gb": round(swap.used / 1024 ** 3, 2),
        "swap_total_gb": round(swap.total / 1024 ** 3, 2),
        "disk_percent": disk.percent,
        "disk_used_gb": round(disk.used / 1024 ** 3, 2),
        "disk_total_gb": round(disk.total / 1024 ** 3, 2),
        "gpu": gpu_metrics(),
    }
