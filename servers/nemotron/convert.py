"""Nemotron-Labs-Diffusion-8B -> a plain Ministral-3 causal LM that stock vLLM serves.

The model card says the AR path (ar_generate) runs the encoder causally and is
"identical to MistralForCausalLM / vLLM". The checkpoint only differs in names:
encoder.* -> model.*, diffusion_head.weight -> lm_head.weight. Sharded so the
rewrite never holds the 17 GB in memory on the unified-memory Spark.
"""
import json, os, shutil, sys
from huggingface_hub import snapshot_download
from safetensors import safe_open
from safetensors.torch import save_file

SRC = "nvidia/Nemotron-Labs-Diffusion-8B"
OUT = sys.argv[1] if len(sys.argv) > 1 else "/out"
SHARD = 2 << 30

src = snapshot_download(SRC, allow_patterns=["*.json", "*.jinja", "model.safetensors"])
print("downloaded ->", src, flush=True)
os.makedirs(OUT, exist_ok=True)

def rename(k):
    if k.startswith("encoder."):
        return "model." + k[len("encoder."):]
    if k == "diffusion_head.weight":
        return "lm_head.weight"
    raise SystemExit(f"unexpected tensor {k}")

index, shard, size, n = {}, {}, 0, 0
def flush():
    global shard, size, n
    if not shard:
        return
    n += 1
    name = f"model-{n:05d}.safetensors"
    save_file(shard, os.path.join(OUT, name), metadata={"format": "pt"})
    for k in shard:
        index[k] = name
    print("wrote", name, len(shard), "tensors", flush=True)
    shard, size = {}, 0

with safe_open(os.path.join(src, "model.safetensors"), "pt") as f:
    for k in f.keys():
        t = f.get_tensor(k)
        shard[rename(k)] = t
        size += t.numel() * t.element_size()
        if size >= SHARD:
            flush()
flush()
json.dump({"metadata": {}, "weight_map": index}, open(os.path.join(OUT, "model.safetensors.index.json"), "w"))

cfg = json.load(open(os.path.join(src, "config.json")))
for k in ("auto_map", "ar_loss_weight", "dlm_loss_weight", "dlm_paradigm", "block_size",
          "mask_token_id", "dp_varying_mask_ratio", "attn_implementation", "use_cache"):
    cfg.pop(k, None)
cfg["architectures"] = ["Ministral3ForCausalLM"]
cfg["model_type"] = "ministral3"
rp = cfg["rope_parameters"]
cfg["llama_4_scaling"] = {"original_max_position_embeddings": rp["original_max_position_embeddings"],
                          "beta": rp["llama_4_scaling_beta"]}
json.dump(cfg, open(os.path.join(OUT, "config.json"), "w"), indent=2)
for fn in ("tokenizer.json", "tokenizer_config.json", "special_tokens_map.json",
           "chat_template.jinja", "generation_config.json"):
    shutil.copy(os.path.join(src, fn), os.path.join(OUT, fn))
print("CONVERT_DONE", len(index), "tensors", flush=True)
