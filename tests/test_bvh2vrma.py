"""scripts/bvh2vrma.mjs: from a BVH in any pose to a VRMA clip in T-pose."""

import json
import math
import shutil
import struct
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "bvh2vrma.mjs"
THREE = ROOT / "frontend" / "node_modules" / "three"

pytestmark = pytest.mark.skipif(
    shutil.which("node") is None or not THREE.is_dir(), reason="servono node e frontend/node_modules"
)


def _skeleton(facing: float) -> str:
    """Skeleton in T-pose; ``facing`` = -1 turns it by 180 degrees (it faces -Z)."""
    s = facing

    def joint(name, x, y, z, body="", end=False):
        tail = "End Site\n{\nOFFSET 0 0 0\n}\n" if end else ""
        return f"JOINT {name}\n{{\nOFFSET {x * s} {y} {z * s}\nCHANNELS 3 Zrotation Xrotation Yrotation\n{body}{tail}}}\n"

    arm = lambda side, sign: joint(  # noqa: E731
        f"{side}Shoulder", 5 * sign, 20, 0,
        joint(f"{side}Arm", 10 * sign, 0, 0, joint(f"{side}ForeArm", 25 * sign, 0, 0, joint(f"{side}Hand", 22 * sign, 0, 0, end=True))),
    )
    leg = lambda side, sign: joint(  # noqa: E731
        f"{side}UpLeg", 9 * sign, 0, 0,
        joint(f"{side}Leg", 0, -42, 0, joint(f"{side}Foot", 0, -40, 0, joint(f"{side}ToeBase", 0, -5, 12, end=True))),
    )
    spine = joint("Spine", 0, 10, 0, joint("Spine1", 0, 12, 0, joint("Neck", 0, 20, 0, joint("Head", 0, 8, 0, end=True)) + arm("Left", 1) + arm("Right", -1)))
    return (
        "HIERARCHY\nROOT Hips\n{\nOFFSET 0 0 0\nCHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation\n"
        + spine + leg("Left", 1) + leg("Right", -1) + "}\n"
    )


def _bvh(facing: float) -> str:
    channels = 6 + 3 * 20  # Hips with position, then 20 joints
    still = [0.0, 90.0, 0.0] + [0.0] * (channels - 3)
    raised = list(still)
    # LeftArm is the ninth joint (Hips 6 channels, then 3 each): Z = -60 degrees raises the arm.
    order = ["Spine", "Spine1", "Neck", "Head", "LeftShoulder", "LeftArm"]
    index = 6 + 3 * order.index("LeftArm")
    raised[index] = 60.0 * facing  # Zrotation: lowered or raised depending on the direction
    frames = [still, raised]
    motion = "MOTION\nFrames: 2\nFrame Time: 0.5\n" + "\n".join(" ".join(str(v) for v in row) for row in frames) + "\n"
    return _skeleton(facing) + motion


def _read_glb(path: Path) -> tuple[dict, bytes]:
    data = path.read_bytes()
    json_length = struct.unpack_from("<I", data, 12)[0]
    document = json.loads(data[20 : 20 + json_length])
    return document, data[20 + json_length + 8 :]


def _rotation(document: dict, binary: bytes, bone: str, frame: int) -> tuple[float, ...]:
    node = document["extensions"]["VRMC_vrm_animation"]["humanoid"]["humanBones"][bone]["node"]
    animation = document["animations"][0]
    channel = next(c for c in animation["channels"] if c["target"]["node"] == node)
    accessor = document["accessors"][animation["samplers"][channel["sampler"]]["output"]]
    view = document["bufferViews"][accessor["bufferView"]]
    return struct.unpack_from("<4f", binary, view["byteOffset"] + frame * 16)


def _convert(tmp_path: Path, facing: float) -> tuple[dict, bytes]:
    source = tmp_path / f"clip{facing}.bvh"
    source.write_text(_bvh(facing), encoding="utf-8")
    target = tmp_path / f"clip{facing}.vrma"
    subprocess.run(["node", str(SCRIPT), str(source), str(target)], check=True, capture_output=True, timeout=60)
    return _read_glb(target)


def test_mixamo_like_skeleton_becomes_a_vrma(tmp_path):
    document, binary = _convert(tmp_path, 1.0)
    bones = document["extensions"]["VRMC_vrm_animation"]["humanoid"]["humanBones"]
    assert {"hips", "spine", "chest", "neck", "head", "leftUpperArm", "rightLowerLeg", "leftToes"} <= set(bones)
    # First frame = T-pose: no rotation.
    assert _rotation(document, binary, "leftUpperArm", 0) == pytest.approx((0, 0, 0, 1), abs=1e-5)
    # Then the left arm turns by 60 degrees around Z.
    x, y, z, w = _rotation(document, binary, "leftUpperArm", 1)
    assert (x, y) == pytest.approx((0, 0), abs=1e-4)
    assert abs(2 * math.degrees(math.atan2(z, w))) == pytest.approx(60, abs=0.5)


def test_an_actor_facing_away_is_turned_towards_the_viewer(tmp_path):
    forward, forward_bin = _convert(tmp_path, 1.0)
    backward, backward_bin = _convert(tmp_path, -1.0)
    for bone in ("leftUpperArm", "spine", "leftLowerLeg"):
        assert _rotation(backward, backward_bin, bone, 1) == pytest.approx(_rotation(forward, forward_bin, bone, 1), abs=1e-4)
