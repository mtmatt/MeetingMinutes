"""GPU memory as nvidia-smi reports it, and choosing the GPU a session runs on.

nvidia-smi allocates no VRAM (unlike torch.cuda), so the supervisor can ask
before every session without holding any GPU memory itself. Its numbers
include memory used by other programs on the machine.
"""

from __future__ import annotations

import shutil
import subprocess
from dataclasses import dataclass
from typing import Optional, Sequence


@dataclass(frozen=True)
class GpuMemory:
    index: str
    uuid: str
    name: str
    total_gb: float
    free_gb: float


def query_gpus(timeout: float = 10) -> Optional[list[GpuMemory]]:
    """Every GPU on this machine, or None without nvidia-smi. Raises if nvidia-smi fails."""
    exe = shutil.which("nvidia-smi")
    if not exe:
        return None
    out = subprocess.run(
        [exe, "--query-gpu=index,uuid,name,memory.total,memory.used", "--format=csv,noheader,nounits"],
        capture_output=True,
        text=True,
        timeout=timeout,
        check=True,
    )
    return parse_gpus(out.stdout)


def parse_gpus(csv: str) -> list[GpuMemory]:
    gpus = []
    for line in csv.strip().splitlines():
        index, uuid, name, total, used = [p.strip() for p in line.split(",")]
        total_gb = float(total) / 1024
        # Free as the admin page shows it: everything not in use, by anyone.
        gpus.append(GpuMemory(index, uuid, name, total_gb, total_gb - float(used) / 1024))
    return gpus


def find_gpu(gpus: Sequence[GpuMemory], gpu: str) -> Optional[GpuMemory]:
    """`gpu` as written in WORKER_GPUS or CUDA_VISIBLE_DEVICES: an nvidia-smi
    index, a UUID, or (as CUDA accepts) a prefix of exactly one GPU's UUID."""
    exact = next((g for g in gpus if gpu in (g.index, g.uuid)), None)
    if exact or not gpu.startswith("GPU-"):
        return exact
    matches = [g for g in gpus if g.uuid.startswith(gpu)]
    return matches[0] if len(matches) == 1 else None


def pick_gpu(candidates: Sequence[str], gpus: Sequence[GpuMemory], need_gb: float) -> Optional[str]:
    """The candidate with the most free memory, if that is at least `need_gb`; otherwise None."""
    best: Optional[tuple[float, str]] = None
    for gpu in candidates:
        mem = find_gpu(gpus, gpu)
        if mem and mem.free_gb >= need_gb and (best is None or mem.free_gb > best[0]):
            best = (mem.free_gb, gpu)
    return best[1] if best else None
