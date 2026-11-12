#!/usr/bin/env python3
"""静态校验一份 API 格式工作流模板，对着运行中的 ComfyUI 的 object_info 检查。

不需要显存、不提交任务。检查四件事：
  1. 每个 class_type 在服务端存在
  2. 每个节点的必需输入都有（字面量或连线）
  3. 每条连线的源节点存在、输出槽位不越界
  4. 模板里不该出现的运行时槽位（ref_*）确实为空

用法：python validate-template.py [模板路径] [--base=http://127.0.0.1:8188]
"""
import json
import sys
import urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:8188"
HERE = Path(__file__).resolve().parent


def obj_info(cls, base=BASE):
    with urllib.request.urlopen(f"{base}/object_info/{cls}", timeout=20) as r:
        return json.load(r)[cls]


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    tpl = Path(args[0]) if args else HERE / "minimax_h3_ref2va.api.json"
    base = BASE
    for a in sys.argv[1:]:
        if a.startswith("--base="):
            base = a.split("=", 1)[1]

    wf = json.loads(tpl.read_text(encoding="utf-8"))
    errors, warnings, cache = [], [], {}

    def info(cls):
        if cls not in cache:
            try:
                cache[cls] = obj_info(cls, base)
            except Exception as exc:  # noqa: BLE001
                cache[cls] = None
                errors.append(f"[{cls}] 不是服务端已知的节点类（{exc}）")
        return cache[cls]

    for nid, node in wf.items():
        cls = node.get("class_type")
        if not cls:
            errors.append(f"[{nid}] 缺 class_type")
            continue
        meta = info(cls)
        if meta is None:
            continue

        declared = {}
        for sect in ("required", "optional"):
            for k, v in (meta.get("input", {}).get(sect) or {}).items():
                declared[k] = (sect, v)

        inputs = node.get("inputs") or {}
        for name, spec in declared.items():
            if spec[0] != "required":
                continue
            if name in inputs or any(k.startswith(name + ".") for k in inputs):
                continue
            t = spec[1][0]
            extra = spec[1][1] or {}
            if t in ("COMFY_AUTOGROW_V3",) or "template" in extra or "lazy" in extra:
                continue
            errors.append(f"[{nid}:{cls}] 缺必需输入 {name}")

        for name, val in inputs.items():
            if not (isinstance(val, list) and len(val) == 2 and isinstance(val[0], str) and isinstance(val[1], int)):
                continue
            src, slot = val
            if src not in wf:
                errors.append(f"[{nid}:{cls}] 输入 {name} 连到不存在的节点 {src}")
                continue
            src_meta = info(wf[src]["class_type"])
            if src_meta is None:
                continue
            outs = src_meta.get("output") or []
            if slot < 0 or slot >= len(outs):
                errors.append(f"[{nid}:{cls}] 输入 {name} 取 {src} 的第 {slot} 个输出，但它是 {len(outs)} 个输出")

        for k in {n.split(".")[0] for n in inputs}:
            if k not in declared:
                warnings.append(f"[{nid}:{cls}] 输入 {k} 不在该节点的声明里（可能被忽略）")

    ref = wf.get("136", {}).get("inputs", {})
    leftovers = [k for k in ref if k.startswith(("ref_images.", "ref_videos.", "ref_audios.", "ref_video_audios."))]
    if leftovers:
        errors.append(f"模板残留运行时槽位：{leftovers}")
    if not isinstance(ref.get("prompt"), str):
        errors.append("136.prompt 必须是字符串字面量")

    print(f"模板: {tpl.name}  节点数: {len(wf)}  类数: {len({n['class_type'] for n in wf.values()})}")
    for w in warnings:
        print("  warn :", w)
    for e in errors:
        print("  ERROR:", e)
    if not errors:
        print("  OK: 类存在、必需输入齐备、连线合法、参考位为空")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
