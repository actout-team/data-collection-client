// Fixed release assets, verified against upstream SHA-256 digests before execution.
export const RUNTIME_VERSION = 'b11658';
export const RUNTIME_ASSETS = Object.freeze({
  "macos-arm64": {
    "name": "llama-b11658-bin-macos-arm64.tar.gz",
    "url": "https://github.com/ggml-org/llama.cpp/releases/download/b11658/llama-b11658-bin-macos-arm64.tar.gz",
    "size": 12186240,
    "sha256": "13d377faac6ab7f838e9d7ecba5ea9763fa0c5aee03f8186f26a2e03d6c31e60"
  },
  "macos-x64": {
    "name": "llama-b11658-bin-macos-x64.tar.gz",
    "url": "https://github.com/ggml-org/llama.cpp/releases/download/b11658/llama-b11658-bin-macos-x64.tar.gz",
    "size": 11668061,
    "sha256": "b22d9e9caecdf601e95ac6f6cc0b7e14f11fc1cbea1123b60463b0cec4362ca6"
  },
  "ubuntu-x64": {
    "name": "llama-b11658-bin-ubuntu-x64.tar.gz",
    "url": "https://github.com/ggml-org/llama.cpp/releases/download/b11658/llama-b11658-bin-ubuntu-x64.tar.gz",
    "size": 17838436,
    "sha256": "457c7145ecdf7d9cf575b4c7357ab8cf6eed3943576b3e9955b02bd7488e7174"
  },
  "ubuntu-arm64": {
    "name": "llama-b11658-bin-ubuntu-arm64.tar.gz",
    "url": "https://github.com/ggml-org/llama.cpp/releases/download/b11658/llama-b11658-bin-ubuntu-arm64.tar.gz",
    "size": 13888762,
    "sha256": "a58d72c36da12b98a02476927e8f19b6e293743e04586d406f6782f848f93bd6"
  },
  "ubuntu-cuda-12.8-x64": {
    "name": "llama-b11658-bin-ubuntu-cuda-12.8-x64.tar.gz",
    "url": "https://github.com/ggml-org/llama.cpp/releases/download/b11658/llama-b11658-bin-ubuntu-cuda-12.8-x64.tar.gz",
    "size": 172517016,
    "sha256": "87eff1306d59864e4328f5fe7dda1a78a5fde3211fba5688e8ebcd427e831e81"
  },
  "win-cpu-x64": {
    "name": "llama-b11658-bin-win-cpu-x64.zip",
    "url": "https://github.com/ggml-org/llama.cpp/releases/download/b11658/llama-b11658-bin-win-cpu-x64.zip",
    "size": 19529765,
    "sha256": "d1216a024c0888de8082366ca768dafac5f883c51fd190235156c95481fd925a"
  },
  "win-cpu-arm64": {
    "name": "llama-b11658-bin-win-cpu-arm64.zip",
    "url": "https://github.com/ggml-org/llama.cpp/releases/download/b11658/llama-b11658-bin-win-cpu-arm64.zip",
    "size": 12435210,
    "sha256": "9d3fec002cad42c740ddab4c397901c0328ad1b12e0a2bcfc4afb397f4acace1"
  },
  "win-cuda-12.4-x64": {
    "name": "llama-b11658-bin-win-cuda-12.4-x64.zip",
    "url": "https://github.com/ggml-org/llama.cpp/releases/download/b11658/llama-b11658-bin-win-cuda-12.4-x64.zip",
    "size": 266574670,
    "sha256": "4268543cfffee11e62dbe1fb4ee907da508c2a70de7b845ed7b338bf8cabd76d"
  },
  "cuda-linux": {
    "name": "cudart-llama-b11658-bin-ubuntu-cuda-12.8-x64.tar.gz",
    "url": "https://github.com/ggml-org/llama.cpp/releases/download/b11658/cudart-llama-b11658-bin-ubuntu-cuda-12.8-x64.tar.gz",
    "size": 594377586,
    "sha256": "0727f896043c6a47dfa9860a083d1ebba1bc7cca7fa4ba7ec8776bf23a6ff444"
  },
  "cuda-windows": {
    "name": "cudart-llama-bin-win-cuda-12.4-x64.zip",
    "url": "https://github.com/ggml-org/llama.cpp/releases/download/b11658/cudart-llama-bin-win-cuda-12.4-x64.zip",
    "size": 391443627,
    "sha256": "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6"
  }
});
export const GENERATOR_MODEL = Object.freeze({
  id: 'unsloth/Qwen3-1.7B-GGUF', revision: 'd7f544eead698dbd1f15126ef60b45a1e1933222',
  name: 'Qwen3-1.7B-Q4_K_M.gguf', size: 1107409472,
  sha256: 'b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897',
  url: 'https://huggingface.co/unsloth/Qwen3-1.7B-GGUF/resolve/d7f544eead698dbd1f15126ef60b45a1e1933222/Qwen3-1.7B-Q4_K_M.gguf'
});

export const VERIFIER_MODEL = Object.freeze({
  id: 'unsloth/Qwen3-4B-Instruct-2507-GGUF', revision: 'a06e946bb6b655725eafa393f4a9745d460374c9',
  name: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf', size: 2497281120,
  sha256: '3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597',
  url: 'https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/a06e946bb6b655725eafa393f4a9745d460374c9/Qwen3-4B-Instruct-2507-Q4_K_M.gguf'
});

