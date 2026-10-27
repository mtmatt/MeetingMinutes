from mm_worker.gpus import GpuMemory, find_gpu, parse_gpus, pick_gpu

# The admin page that prompted GPU selection: four 4090s, GPU 1 mostly taken by another program.
SMI = """\
0, GPU-aaaa, NVIDIA GeForce RTX 4090, 24564, 819
1, GPU-bbbb, NVIDIA GeForce RTX 4090, 24564, 18534
2, GPU-cccc, NVIDIA GeForce RTX 4090, 24564, 12000
3, GPU-dddd, NVIDIA GeForce RTX 4090, 24564, 3686
"""


def test_parse_nvidia_smi_csv():
    gpus = parse_gpus(SMI)
    assert [g.index for g in gpus] == ["0", "1", "2", "3"]
    assert gpus[1].name == "NVIDIA GeForce RTX 4090" and gpus[1].uuid == "GPU-bbbb"
    assert round(gpus[1].total_gb, 1) == 24.0 and round(gpus[1].free_gb, 1) == 5.9


def test_gpus_are_found_by_index_or_uuid():
    gpus = parse_gpus(SMI)
    assert find_gpu(gpus, "2").index == "2"
    assert find_gpu(gpus, "GPU-dddd").index == "3"
    assert find_gpu(gpus, "7") is None


def test_gpus_are_found_by_a_unique_uuid_prefix():
    gpus = parse_gpus(SMI.replace("GPU-aaaa", "GPU-8932f937-1111").replace("GPU-bbbb", "GPU-8932aaaa-2222"))
    assert find_gpu(gpus, "GPU-8932f937").index == "0"
    assert pick_gpu(["GPU-8932f937"], gpus, 8.0) == "GPU-8932f937"
    # A prefix of two GPUs' UUIDs is ambiguous, so neither is used.
    assert find_gpu(gpus, "GPU-8932") is None


def test_pick_the_gpu_with_the_most_free_memory():
    gpus = parse_gpus(SMI)
    assert pick_gpu(["0", "1", "2", "3"], gpus, 8.0) == "0"
    # Only idle GPUs are candidates; GPU 1 is never chosen with 5.9 GB free.
    assert pick_gpu(["1", "2", "3"], gpus, 8.0) == "3"
    assert pick_gpu(["1", "2"], gpus, 8.0) == "2"


def test_no_gpu_when_none_has_enough_free():
    gpus = parse_gpus(SMI)
    assert pick_gpu(["1"], gpus, 8.0) is None
    assert pick_gpu(["0", "3"], gpus, 24.0) is None
    # A GPU nvidia-smi does not list is not used.
    assert pick_gpu(["7"], gpus, 0.0) is None
    assert pick_gpu([], gpus, 0.0) is None


def test_free_memory_exactly_at_the_threshold_is_enough():
    gpus = [GpuMemory("0", "GPU-a", "x", 24.0, 8.0)]
    assert pick_gpu(["0"], gpus, 8.0) == "0"
