export const MODEL = Object.freeze({
  id: 'knowledgator/gliner-pii-edge-v1.0',
  revision: '9b7f39b0a2da971a5beea78d35f1539d4009c891',
  precision: 'uint8', language: 'English', threshold: 0.4,
  files: [
    { name: 'model.onnx', remote: 'onnx/model_quint8.onnx', sha256: '988acb03456b26e2d9f2521016d820310c2ed64deb4a846297d3289f0c2eb7e4' },
    { name: 'tokenizer.json', remote: 'tokenizer.json', sha256: '84b3a9b18f04a0ccd03b72d9f871b7e0bec40fd7021ef50bc30a7c3693c11205' },
    { name: 'tokenizer_config.json', remote: 'tokenizer_config.json', sha256: '3398f6d1ad4b4c4f9874d390d060a75c58cad5e5ce9b22841b3e40643b4ada27' }
  ]
});
// Floating-point operators can run on GPUs; dynamic UINT8 matrix operations
// in the small CPU asset were keeping the encoder on the CPU.
export const GPU_MODEL = Object.freeze({ ...MODEL, precision: 'float32', files: [
  { name: 'model-fp32.onnx', remote: 'onnx/model.onnx', size: 181078966, sha256: '4ca588722e6d79447ad4c9c230eeba3d9d472c672a9598184a34e9f77fc35836' },
  ...MODEL.files.slice(1)
] });
export const LABELS = Object.freeze({ 'person name': 'names', 'company name': 'companies', email: 'emails', 'phone number': 'phones', address: 'addresses', password: 'secrets', 'API key': 'secrets', 'social security number': 'identifiers', 'credit card number': 'identifiers', 'bank account number': 'identifiers', 'passport number': 'identifiers' });
