import { lstat, mkdir, readdir, open, rename, rm, link } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate as yieldNow } from 'node:timers/promises';
import { errorDetail } from './diagnostics.mjs';
import { createNeural } from './neural.mjs';
import { createLocalProposer } from './local-proposer.mjs';
import { createPublicEntityPolicy, publicEntities } from './public-entities.mjs';
import { createOwnerPolicy } from './account-owners.mjs';
import { createDetector } from './detect.mjs';
import { valueText } from './content.mjs';
import { jsonText, emailText } from './formats.mjs';
import { htmlText, xmlText, csvText } from './structured.mjs';
const MAX_TEXT = 32 * 1024 * 1024;
const textTypes = new Set(['.json', '.jsonl', '.eml', '.txt', '.csv', '.html', '.htm', '.md', '.xml', '.log']);
const decode = buffer => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
async function inventory(source, signal) {
  if (!(await lstat(source)).isDirectory() || (await lstat(source)).isSymbolicLink()) throw Error('Invalid export folder.');
  const files = [], directories = [];
  async function walk(relative = '') {
    signal?.throwIfAborted();
    for (const entry of (await readdir(path.join(source, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = path.join(relative, entry.name), info = await lstat(path.join(source, name));
      if (info.isSymbolicLink()) throw Error('Export contains a symbolic link. Protection stopped.');
      if (info.isDirectory()) { directories.push(name); await walk(name); }
      else if (info.isFile()) files.push({ relative: name, size: info.size, inode: info.ino, mtime: info.mtimeMs });
      else throw Error('Export contains an unsupported filesystem entry.');
    }
  }
  await walk(); return { files, directories };
}
async function* blocks(handle, lineMode, signal) {
  let pending = Buffer.alloc(0);
  for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 256 * 1024 })) {
    signal?.throwIfAborted();
    if (!lineMode) { yield chunk; continue; }
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let start = 0, end;
    while ((end = pending.indexOf(10, start)) !== -1) { yield pending.subarray(start, end + 1); start = end + 1; }
    pending = pending.subarray(start);
    if (pending.length > MAX_TEXT) throw Error('A JSONL record exceeds 32 MiB. No protected export was created.');
  }
  if (lineMode && pending.length) yield pending;
}
export async function protectExport({ source, categories, signal, progress = () => {}, modelDirectory, neural: suppliedNeural, log = () => {}, preference = 'auto', namePreference = 'auto', generationMode = 'pools', proposer: suppliedProposer, publicEntityRegistry, accountOwners = [] }) {
  if (!['pools', 'local-model'].includes(generationMode)) throw Error('Unknown replacement generation mode.');
  let queued = [], neural = suppliedNeural, proposer = suppliedProposer;
  const publicPolicy = publicEntityRegistry ? createPublicEntityPolicy(publicEntityRegistry) : publicEntities;
  const ownerPolicy = createOwnerPolicy(accountOwners);
  const detector = createDetector(categories, { namePreference, publicPolicy, ownerPolicy, observe: text => { if (neural) queued.push(text); } });
  source = path.resolve(source);
  const { files, directories } = await inventory(source, signal);
  const output = `${source}-protected-${randomUUID()}`;
  const staging = output + '.partial', mapping = output + '.mapping.json', reportPath = output + '.protection.json';
  const warnings = new Map(), hashes = new Map(), owned = new Set();
  async function privateFile(file, data) {
    const handle = await open(file, 'wx', 0o600); owned.add(file);
    try { await handle.writeFile(data); } finally { await handle.close(); }
  }
  async function publishFile(temporary, final) {
    await link(temporary, final); owned.add(final);
    await rm(temporary); owned.delete(temporary);
  }
  const bytes = files.reduce((sum, file) => sum + file.size, 0);
  log('info', `Protection started: ${files.length} files, ${bytes} bytes, ${categories.join(', ')}.`);
  let stage = 'model setup', currentFile = 0;
  let done = 0, processed = 0, copied = 0, counter = 0;
  const warn = (file, reason) => warnings.set(file + '\0' + reason, { file, reason });
  const update = phase => progress({ phase, engine: neural?.info?.backendLabel, percent: Math.min(99, Math.floor(done / Math.max(1, bytes * 2) * 100)), files: processed, totalFiles: files.length, values: detector.entries.size });
  async function processFile(file, mode) {
    signal?.throwIfAborted();
    currentFile = processed + 1;
    const ext = path.extname(file.relative).toLowerCase();
    const handle = await open(path.join(source, file.relative), constants.O_RDONLY | constants.O_NOFOLLOW);
    let destination;
    try {
      const current = await handle.stat();
      if (!current.isFile() || current.ino !== file.inode || current.size !== file.size || current.mtimeMs !== file.mtime) throw Error('Source files changed. Run protection again.');
      if (mode === 'replace') destination = await open(path.join(staging, file.relative), 'wx', 0o600);
      const supported = textTypes.has(ext) && (ext === '.jsonl' || file.size <= MAX_TEXT);
      if (!supported) warn(file.relative, textTypes.has(ext) ? 'Text file exceeds 32 MiB; copied unchanged' : 'Binary or unsupported file; copied unchanged');
      const hash = createHash('sha256');
      const transform = async buffer => {
        if (!supported) return buffer;
        let text;
        try { text = decode(buffer); } catch { warn(file.relative, 'Non-UTF-8 bytes; copied unchanged'); return buffer; }
        // Retain a UTF-8 BOM outside the format parser.
        const bom = text.startsWith('\uFEFF') ? '\uFEFF' : ''; text = text.slice(bom.length);
        try {
          if (ext === '.json' || ext === '.jsonl') text = jsonText(text, detector, mode, file.relative, reason => warn(file.relative, reason));
          else if (ext === '.eml') text = emailText(text, detector, mode, reason => warn(file.relative, reason));
          else if (ext === '.html' || ext === '.htm') text = htmlText(text, detector, mode, reason => warn(file.relative, reason));
          else if (ext === '.xml') text = xmlText(text, detector, mode, reason => warn(file.relative, reason));
          else if (ext === '.csv') text = csvText(text, detector, mode, reason => warn(file.relative, reason));
          else text = valueText(text, detector, mode, '', file.relative, reason => warn(file.relative, reason));
        } catch (error) {
          if (error instanceof SyntaxError || error.message === 'JSON nesting exceeds 256 levels.') { queued = []; warn(file.relative, 'Invalid or unsupported structured input; copied unchanged'); return buffer; }
          throw error;
        }
        if (mode === 'discover' && neural) {
          if (neural.discoverMany) await neural.discoverMany(queued, detector, () => update('Scanning'));
          else for (const value of queued) { await neural.discover(value, detector, () => update('Scanning')); signal?.throwIfAborted(); update('Scanning'); }
          queued = [];
        }
        return mode === 'discover' ? buffer : Buffer.from(bom + text);
      };
      if (supported && ext !== '.jsonl') {
        const buffer = await handle.readFile(); hash.update(buffer); const outputBytes = await transform(buffer);
        if (destination) await destination.writeFile(outputBytes);
        done += buffer.length; update(mode === 'discover' ? 'Scanning' : 'Copying');
      } else {
        for await (const buffer of blocks(handle, supported && ext === '.jsonl', signal)) {
          hash.update(buffer);
          if (supported && buffer.length > MAX_TEXT) throw Error('A JSONL record exceeds 32 MiB. No protected export was created.');
          const outputBytes = await transform(buffer);
          if (destination) await destination.writeFile(outputBytes);
          done += buffer.length;
          if (++counter % 100 === 0) { update(mode === 'discover' ? 'Scanning' : 'Copying'); await yieldNow(); }
        }
      }
      const digest = hash.digest('hex');
      if (mode === 'discover') hashes.set(file.relative, digest);
      else if (hashes.get(file.relative) !== digest) throw Error('Source files changed. Run protection again.');
    } catch (error) {
      log('error', `${mode === 'discover' ? 'Scanning' : 'Copying'} file ${currentFile}/${files.length} (${ext || 'no extension'}): ${errorDetail(error)}`); throw error;
    } finally { await destination?.close(); await handle.close(); }
    processed++; if (mode === 'replace') copied++;
    update(mode === 'discover' ? 'Scanning' : 'Copying'); await yieldNow();
  }
  try {
    if (modelDirectory) neural = await createNeural({ directory: modelDirectory, categories, signal, log, preference, progress: event => progress({ ...event, files: 0, totalFiles: files.length, values: 0 }) });
    stage = 'scanning'; log('info', 'Model ready. Scanning export content locally.');
    log('info', 'Structure guard: value spans only. Known export metadata, keys, field labels, headers and markup names are excluded from detection and replacement. Unparseable structured content is retained and reported.');
    update('Scanning');
    for (const file of files) await processFile(file, 'discover');
    log('info', `Public-entity policy ${publicPolicy.info.version}: ${publicPolicy.info.aliases} aliases, ${publicPolicy.info.domains} domains, ${detector.publicPolicy.excludedCandidates} detections preserved. No network or extra model calls.`);
    stage = 'mapping'; log('info', `Scan complete: ${detector.entries.size} unique values. Building consistent replacements.`);
    if (generationMode === 'local-model') {
      await neural?.close?.(); // Release detector memory before loading the generator.
      if ([...detector.entries.values()].some(row => ['names','companies'].includes(row.category) && /\p{L}/u.test(row.original))) {
        proposer ||= await createLocalProposer({ directory: modelDirectory && path.join(modelDirectory, 'replacement-runtime'), signal, log, preference: process.env.ACTOUT_REPLACEMENT_BACKEND || 'auto', progress: event => progress({ ...event, files: files.length, totalFiles: files.length, values: detector.entries.size }) });
      }
    }
    await detector.prepare({ proposer: generationMode === 'local-model' ? proposer : undefined, signal, log, progress: ({ completed, total }) => { progress({ phase: `Creating replacements ${completed}/${total}`, percent: 50, files: files.length, totalFiles: files.length, values: detector.entries.size }); } });
    detector.compile();
    log('info', `Identity links: ${detector.generation.identityLinks.explicitEmails} explicit email bindings, ${detector.generation.identityLinks.linkedEmails} linked email replacements, ${detector.generation.identityLinks.ambiguousEmails} ambiguous matches left unlinked.`);
    log('info', `Owner preservation: ${ownerPolicy.info.accounts} verified accounts; names, emails, phones and addresses only. Credentials and private identifiers remain protected. ${ownerPolicy.info.missingProfileScopes.length} accounts lack verified names.`);
    processed = 0; currentFile = 0;
    signal?.throwIfAborted();
    await mkdir(staging, { mode: 0o700 }); owned.add(staging);
    for (const dir of directories) await mkdir(path.join(staging, dir), { mode: 0o700 });
    stage = 'copying'; log('info', `Copying ${files.length} files with protected values and validating file structure.`);
    for (const file of files) await processFile(file, 'replace');
    // Also detect files added or removed while scanning.
    stage = 'source verification';
    const after = await inventory(source, signal);
    if (JSON.stringify(after.files.map(f => [f.relative, f.size, f.mtime, f.inode])) !== JSON.stringify(files.map(f => [f.relative, f.size, f.mtime, f.inode])) || JSON.stringify(after.directories) !== JSON.stringify(directories)) throw Error('Source folder changed. Run protection again.');
    const entries = [...detector.entries.values()];
    const unapplied = entries.filter(entry => !entry.occurrences).length;
    if (unapplied) warn('(detection mapping)', `${unapplied} detected values had no applied replacement. These may overlap larger detections or preserved values; review zero-occurrence mapping entries.`);
    for (const reason of detector.generation.notes) warn('(replacement mapping)', reason);
    const detection = neural ? { ...neural.info, scannedTexts: neural.scanned } : { runtime: 'Fields and patterns only' };
    const generation = { ...detector.generation, mode: generationMode, ...(proposer?.info ? { model: proposer.info } : {}) };
    const result = { detection, generation, structurePolicy: 'value-spans-and-export-contracts-v3', publicEntityPolicy: detector.publicPolicy, ownerPolicy: ownerPolicy.info, status: warnings.size ? 'partial' : 'finished', source, output, mapping, report: reportPath, categories: [...categories], files: copied, values: entries.length, unappliedValues: unapplied, replacements: entries.reduce((sum, entry) => sum + entry.occurrences, 0), reviewItems: warnings.size };
    const limitations = ['Local neural, pattern and field detection can miss personal data or replace non-sensitive text. Contextual model predictions are not gated by keyword or format rules, but the model can still miss or misclassify sensitive values. The pinned model targets English; other languages are not validated. Names and email users are linked through explicit record/header pairs or unique spelling templates; this is not identity verification. Ambiguous aliases and unknown transliterations may remain separate. Verified account-owner contact values are intentionally retained across the whole export; unverified profile details stay protected. Owner preservation does not exempt credentials or private identifiers. Replacement address shapes are synthetic, not validated postal addresses.', 'Filenames, known Slack/Outlook structural record fields (including IDs, timestamps and type discriminators), JSON keys and field-name descriptors, embedded structure keys, text assignment labels, CSV header rows, markup names, namespace declarations, HTML structural attributes/scripts/styles, email routing/identifier metadata, attachment contents and unsupported encodings are retained. Attachment contents are excluded from analysis in this version. These can contain sensitive data. CSV files are assumed to have a header row. XML DTDs are unsupported. Unrecognized structured content, fenced code and ambiguous delimited text are copied unchanged and flagged for review; this preserves schema but can retain sensitive values.', 'Encoded email text may be rewrapped; decoded text outside replacements is preserved. MIME Content-Length is updated when present. Other digests, signatures and external byte counts may no longer match.', 'Recognized public brands, products, institutions and domains are preserved using a versioned local registry, not model guesses. Unknown entities can still be replaced. Explicit personal-name fields and credential values remain sensitive even when they share a public name. Public domain retention includes subdomains and can retain tenant names. No DNS or ownership lookup is performed.', 'Spelling style and gendered naming conventions are approximate and do not establish nationality, gender or ethnicity. Preserved public email domains and phone prefixes retain those attributes; synthetic addresses and phone numbers may coincide with real destinations. Do not send messages or calls to them. Custom email domains use realistic synthetic brands and suffixes; they are not checked for registration. Local-model outputs pass structural checks, not a country or naming-quality benchmark.', 'This is reversible substitution, not encryption or guaranteed anonymization. The mapping contains original sensitive values.'];
    stage = 'publishing';
    await privateFile(mapping + '.partial', JSON.stringify({ version: 3, detection, generation, publicEntityPolicy: detector.publicPolicy, ownerPolicy: ownerPolicy.info, method: 'style-preserving-substitution', sensitive: true, encrypted: false, source, output, categories, entries }, null, 2) + '\n');
    await privateFile(reportPath + '.partial', JSON.stringify({ ...result, limitations, warnings: [...warnings.values()] }, null, 2) + '\n');
    signal?.throwIfAborted();
    await publishFile(mapping + '.partial', mapping); await publishFile(reportPath + '.partial', reportPath);
    const existing = await lstat(output).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
    if (existing) throw Error('Protected destination already exists.');
    await rename(staging, output); owned.delete(staging); owned.add(output);
    progress({ phase: 'Complete', percent: 100, files: copied, totalFiles: files.length, values: entries.length });
    log('info', `Protection complete: ${result.replacements} replacements, ${result.reviewItems} review items.`);
    return result;
  } catch (error) {
    log('error', `Protection ${signal?.aborted ? 'aborted' : 'failed'} during ${stage}, file ${currentFile}/${files.length}: ${errorDetail(error)}`);
    // Only remove the new, uniquely named artifacts owned by this operation.
    await Promise.all([...owned].map(file => rm(file, { recursive: true, force: true }).catch(() => {})));
    throw error;
  } finally { try { await proposer?.close?.(); } finally { await neural?.close?.(); } }
}
