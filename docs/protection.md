# Local data protection

Protection creates a separate export with consistent substitutes for names, companies, emails, phones, addresses, credentials and private identifiers. It is reversible pseudonymization. The mapping contains original values in plaintext; keep it separate from anything you share.

## Pipeline

1. Inventory the source without following symlinks. Record sizes, modification times and content hashes.
2. Parse supported formats and scan text values with field rules, patterns and the local GLiNER model. Preserve keys, structural fields and markup.
3. Review model candidates with a local Qwen3-4B verifier. Suppress a candidate only when both entity-typing and contextual checks return ordinary text. For multiword identity spans, check for an embedded name before rejection. Uncertainty or incomplete output retains protection; explicit field/rule detections remain independent. Apply verified owner and public-entity exceptions. Build shared replacements, including unambiguous name/email relationships.
4. Write to a new staging directory, validate format structure and verify that the source has not changed. Publish the copy, mapping and report only on success. Failure removes only artifacts created by that operation.

JSONL is streamed; an individual record is limited to 32 MiB. Other supported text files are limited to 32 MiB. Supported formats include JSON, JSONL, EML, plain text, CSV, HTML, Markdown, XML and logs. Invalid structures, unknown encodings and unsupported files are retained and reported for review.

## Settings

- Select categories in the Protection step. Verified owner names, emails, phones and addresses remain unchanged; credentials and private identifiers are never exempted as owner data.
- Default replacement pools need no additional replacement model. Optional **Local AI** uses Qwen3 through a managed local llama.cpp runtime. Its first download adds about 1.1 GB.
- Detection uses GLiNER PII Edge v1.0 at threshold `0.4`. The default loads FP32 weights and prefers an available GPU; `ACTOUT_PROTECTION_BACKEND=cpu` selects smaller UINT8 weights on CPU. FP32 keeps 32-bit floating-point weights; UINT8 quantizes weights to 8-bit integers and can change predictions. GPU execution is checked before scanning; GPU failures stop the run.
- Semantic verification uses Qwen3-4B-Instruct-2507 Q4_K_M through the managed llama.cpp runtime. It downloads about 2.5 GB plus runtime assets on first use and adds scanning time. It follows the detection backend preference. Numeric-only and unusually long candidates retain their existing protection; no sample-specific term lists are used.
- `ACTOUT_REPLACEMENT_BACKEND=cpu` selects CPU generation. The default uses a supported local accelerator when available.
- Runtime assets live in Electron's user-data directory under `protection-model/`. Downloads use pinned revisions, size limits and SHA-256 checks. Export content is not sent to a hosted model.

## Review limits

Filenames, structural record IDs/timestamps, JSON keys, CSV headers, routing metadata, markup structure and attachment contents can retain sensitive data. Legacy MIME attachments are preserved without analysis. Known owner contact values and public entities are intentionally retained. Language coverage and spelling-style guesses are limited; replacements may coincide with real names or destinations.

Read the protection report and review both changed and unchanged content. A finished run reports processing completion, not proof that all sensitive information was found. Never use synthetic addresses or phone numbers for contact.

Explicitly labeled numeric authentication codes supplement model detection. Public service labels are preserved only when they combine a reviewed public entity with service words. Unknown organizations remain candidates. Public benchmarks contain synthetic controls committed to the repository; private benchmarks contain reviewed export samples stored locally. Both are regression suites, not unseen estimates of production accuracy.

Model refinement excludes credential labels and known markup fragments, requires nearby credential context for ordinary alphabetic secret candidates, and trims greetings from name spans. Numeric model decisions are unchanged. Email spans are split into mailboxes before owner checks. Explicit secret fields remain protected, including URL-valued tokens. These narrow checks reduce over-selection but do not resolve all ordinary-language or merged-span errors.

## Models and licenses

| Component | Source | License |
| --- | --- | --- |
| Detector | [Knowledgator GLiNER PII Edge](https://huggingface.co/knowledgator/gliner-pii-edge-v1.0) | See the pinned model's license |
| Inference | [ONNX Runtime](https://github.com/microsoft/onnxruntime) | MIT |
| Semantic verifier | [Qwen3-4B-Instruct-2507 GGUF](https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF) | Apache-2.0 |
| Optional generator | [Qwen3-1.7B GGUF](https://huggingface.co/unsloth/Qwen3-1.7B-GGUF) | Apache-2.0 |
| Verifier/generator runtime | [llama.cpp](https://github.com/ggml-org/llama.cpp) | MIT |

Exact detector revisions and checksums live in `src/protection/model-config.mjs`; generator/runtime pins live in `src/protection/generator-assets.mjs`. Model weights and native runtime downloads are not committed. See [benchmark instructions](../benchmarks/README.md) before changing detection behavior.
