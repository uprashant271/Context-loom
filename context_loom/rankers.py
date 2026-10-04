"""Actual Qwen yes/no logit reranking, with optional dependencies loaded lazily.

Reference format: https://huggingface.co/Qwen/Qwen3-Reranker-0.6B
"""
from __future__ import annotations

import json
import threading
from typing import Any, Optional

from .core import TokenCounter


def _literal(text: str) -> str:
    """User data cannot introduce registered chat control tokens into a pair."""
    return json.dumps(text, ensure_ascii=False).replace("<", "\\u003c").replace(">", "\\u003e")


class QwenRanker:
    name = "Qwen/Qwen3-Reranker-0.6B"
    instruction = "Given the active coding task, retrieve conversation evidence needed to continue correctly, including decisions, unresolved work, constraints, identifiers and relevant tool results. Ignore unrelated history."
    prefix = '<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n'
    suffix = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n"

    def __init__(self, model_path: str = "Qwen/Qwen3-Reranker-0.6B", device: str = "auto", batch_size: int = 2,
                 max_length: int = 8192, revision: Optional[str] = None, local_files_only: bool = False):
        if device not in {"auto", "cpu", "mps", "cuda"}:
            raise ValueError("device must be auto, cpu, mps or cuda")
        if not 1 <= batch_size <= 16 or not 128 <= max_length <= 32768:
            raise ValueError("batch_size must be 1..16 and max_length 128..32768")
        self.model_path, self.device_requested = model_path, device
        self.batch_size, self.max_length = batch_size, max_length
        self.revision, self.local_files_only = revision, local_files_only
        self._tokenizer = self._model = self._torch = None
        self._lock = threading.RLock()
        self.device = None

    @property
    def tokenizer(self):
        with self._lock:
            if self._tokenizer is None:
                try:
                    from transformers import AutoTokenizer
                except ImportError as error:
                    raise RuntimeError("Qwen needs the optional torch and transformers dependencies; run the model setup command") from error
                self._tokenizer = AutoTokenizer.from_pretrained(self.model_path, padding_side="left", revision=self.revision,
                                                               local_files_only=self.local_files_only, trust_remote_code=False)
        return self._tokenizer

    @property
    def counter(self):
        return TokenCounter(self.tokenizer, self.name)

    def _load(self):
        with self._lock:
            if self._model is not None:
                return
            try:
                import torch
                from transformers import AutoModelForCausalLM
            except ImportError as error:
                raise RuntimeError("Qwen needs torch and transformers; deterministic fallback is not enabled") from error
            self._torch = torch
            if self.device_requested == "auto":
                self.device = "cuda" if torch.cuda.is_available() else ("mps" if torch.backends.mps.is_available() else "cpu")
            else:
                self.device = self.device_requested
            dtype = torch.float32 if self.device == "cpu" else torch.float16
            self._model = AutoModelForCausalLM.from_pretrained(self.model_path, torch_dtype=dtype, attn_implementation="sdpa",
                                                            revision=self.revision, local_files_only=self.local_files_only,
                                                            trust_remote_code=False, use_safetensors=True).to(self.device).eval()

    def _encode_pair(self, task: str, content: str) -> list[int]:
        tokenizer = self.tokenizer
        pair = "<Instruct>: " + self.instruction + "\n<Query>: " + _literal(task) + "\n<Document>: " + _literal(content)
        ids = tokenizer.encode(self.prefix, add_special_tokens=False) + tokenizer.encode(pair, add_special_tokens=False) + tokenizer.encode(self.suffix, add_special_tokens=False)
        if len(ids) > self.max_length:
            raise ValueError(f"Qwen pair uses {len(ids)} tokens, over max_length={self.max_length}; shorten source chunks explicitly")
        return ids

    def rank(self, task: str, chunks: list[dict]) -> list[float]:
        if not chunks:
            return []
        # Validate every source before model loading/inference. No tokenizer-side
        # truncation may erase exact identifiers or protected evidence.
        encoded = [self._encode_pair(task, chunk["content"]) for chunk in chunks]
        with self._lock:
            self._load()
            torch, tokenizer = self._torch, self.tokenizer
            yes_ids = tokenizer.encode("yes", add_special_tokens=False)
            no_ids = tokenizer.encode("no", add_special_tokens=False)
            if len(yes_ids) != 1 or len(no_ids) != 1:
                raise RuntimeError("Qwen tokenizer does not supply single-token yes/no labels")
            scores = []
            with torch.inference_mode():
                for start in range(0, len(encoded), self.batch_size):
                    batch_ids = encoded[start:start + self.batch_size]
                    tensors = tokenizer.pad({"input_ids": batch_ids, "attention_mask": [[1] * len(ids) for ids in batch_ids]},
                                            padding=True, return_tensors="pt")
                    tensors = {name: tensor.to(self.device) for name, tensor in tensors.items()}
                    logits = self._model(**tensors, logits_to_keep=1).logits[:, -1, :]
                    binary = torch.stack((logits[:, no_ids[0]], logits[:, yes_ids[0]]), dim=1).float()
                    scores.extend(torch.softmax(binary, dim=1)[:, 1].cpu().tolist())
            return scores
